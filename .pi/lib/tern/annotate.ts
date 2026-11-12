// Annotating a picture the agent presented: a screenshot, a rendered mock, an SVG.
//
// TSP has no pointer coordinates — an action names a node, never a position — and it has no absolute
// layout in a node's own props. What it does have is a program stylesheet that can address any node by
// `data-id`, and `position: absolute`. So the picture is wrapped in a stage whose aspect ratio matches the
// image, a grid of click targets tiles it, and every mark is placed by a CSS rule generated from the mark's
// normalized position. A click names its cell, which is a coordinate; arrow keys nudge the crosshair by one
// percent; Enter drops a pin where the crosshair stands.
//
// The marks travel twice: as text (x%, y%, note) and, for PNGs, burned into a copy of the picture as
// numbered discs. That is the point of the round trip — the agent gets the pixels it can see and the
// coordinates it can act on, so "not here" is a location, not a mood.
import { decodePng, encodePng, pngSize, type PngImage } from "./png-crop.ts";
import type { TspNode } from "./tsp.ts";

/** Click targets across the picture. 16×9 keeps the grid under 150 nodes and a cell near 6% of the width. */
export const ANNOTATE_COLS = 16;
export const ANNOTATE_ROWS = 9;

export const ANNOTATE_CELL = "annotate.cell";
export const ANNOTATE_PIN = "annotate.pin";
export const ANNOTATE_ADD = "annotate.add";
export const ANNOTATE_REMOVE = "annotate.remove";
export const ANNOTATE_SEND = "annotate.send";
export const ANNOTATE_CANCEL = "annotate.cancel";

export const ANNOTATE_STAGE_ID = "annotate-stage";
export const ANNOTATE_IMAGE_ID = "annotate-image";
export const ANNOTATE_CURSOR_ID = "annotate-cursor";
export const ANNOTATE_NOTE_ID = "annotate-note";

export interface AnnotateMark {
	/** 1-based, and the number drawn on the picture. */
	n: number;
	/** Normalized 0..1 from the picture's top-left corner. */
	x: number;
	y: number;
	note: string;
}

export interface AnnotateSource {
	name: string;
	path: string;
	mime: string;
	width: number;
	height: number;
	/** PNG is the only format this machine can decode; other kinds still get marks, just no overlay copy. */
	decodable: boolean;
}

export interface AnnotateSession {
	/** Tern blob id of the picture as presented, so the stage draws the same bytes the marks describe. */
	blob: string;
	source: AnnotateSource;
	marks: AnnotateMark[];
	cursor: { x: number; y: number };
	selected?: number;
	note: string;
	noteCursor?: number;
	noteFocused: boolean;
}

const clamp01 = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value);

/** Cell centre in normalized coordinates. */
export function cellPoint(row: number, col: number): { x: number; y: number } {
	return { x: (col + 0.5) / ANNOTATE_COLS, y: (row + 0.5) / ANNOTATE_ROWS };
}

export function cellNodeId(row: number, col: number): string {
	return `annotate-cell-${row}-${col}`;
}

export function pinNodeId(n: number): string {
	return `annotate-pin-${n}`;
}

/** The cell a clicked node id names, or undefined for anything else. */
export function cellFromNodeId(id: unknown): { row: number; col: number } | undefined {
	if (typeof id !== "string") return undefined;
	const match = /^annotate-cell-(\d+)-(\d+)$/.exec(id);
	if (!match) return undefined;
	const row = Number(match[1]);
	const col = Number(match[2]);
	if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || row >= ANNOTATE_ROWS || col < 0 || col >= ANNOTATE_COLS) return undefined;
	return { row, col };
}

/** The pin number a clicked node id names, or undefined. */
export function pinFromNodeId(id: unknown): number | undefined {
	if (typeof id !== "string") return undefined;
	const match = /^annotate-pin-(\d+)$/.exec(id);
	if (!match) return undefined;
	const n = Number(match[1]);
	return Number.isInteger(n) && n >= 1 ? n : undefined;
}

/** A picture's declared size, for formats this module cannot decode. */
function declaredSize(bytes: Buffer, mime: string): { width: number; height: number } | undefined {
	if (mime === "image/png") {
		try {
			return pngSize(bytes);
		} catch {
			return undefined;
		}
	}
	if (mime === "image/svg+xml") {
		const head = bytes.toString("utf8", 0, Math.min(bytes.length, 4096));
		const width = /<svg[^>]*\bwidth="(\d+(?:\.\d+)?)(?:px)?"/i.exec(head)?.[1];
		const height = /<svg[^>]*\bheight="(\d+(?:\.\d+)?)(?:px)?"/i.exec(head)?.[1];
		if (width && height) return { width: Math.round(Number(width)), height: Math.round(Number(height)) };
		const box = /viewBox="\s*-?[\d.]+[ ,]+-?[\d.]+[ ,]+([\d.]+)[ ,]+([\d.]+)/i.exec(head);
		if (box) return { width: Math.round(Number(box[1])), height: Math.round(Number(box[2])) };
	}
	return undefined;
}

/** Builds the session for one shown picture. Size falls back to 16:9 when the format does not say. */
export function annotateSession(blob: string, name: string, path: string, mime: string, bytes: Buffer): AnnotateSession {
	const size = declaredSize(bytes, mime) ?? { width: 1600, height: 900 };
	return {
		blob,
		source: { name, path, mime, width: size.width, height: size.height, decodable: mime === "image/png" },
		marks: [],
		cursor: { x: 0.5, y: 0.5 },
		note: "",
		noteFocused: false,
	};
}

/** The pin a node id names, if it is one of this stage's. */
export function selectedPin(session: AnnotateSession, id: unknown): AnnotateMark | undefined {
	const n = pinFromNodeId(id);
	return n === undefined ? undefined : session.marks.find((mark) => mark.n === n);
}

export function addMark(session: AnnotateSession): AnnotateMark {
	const n = session.marks.reduce((max, mark) => Math.max(max, mark.n), 0) + 1;
	const mark: AnnotateMark = { n, x: session.cursor.x, y: session.cursor.y, note: "" };
	session.marks = [...session.marks, mark];
	session.selected = n;
	session.note = "";
	session.noteCursor = 0;
	return mark;
}

/** Removes the selected pin, renumbering later ones so the numbers on the picture stay 1..n. */
export function removeSelected(session: AnnotateSession): boolean {
	const n = session.selected;
	if (n === undefined) return false;
	session.marks = session.marks
		.filter((mark) => mark.n !== n)
		.map((mark) => (mark.n > n ? { ...mark, n: mark.n - 1 } : mark));
	session.selected = session.marks.length === 0 ? undefined : Math.min(n, session.marks.length);
	const next = session.marks.find((mark) => mark.n === session.selected);
	session.note = next?.note ?? "";
	session.noteCursor = session.note.length;
	return true;
}

export function selectPin(session: AnnotateSession, n: number): boolean {
	const mark = session.marks.find((entry) => entry.n === n);
	if (!mark) return false;
	session.selected = n;
	session.note = mark.note;
	session.noteCursor = mark.note.length;
	return true;
}

/** Applies a TSP native-edit event to the note, keeping the caret where Tern put it. */
export function editNote(session: AnnotateSession, from: number, to: number, text: string, cursor?: number): boolean {
	const mark = session.marks.find((entry) => entry.n === session.selected);
	if (!mark) return false;
	const start = Math.max(0, Math.min(session.note.length, Math.round(from)));
	const end = Math.max(start, Math.min(session.note.length, Math.round(to)));
	session.note = session.note.slice(0, start) + text + session.note.slice(end);
	session.noteCursor = typeof cursor === "number" ? Math.max(0, Math.min(session.note.length, cursor)) : start + text.length;
	mark.note = session.note;
	return true;
}

/** One percent per key: the grid places, the keyboard refines. */
export function nudgeCursor(session: AnnotateSession, dx: number, dy: number): void {
	session.cursor = { x: clamp01(Math.round((session.cursor.x + dx) * 100) / 100), y: clamp01(Math.round((session.cursor.y + dy) * 100) / 100) };
}

const percent = (value: number): string => `${(value * 100).toFixed(2)}%`;

/**
 * What the agent reads: where the marked copy is, numbered locations, the notes, and the exact
 * normalized coordinates. The copy's path is in the text on purpose — an attached image can fail to
 * reach the model (no vision, a dropped blob), and the file is still readable at that path.
 */
export function annotatePayload(session: AnnotateSession, annotated?: string): string {
	const { source, marks } = session;
	const lines = [`Annotated ${source.name} (${source.width}×${source.height}). Marks are x%,y% from its top-left corner.`];
	if (annotated) lines.push(`Saved copy: ${annotated}`);
	for (const mark of marks) {
		const note = mark.note.trim();
		lines.push(`${mark.n}. ${(mark.x * 100).toFixed(1)}%, ${(mark.y * 100).toFixed(1)}%${note ? ` — ${note}` : ""}`);
	}
	const data = {
		source: source.name,
		path: source.path,
		width: source.width,
		height: source.height,
		...(annotated ? { annotated } : {}),
		marks: marks.map((mark) => ({ n: mark.n, x: Number(mark.x.toFixed(4)), y: Number(mark.y.toFixed(4)), note: mark.note })),
	};
	lines.push("```json", JSON.stringify(data), "```");
	return lines.join("\n");
}

// 3×5 digits: enough to number the marks on the picture without a font rasterizer.
const GLYPHS: Readonly<Record<string, readonly string[]>> = {
	"0": ["111", "101", "101", "101", "111"],
	"1": ["010", "110", "010", "010", "111"],
	"2": ["111", "001", "111", "100", "111"],
	"3": ["111", "001", "111", "001", "111"],
	"4": ["101", "101", "111", "001", "001"],
	"5": ["111", "100", "111", "001", "111"],
	"6": ["111", "100", "111", "101", "111"],
	"7": ["111", "001", "001", "001", "001"],
	"8": ["111", "101", "111", "101", "111"],
	"9": ["111", "101", "111", "001", "111"],
};

function fillDisc(image: PngImage, cx: number, cy: number, radius: number, color: readonly [number, number, number]): void {
	const r2 = radius * radius;
	for (let y = Math.max(0, Math.floor(cy - radius)); y <= Math.min(image.height - 1, Math.ceil(cy + radius)); y++) {
		for (let x = Math.max(0, Math.floor(cx - radius)); x <= Math.min(image.width - 1, Math.ceil(cx + radius)); x++) {
			const dx = x + 0.5 - cx;
			const dy = y + 0.5 - cy;
			if (dx * dx + dy * dy > r2) continue;
			const i = (y * image.width + x) * 4;
			image.rgba[i] = color[0];
			image.rgba[i + 1] = color[1];
			image.rgba[i + 2] = color[2];
			image.rgba[i + 3] = 255;
		}
	}
}

function drawNumber(image: PngImage, cx: number, cy: number, label: string, scale: number, color: readonly [number, number, number]): void {
	const glyphW = 3 * scale;
	const gap = scale;
	const total = label.length * glyphW + (label.length - 1) * gap;
	let x0 = Math.round(cx - total / 2);
	const y0 = Math.round(cy - (5 * scale) / 2);
	for (const char of label) {
		const glyph = GLYPHS[char];
		if (glyph) {
			for (let gy = 0; gy < 5; gy++) {
				for (let gx = 0; gx < 3; gx++) {
					if (glyph[gy][gx] !== "1") continue;
					for (let sy = 0; sy < scale; sy++) {
						for (let sx = 0; sx < scale; sx++) {
							const x = x0 + gx * scale + sx;
							const y = y0 + gy * scale + sy;
							if (x < 0 || y < 0 || x >= image.width || y >= image.height) continue;
							const i = (y * image.width + x) * 4;
							image.rgba[i] = color[0];
							image.rgba[i + 1] = color[1];
							image.rgba[i + 2] = color[2];
							image.rgba[i + 3] = 255;
						}
					}
				}
			}
		}
		x0 += glyphW + gap;
	}
}

/**
 * A copy of the picture with every mark burned in: a white halo, a dark disc, the number. The notes stay in
 * the payload. Returns undefined when the bytes are not a PNG this machine can decode, which the caller
 * reports instead of attaching a picture that does not show the marks.
 */
export function annotatePng(bytes: Buffer, marks: readonly AnnotateMark[]): Buffer | undefined {
	let image: PngImage;
	try {
		image = decodePng(bytes);
	} catch {
		return undefined;
	}
	const radius = Math.max(10, Math.min(26, Math.round(Math.min(image.width, image.height) / 28)));
	const scale = radius >= 18 ? 2 : 1;
	for (const mark of marks) {
		const cx = Math.round(mark.x * image.width);
		const cy = Math.round(mark.y * image.height);
		fillDisc(image, cx, cy, radius + 2, [255, 255, 255]);
		fillDisc(image, cx, cy, radius, [24, 24, 24]);
		drawNumber(image, cx, cy, String(mark.n), scale, [255, 255, 255]);
	}
	return encodePng(image);
}

/** The rules that place the stage, its grid, and every mark. Regenerated whenever a mark or the cursor moves. */
export function annotateSheet(session: AnnotateSession): string {
	const ratio = session.source.height / Math.max(1, session.source.width);
	const rows = Array.from({ length: ANNOTATE_ROWS }, (_, row) => `[data-id="annotate-row-${row}"]{position:absolute;left:0;top:${percent(row / ANNOTATE_ROWS)};width:100%;height:${percent(1 / ANNOTATE_ROWS)};display:flex;z-index:2}`).join("");
	const pins = session.marks
		.map((mark) => `[data-id="${pinNodeId(mark.n)}"]{left:${percent(mark.x)};top:${percent(mark.y)}${session.selected === mark.n ? ";outline:2px solid var(--accent)" : ""}}`)
		.join("");
	return [
		`[data-id="${ANNOTATE_STAGE_ID}"]{position:relative;width:100%;padding-top:${(ratio * 100).toFixed(3)}%;overflow:hidden;border-radius:8px;background:var(--l1)}`,
		`[data-id="${ANNOTATE_IMAGE_ID}"]{position:absolute;left:0;top:0;width:100%;height:100%;object-fit:fill;border-radius:0}`,
		"[data-id^=\"annotate-cell-\"]{flex:1;min-width:0}",
		rows,
		"[data-id^=\"annotate-pin-\"]{position:absolute;transform:translate(-50%,-50%);width:18px;height:18px;border-radius:9px;background:var(--accent);color:#fff;display:flex;align-items:center;justify-content:center;font-size:11px;line-height:1;z-index:3;box-shadow:0 0 0 2px #fff}",
		pins,
		`[data-id="${ANNOTATE_CURSOR_ID}"]{position:absolute;left:${percent(session.cursor.x)};top:${percent(session.cursor.y)};transform:translate(-50%,-50%);width:16px;height:16px;border-radius:8px;border:2px solid var(--accent);box-shadow:0 0 0 2px rgba(0,0,0,0.35);z-index:4}`,
	].join("");
}

const actionButton = (id: string, label: string, act: string, tone: string, title: string, disabled = false): TspNode => ({
	id,
	k: "text",
	p: {
		role: "pi.annotate.action",
		wrap: "none",
		tone,
		title,
		...(disabled ? { tone: "muted" as const } : { actions: { click: act } }),
		spans: [{ t: label, s: disabled ? "dim" : tone }],
	},
});

/** The card that replaces the composer while a picture is being marked up. */
export function annotateNodes(session: AnnotateSession): TspNode[] {
	const cells: TspNode[] = [];
	for (let row = 0; row < ANNOTATE_ROWS; row++) {
		cells.push({
			id: `annotate-row-${row}`,
			k: "el",
			p: { tag: "div", class: "annot-row" },
			c: Array.from({ length: ANNOTATE_COLS }, (_, col) => ({ id: cellNodeId(row, col), k: "el" as const, p: { tag: "div" as const, role: "pi.annotate.cell", actions: { click: ANNOTATE_CELL } } })),
		});
	}
	const marks = session.marks.map((mark) => ({
		id: pinNodeId(mark.n),
		k: "el" as const,
		p: { tag: "div" as const, role: "pi.annotate.pin", text: String(mark.n), title: mark.note || `mark ${mark.n}`, actions: { click: ANNOTATE_PIN } },
	}));
	const stage: TspNode = {
		id: ANNOTATE_STAGE_ID,
		k: "el",
		p: { tag: "div", role: "pi.annotate.stage", title: "Click to place the crosshair; arrows nudge it" },
		c: [
			{ id: ANNOTATE_IMAGE_ID, k: "image", p: { blob: session.blob, alt: session.source.name, role: "pi.annotate.image" } },
			...cells,
			...marks,
			{ id: ANNOTATE_CURSOR_ID, k: "el", p: { tag: "div", role: "pi.annotate.cursor" } },
		],
	};
	const where = `${(session.cursor.x * 100).toFixed(0)}%, ${(session.cursor.y * 100).toFixed(0)}%`;
	const hint: TspNode = {
		id: "annotate-hint",
		k: "text",
		p: { role: "pi.annotate.hint", tone: "muted", wrap: "word", text: `Crosshair ${where} · click or arrow keys to place · Enter pins · Tab selects · ⌫ removes` },
	};
	const note: TspNode = {
		id: ANNOTATE_NOTE_ID,
		k: "editor",
		p: {
			role: "pi.annotate.note",
			text: session.note,
			...(session.noteCursor !== undefined ? { cursor: session.noteCursor } : {}),
			placeholder: session.selected === undefined ? "Select a pin to say what is wrong with that spot" : `What is wrong at mark ${session.selected}?`,
			maxLines: 3,
			grow: 1,
		},
	};
	const controls: TspNode = {
		id: "annotate-controls",
		k: "row",
		p: { role: "pi.annotate.controls", gap: "md", align: "center" },
		c: [
			actionButton("annotate-add", "Pin here", ANNOTATE_ADD, "accent", "Drop a pin at the crosshair"),
			actionButton("annotate-remove", "Remove", ANNOTATE_REMOVE, "muted", "Remove the selected pin", session.selected === undefined),
			{ id: "annotate-space", k: "spacer", p: { grow: 1 } },
			actionButton("annotate-cancel", "Discard", ANNOTATE_CANCEL, "muted", "Close without sending"),
			actionButton("annotate-send", session.marks.length === 0 ? "Send" : `Send ${session.marks.length} mark${session.marks.length === 1 ? "" : "s"}`, ANNOTATE_SEND, "accent", "Attach the marked picture and its coordinates to the composer", session.marks.length === 0),
		],
	};
	return [{
		id: "annotate-card",
		k: "card",
		p: { head: `Annotate ${session.source.name}`, role: "pi.annotate", tone: "accent" },
		c: [stage, note, hint, controls],
	}];
}
