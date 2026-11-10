// Native Tern drawing for the composer. Tern's whiteboard is a canvas block (kind `canvas`): the
// user's own tools, ink, shapes and text. A TSP program cannot call `cx.whiteboard` (window Lua only),
// but the installed Tern accepts `ctl canvas …` for the same block, so opening is a control call.
// The drawing leaves Tern as pixels: `ctl shot` writes the whole window, `ctl dump` gives the canvas
// pane's box, and png-crop keeps only that pane so unrelated panes never reach the model.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { cropPng, pngSize } from "./png-crop.ts";

export const DRAWING_ACTION = "drawing.attach";

/** `tern ctl ARGS`, parsed. Injected so the bridge stays testable outside a Tern pane. */
export type DrawingCtl = (args: string[]) => Promise<any>;

export interface DrawingDeps {
	ctl: DrawingCtl;
	/** Runs `tern focus <pane>` so an existing empty canvas comes forward instead of adding another. */
	focus: (pane: number) => Promise<void>;
	/** Where the cropped PNG is written. */
	workspace: string;
	/** Directories the app may have resolved `ctl shot`'s relative path against, most likely first. */
	roots?: readonly string[];
	now?: () => number;
}

export type DrawingResult =
	| { status: "opened"; pane?: number }
	| { status: "empty"; pane: number }
	| { status: "attached"; path: string; width: number; height: number; shapes: number };

type CanvasBlock = { id: number; shapes?: number; focused?: boolean; phase?: string };

const OPEN_TIMEOUT_MS = 5000;
const POLL_MS = 100;

const sleep = (ms: number) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

/** The canvas the next action should use: the focused one, else the first, never an invented id. */
export function pickCanvas(state: any): CanvasBlock | undefined {
	const canvases: CanvasBlock[] = Array.isArray(state?.canvas_blocks)
		? state.canvas_blocks.filter((c: any) => Number.isInteger(c?.id))
		: [];
	return canvases.find((c) => c.focused === true) ?? canvases[0];
}

/** True when this Tern build exposes the canvas control family. */
export function canvasControlAvailable(state: any): boolean {
	return Array.isArray(state?.canvas_blocks);
}

/**
 * Opens a native whiteboard beside the focused pane. The control command returns no pane id, so the
 * new id is the one absent from the snapshot before the call; the bounded poll never guesses.
 */
export async function openCanvas(deps: DrawingDeps): Promise<DrawingResult> {
	const beforeState = await deps.ctl(["state"]);
	const before = new Set<number>(
		(Array.isArray(beforeState?.canvas_blocks) ? beforeState.canvas_blocks : [])
			.map((c: any) => Number(c?.id))
			.filter(Number.isInteger),
	);
	const answer = await deps.ctl(["canvas", "new"]);
	if (answer?.ok !== true) throw new Error(`Tern could not open a canvas: ${answer?.error ?? "unknown error"}`);
	const deadline = Date.now() + OPEN_TIMEOUT_MS;
	while (Date.now() < deadline) {
		await sleep(POLL_MS);
		const state = await deps.ctl(["state"]);
		const created = (state?.canvas_blocks ?? []).find((c: any) => Number.isInteger(c?.id) && !before.has(Number(c.id)));
		if (created) return { status: "opened", pane: Number(created.id) };
	}
	return { status: "opened" };
}

/** `ctl shot` names a file under the app's own cwd; try each plausible root and its ancestors. */
export function shotCandidates(relative: string, roots: readonly string[]): string[] {
	if (isAbsolute(relative)) return [relative];
	const out: string[] = [];
	const seen = new Set<string>();
	for (const root of roots) {
		let dir = resolve(root);
		for (let depth = 0; depth < 5; depth++) {
			const candidate = join(dir, relative);
			if (!seen.has(candidate)) {
				seen.add(candidate);
				out.push(candidate);
			}
			const parent = dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}
	}
	return out;
}

async function firstExisting(candidates: readonly string[]): Promise<{ path: string; bytes: Buffer } | undefined> {
	for (const candidate of candidates) {
		try {
			return { path: candidate, bytes: await readFile(candidate) };
		} catch {
			// Try the next root; only ENOENT is expected here.
		}
	}
	return undefined;
}

/** The visible canvas pane's box from `ctl dump`, preferring the focused one. */
export function canvasRect(dump: any): { x: number; y: number; w: number; h: number } {
	const elements: any[] = Array.isArray(dump?.elements) ? dump.elements : [];
	const panes = elements.filter((e) => typeof e?.path === "string" && /section\.tn-pane\.canvas\b/.test(e.path) && e.visible !== false && Array.isArray(e.rect) && e.rect[2] > 0 && e.rect[3] > 0);
	// Tern puts the focus class among the pane's class tokens in any order (`… canvas multi on`), so
	// match the token rather than a fixed `.canvas.on` adjacency.
	const chosen = panes.find((e) => e.path.split(".").includes("on")) ?? (panes.length === 1 ? panes[0] : undefined);
	if (!chosen) {
		throw new Error(panes.length > 1 ? "Several canvases are open; focus the one to attach, then run /drawing" : "Tern did not report a visible canvas pane");
	}
	const [x, y, w, h] = chosen.rect;
	return { x, y, w, h };
}

function drawingRoots(deps: DrawingDeps, state: any): string[] {
	const roots = [...(deps.roots ?? []), process.cwd(), homedir(), state?.focused?.cwd].filter((root): root is string => typeof root === "string" && root.length > 0);
	return [...new Set(roots)];
}

/**
 * Captures the focused canvas as a cropped PNG. An empty canvas is refused before taking a
 * screenshot: attaching a blank page would look like a successful drawing.
 */
export async function captureCanvas(deps: DrawingDeps, canvas?: CanvasBlock): Promise<DrawingResult> {
	const state = await deps.ctl(["state"]);
	if (!canvasControlAvailable(state)) throw new Error("This Tern build has no canvas blocks; drawing needs the desktop Tern app");
	const target = canvas ?? pickCanvas(state);
	if (!target) throw new Error("No canvas is open; run /drawing to open one");
	const shapes = Number(target.shapes ?? 0);
	if (shapes < 1) return { status: "empty", pane: target.id };
	// `ctl dump` marks the focused pane `.on`; focus the canvas being captured so its box is the one chosen.
	await deps.focus(target.id);
	const name = `pi-drawing-${(deps.now ?? Date.now)().toString(36)}`;
	const shot = await deps.ctl(["shot", name]);
	if (shot?.ok !== true || typeof shot.png !== "string") throw new Error(`Tern could not capture the drawing: ${shot?.error ?? "no PNG in the reply"}`);
	const roots = drawingRoots(deps, state);
	const file = await firstExisting(shotCandidates(shot.png, roots));
	if (!file) throw new Error(`Tern wrote ${shot.png}, but it was not found under ${roots.join(", ")}`);
	const dump = await deps.ctl(["dump", "section.tn-pane.canvas"]);
	if (dump?.ok !== true) throw new Error(`Tern could not report the canvas box: ${dump?.error ?? "unknown error"}`);
	const box = canvasRect(dump);
	const size = pngSize(file.bytes);
	const cssWidth = Number(dump.header?.viewport?.width ?? size.width);
	const scale = cssWidth > 0 ? size.width / cssWidth : 1;
	const cropped = cropPng(file.bytes, { x: box.x * scale, y: box.y * scale, w: box.w * scale, h: box.h * scale });
	const dir = join(deps.workspace, "artifacts", "tern-drawings");
	await mkdir(dir, { recursive: true });
	const path = join(dir, `${name}.png`);
	await writeFile(path, cropped);
	const croppedSize = pngSize(cropped);
	return { status: "attached", path, width: croppedSize.width, height: croppedSize.height, shapes };
}

/**
 * One command, two steps, so the + button and `/drawing` behave the same: with no canvas it opens
 * one; with a drawing it attaches it; with an empty canvas it brings that canvas forward.
 */
export async function drawingAction(deps: DrawingDeps): Promise<DrawingResult> {
	const state = await deps.ctl(["state"]);
	if (!canvasControlAvailable(state)) throw new Error("This Tern build has no canvas blocks; drawing needs the desktop Tern app");
	const canvas = pickCanvas(state);
	if (!canvas) return openCanvas(deps);
	if (Number(canvas.shapes ?? 0) < 1) {
		await deps.focus(canvas.id);
		return { status: "empty", pane: canvas.id };
	}
	return captureCanvas(deps, canvas);
}
