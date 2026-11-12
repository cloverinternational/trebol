// The whiteboard's persisted document, and a pure-Node rasterizer for it.
//
// `ctl shot` needs the Tern process's working directory to be writable; a window launched from `/`
// cannot write `target/shots/tern/live`, so the screenshot path dies with a permission error. Tern
// writes every canvas to `<state>/tern/canvases/<canvas hash>/canvas.json` within a few seconds of a
// change, and `ctl state` names that hash (`canvas:<hash>`). Rendering the document is therefore a
// capture path that needs no shot at all — the fallback behind a failed screenshot.
//
// Format 2 (verified against Tern 0.9.13): `{format, meta:{look,paper}, shapes:[…]}` with
// `ink` (points as x,y,pressure triples relative to the shape's x,y), `geo` (form/w/h/stroke) and
// `text` (text/w/h/style). Ink and geo rasterize faithfully; a text shape draws its box only, since
// there is no font rasterizer here and inventing glyphs would misrepresent the drawing.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { encodePng } from "./png-crop.ts";

export interface CanvasShape {
	id?: string;
	type?: string;
	x?: number;
	y?: number;
	props?: {
		points?: number[];
		color?: string;
		size?: number;
		form?: string;
		w?: number;
		h?: number;
		stroke?: { color?: string; width?: number };
		text?: string;
		style?: { color?: string; size?: number };
	} & Record<string, unknown>;
}

export interface CanvasDoc {
	format?: number;
	meta?: { look?: string; paper?: string } & Record<string, unknown>;
	shapes?: CanvasShape[];
}

export interface RenderedCanvas {
	bytes: Buffer;
	width: number;
	height: number;
	shapes: number;
	/** True when any text shape had to be drawn as its box alone. */
	textOmitted: boolean;
}

/** Where Tern keeps canvas documents (XDG state, like the app itself). */
export function canvasStateDir(env: NodeJS.ProcessEnv = process.env): string {
	const base = env.XDG_STATE_HOME && env.XDG_STATE_HOME.length > 0 ? env.XDG_STATE_HOME : join(homedir(), ".local", "state");
	return join(base, "tern", "canvases");
}

/**
 * The persisted document for a canvas block, or undefined when it is not on disk yet (or the id is
 * not one of Tern's hashes). Never throws: a missing or half-written file is simply not ready.
 */
export function readCanvasDoc(canvas: { canvas?: unknown }, stateDir: string = canvasStateDir()): CanvasDoc | undefined {
	const hash = typeof canvas.canvas === "string" ? canvas.canvas.replace(/^canvas:/, "") : "";
	if (!/^[0-9a-f]{16,64}$/.test(hash)) return undefined;
	try {
		const doc = JSON.parse(readFileSync(join(stateDir, hash, "canvas.json"), "utf8")) as CanvasDoc;
		return Array.isArray(doc?.shapes) ? doc : undefined;
	} catch {
		return undefined;
	}
}

export interface Box { x: number; y: number; w: number; h: number }

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const inkWidth = (shape: CanvasShape): number => (finite(shape.props?.size) && shape.props.size > 0 ? shape.props.size : 4);

/** The union of every shape's ink, padded, in document coordinates; undefined when nothing is drawable. */
export function canvasDocBounds(doc: CanvasDoc, pad = 12): Box | undefined {
	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
	const grow = (x: number, y: number, w = 0, h = 0): void => {
		if (!finite(x) || !finite(y)) return;
		minX = Math.min(minX, x); minY = Math.min(minY, y);
		maxX = Math.max(maxX, x + Math.max(0, w)); maxY = Math.max(maxY, y + Math.max(0, h));
	};
	for (const shape of doc.shapes ?? []) {
		const x = finite(shape.x) ? shape.x : 0;
		const y = finite(shape.y) ? shape.y : 0;
		if (shape.type === "ink") {
			const points = shape.props?.points ?? [];
			const r = inkWidth(shape) / 2;
			for (let i = 0; i + 1 < points.length; i += 3) grow(x + (points[i] ?? 0) - r, y + (points[i + 1] ?? 0) - r, r * 2, r * 2);
		} else if (shape.type === "geo") {
			const w = finite(shape.props?.w) ? shape.props.w : 0;
			const h = finite(shape.props?.h) ? shape.props.h : 0;
			const stroke = finite(shape.props?.stroke?.width) ? (shape.props.stroke?.width as number) : 2;
			grow(x - stroke / 2, y - stroke / 2, w + stroke, h + stroke);
		} else if (shape.type === "text") {
			grow(x, y, finite(shape.props?.w) ? (shape.props.w as number) : 0, finite(shape.props?.h) ? (shape.props.h as number) : 0);
		}
	}
	if (!Number.isFinite(minX)) return undefined;
	return { x: minX - pad, y: minY - pad, w: maxX - minX + pad * 2, h: maxY - minY + pad * 2 };
}

const INK = [24, 24, 24, 255] as const;
const PAPER = [255, 255, 255, 255] as const;
const TEXT_BOX = [150, 150, 150, 255] as const;

/**
 * Rasterizes the document to an opaque PNG. Ink strokes are stamped as discs along each segment at
 * 2× and box-downsampled, which gives round caps and clean edges without a font or image library.
 * The image is scaled to fit `maxSide` (never up), so a canvas far from the origin keeps its scale.
 */
export function renderCanvasDoc(doc: CanvasDoc, options: { maxSide?: number; padding?: number } = {}): RenderedCanvas | undefined {
	const bounds = canvasDocBounds(doc, options.padding ?? 12);
	if (!bounds || bounds.w < 1 || bounds.h < 1) return undefined;
	const maxSide = options.maxSide ?? 1400;
	const scale = Math.min(1, maxSide / Math.max(bounds.w, bounds.h));
	const width = Math.max(1, Math.round(bounds.w * scale));
	const height = Math.max(1, Math.round(bounds.h * scale));
	const ss = 2; // supersample factor
	const w = width * ss, h = height * ss;
	const rgba = Buffer.alloc(w * h * 4);
	for (let i = 0; i < rgba.length; i += 4) { rgba[i] = PAPER[0]; rgba[i + 1] = PAPER[1]; rgba[i + 2] = PAPER[2]; rgba[i + 3] = PAPER[3]; }
	const px = (x: number, y: number): number => ((y | 0) * w + (x | 0)) * 4;
	const disc = (cx: number, cy: number, r: number, color: readonly [number, number, number, number]): void => {
		const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(w - 1, Math.ceil(cx + r));
		const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(h - 1, Math.ceil(cy + r));
		const r2 = r * r;
		for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
			const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
			if (dx * dx + dy * dy > r2) continue;
			const i = px(x, y);
			rgba[i] = color[0]; rgba[i + 1] = color[1]; rgba[i + 2] = color[2]; rgba[i + 3] = color[3];
		}
	};
	const tx = (x: number): number => (x - bounds.x) * scale * ss;
	const ty = (y: number): number => (y - bounds.y) * scale * ss;
	let textOmitted = false;

	for (const shape of doc.shapes ?? []) {
		const ox = finite(shape.x) ? shape.x : 0;
		const oy = finite(shape.y) ? shape.y : 0;
		if (shape.type === "ink") {
			const points = shape.props?.points ?? [];
			const r = Math.max(0.7, (inkWidth(shape) * scale * ss) / 2);
			let lastX: number | undefined, lastY: number | undefined;
			for (let i = 0; i + 1 < points.length; i += 3) {
				const x = tx(ox + (points[i] ?? 0)), y = ty(oy + (points[i + 1] ?? 0));
				if (lastX !== undefined && lastY !== undefined) {
					const dx = x - lastX, dy = y - lastY;
					const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / Math.max(0.5, r / 1.5)));
					for (let s = 1; s <= steps; s++) disc(lastX + (dx * s) / steps, lastY + (dy * s) / steps, r, INK);
				} else disc(x, y, r, INK);
				lastX = x; lastY = y;
			}
		} else if (shape.type === "geo") {
			const gw = finite(shape.props?.w) ? (shape.props.w as number) : 0;
			const gh = finite(shape.props?.h) ? (shape.props.h as number) : 0;
			const sw = Math.max(1, (finite(shape.props?.stroke?.width) ? (shape.props.stroke?.width as number) : 2) * scale * ss);
			const x0 = tx(ox), y0 = ty(oy), x1 = tx(ox + gw), y1 = ty(oy + gh);
			const form = shape.props?.form;
			if (form === "ellipse") {
				const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, rx = Math.abs(x1 - x0) / 2, ry = Math.abs(y1 - y0) / 2;
				const steps = Math.max(32, Math.ceil((rx + ry) / 2));
				for (let s = 0; s <= steps; s++) {
					const a = (Math.PI * 2 * s) / steps;
					disc(cx + Math.cos(a) * rx, cy + Math.sin(a) * ry, sw / 2, INK);
				}
			} else {
				const stepsX = Math.max(1, Math.ceil(Math.abs(x1 - x0) / Math.max(0.5, sw / 2)));
				const stepsY = Math.max(1, Math.ceil(Math.abs(y1 - y0) / Math.max(0.5, sw / 2)));
				for (let s = 0; s <= stepsX; s++) { disc(x0 + ((x1 - x0) * s) / stepsX, y0, sw / 2, INK); disc(x0 + ((x1 - x0) * s) / stepsX, y1, sw / 2, INK); }
				for (let s = 0; s <= stepsY; s++) { disc(x0, y0 + ((y1 - y0) * s) / stepsY, sw / 2, INK); disc(x1, y0 + ((y1 - y0) * s) / stepsY, sw / 2, INK); }
			}
		} else if (shape.type === "text") {
			// No font rasterizer here: mark the label's box rather than invent glyphs.
			textOmitted = true;
			const tw = finite(shape.props?.w) ? (shape.props.w as number) : 0;
			const th = finite(shape.props?.h) ? (shape.props.h as number) : 0;
			const x0 = tx(ox), y0 = ty(oy), x1 = tx(ox + tw), y1 = ty(oy + th);
			const stepsX = Math.max(1, Math.ceil(Math.abs(x1 - x0)));
			const stepsY = Math.max(1, Math.ceil(Math.abs(y1 - y0)));
			for (let s = 0; s <= stepsX; s++) { disc(x0 + ((x1 - x0) * s) / stepsX, y0, 0.6, TEXT_BOX); disc(x0 + ((x1 - x0) * s) / stepsX, y1, 0.6, TEXT_BOX); }
			for (let s = 0; s <= stepsY; s++) { disc(x0, y0 + ((y1 - y0) * s) / stepsY, 0.6, TEXT_BOX); disc(x1, y0 + ((y1 - y0) * s) / stepsY, 0.6, TEXT_BOX); }
		}
	}

	// Box-downsample the supersampled image; alpha stays opaque.
	const out = Buffer.alloc(width * height * 4);
	for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
		let r = 0, g = 0, b = 0;
		for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) {
			const i = px(x * ss + sx, y * ss + sy);
			r += rgba[i]!; g += rgba[i + 1]!; b += rgba[i + 2]!;
		}
		const n = ss * ss;
		const o = (y * width + x) * 4;
		out[o] = Math.round(r / n); out[o + 1] = Math.round(g / n); out[o + 2] = Math.round(b / n); out[o + 3] = 255;
	}
	return { bytes: encodePng({ width, height, rgba: out }), width, height, shapes: (doc.shapes ?? []).length, textOmitted };
}
