// Native Tern drawing for the composer. Tern's whiteboard is a canvas block (kind `canvas`): the
// user's own tools, ink, shapes and text. A TSP program cannot call `cx.whiteboard` (window Lua only),
// but the installed Tern accepts `ctl canvas …` for the same block, so opening is a control call.
// The drawing leaves Tern as pixels: `ctl shot` writes the whole window, `ctl dump` gives the canvas
// pane's box, and png-crop keeps only that pane so unrelated panes never reach the model.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { cropPng, pngSize } from "./png-crop.ts";
import { canvasStateDir, readCanvasDoc, renderCanvasDoc } from "./canvas-doc.ts";

export const DRAWING_ACTION = "drawing.attach";
/** The preview row's primary control: capture and attach, the drawing's one send path. */
export const DRAWING_SEND = "drawing.send";
/** The preview row's quiet control: hide until the canvas changes again. */
export const DRAWING_DISCARD = "drawing.discard";

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
	/** Tern's canvas document store; defaults to the XDG state directory the app writes. */
	stateDir?: string;
	now?: () => number;
}

export type DrawingResult =
	| { status: "opened"; pane?: number; owner?: CanvasOwner }
	| { status: "empty"; pane: number; owner?: CanvasOwner }
	| { status: "attached"; path: string; width: number; height: number; shapes: number; source: "screen" | "document"; textOmitted?: boolean; owner?: CanvasOwner };

type CanvasBlock = { id: number; shapes?: number; focused?: boolean; phase?: string; camera?: { x?: number; y?: number; zoom?: number }; canvas?: string };

/**
 * Which canvas this Pi instance opened. The pane id is how ctl names it locally, the canvas hash is how
 * the document is stored; the hash survives a window reload, so it is the primary key. With ten tabs
 * open there is always exactly one focused canvas and nine others, and "the focused one" is not ours.
 */
export interface CanvasOwner {
	/** `ctl state`'s `canvas_blocks[].id`; the pane that hosts the canvas. */
	pane: number;
	/** The block's `canvas` (`canvas:<hash>`), or "" when Tern did not report one. */
	canvas: string;
}

/**
 * The change signature a live preview re-captures on: which canvas, how much ink, and where the camera
 * sits. A settled canvas keys the same, so polling it costs one `ctl state` and never a screenshot.
 */
export function previewKey(canvas: CanvasBlock | undefined): string | undefined {
	if (!canvas || !Number.isInteger(canvas.id)) return undefined;
	return `${canvas.id}:${canvas.shapes ?? 0}:${canvas.camera?.x ?? 0}:${canvas.camera?.y ?? 0}:${canvas.camera?.zoom ?? 1}`;
}

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

/** The owner record for a block ctl reported. */
export function ownerOf(block: CanvasBlock | undefined): CanvasOwner | undefined {
	if (!block || !Number.isInteger(block.id)) return undefined;
	return { pane: block.id, canvas: typeof block.canvas === "string" ? block.canvas : "" };
}

/**
 * The block this instance owns, matched by canvas hash first (stable across reloads and focus changes)
 * and by pane id only when the hash was never reported. Never falls back to another canvas: an owner
 * whose canvas is gone means the user closed it, not that the nearest open one will do.
 */
export function resolveOwned(state: any, owner: CanvasOwner | undefined): CanvasBlock | undefined {
	if (!owner) return undefined;
	const blocks: CanvasBlock[] = Array.isArray(state?.canvas_blocks)
		? state.canvas_blocks.filter((c: any) => Number.isInteger(c?.id))
		: [];
	if (owner.canvas) {
		const byHash = blocks.find((block) => block.canvas === owner.canvas);
		if (byHash) return byHash;
	}
	return owner.canvas ? undefined : blocks.find((block) => block.id === owner.pane);
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
	const before = new Set<string>((Array.isArray(beforeState?.canvas_blocks) ? beforeState.canvas_blocks : []).map((c: any) => String(c?.canvas ?? `id:${c?.id}`)));
	const answer = await deps.ctl(["canvas", "new"]);
	if (answer?.ok !== true) throw new Error(`Tern could not open a canvas: ${answer?.error ?? "unknown error"}`);
	const deadline = Date.now() + OPEN_TIMEOUT_MS;
	while (Date.now() < deadline) {
		await sleep(POLL_MS);
		const state = await deps.ctl(["state"]);
		const fresh = (state?.canvas_blocks ?? []).filter((c: any) => Number.isInteger(c?.id) && !before.has(String(c?.canvas ?? `id:${c?.id}`)));
		// `canvas new` focuses what it creates; another pane creating one at the same moment is the only
		// way two appear, so the focused one is ours and the rest are not adopted.
		const created = fresh.find((c: any) => c.focused === true) ?? (fresh.length === 1 ? fresh[0] : undefined);
		if (created) return { status: "opened", pane: Number(created.id), owner: ownerOf(created) };
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

interface PaneShot {
	/** File name the shot was taken under, reused when a crop is written to artifacts. */
	name: string;
	bytes: Buffer;
	width: number;
	height: number;
}

/**
 * The screenshot-free capture: render the canvas document Tern persists under its state directory.
 * Tern writes it within seconds of a stroke, and `ctl state` names it (`canvas:<hash>`). A document
 * that is older than the state's shape count is treated as not ready, so the next poll retries
 * instead of rendering a stale frame.
 */
async function captureFromDocument(deps: DrawingDeps, canvas: CanvasBlock, attempts = 3): Promise<{ rendered: NonNullable<ReturnType<typeof renderCanvasDoc>> } | undefined> {
	for (let attempt = 0; attempt < attempts; attempt++) {
		const doc = readCanvasDoc(canvas, deps.stateDir ?? canvasStateDir());
		if (doc && doc.shapes!.length >= Number(canvas.shapes ?? 0)) {
			const rendered = renderCanvasDoc(doc);
			if (rendered) return { rendered };
		}
		if (attempt < attempts - 1) await sleep(250);
	}
	return undefined;
}

/**
 * The canvas pane's cropped pixels: `ctl shot` of the whole window, cropped to the pane box `ctl dump`
 * reports. With `focus` it first brings the canvas forward so the dump's `.on` box is the right one;
 * without it the shot is passive, for the live preview that must never steal the user's focus.
 */
async function shootCanvasPane(deps: DrawingDeps, canvas: CanvasBlock, opts: { focus: boolean; roots: readonly string[] }): Promise<PaneShot> {
	if (opts.focus) await deps.focus(canvas.id);
	const name = `pi-drawing-${(deps.now ?? Date.now)().toString(36)}`;
	const shot = await deps.ctl(["shot", name]);
	if (shot?.ok !== true || typeof shot.png !== "string") throw new Error(`Tern could not capture the drawing: ${shot?.error ?? "no PNG in the reply"}`);
	const file = await firstExisting(shotCandidates(shot.png, opts.roots));
	if (!file) throw new Error(`Tern wrote ${shot.png}, but it was not found under ${opts.roots.join(", ")}`);
	const dump = await deps.ctl(["dump", "section.tn-pane.canvas"]);
	if (dump?.ok !== true) throw new Error(`Tern could not report the canvas box: ${dump?.error ?? "unknown error"}`);
	const box = canvasRect(dump);
	const size = pngSize(file.bytes);
	const cssWidth = Number(dump.header?.viewport?.width ?? size.width);
	const scale = cssWidth > 0 ? size.width / cssWidth : 1;
	const cropped = cropPng(file.bytes, { x: box.x * scale, y: box.y * scale, w: box.w * scale, h: box.h * scale });
	const croppedSize = pngSize(cropped);
	return { name, bytes: cropped, width: croppedSize.width, height: croppedSize.height };
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
	const roots = drawingRoots(deps, state);
	let pane: PaneShot;
	let source: "screen" | "document" = "screen";
	let textOmitted = false;
	try {
		pane = await shootCanvasPane(deps, target, { focus: true, roots });
	} catch (error) {
		// `ctl shot` needs the Tern process's cwd to be writable (a window started from `/` cannot
		// write target/shots/…). The persisted document needs no shot at all.
		const fallback = await captureFromDocument(deps, target);
		if (!fallback?.rendered) throw error;
		pane = { name: `pi-drawing-${(deps.now ?? Date.now)().toString(36)}`, bytes: fallback.rendered.bytes, width: fallback.rendered.width, height: fallback.rendered.height };
		source = "document";
		textOmitted = fallback.rendered.textOmitted;
	}
	const dir = join(deps.workspace, "artifacts", "tern-drawings");
	await mkdir(dir, { recursive: true });
	const path = join(dir, `${pane.name}.png`);
	await writeFile(path, pane.bytes);
	return { status: "attached", path, width: pane.width, height: pane.height, shapes, source, ...(source === "document" && textOmitted ? { textOmitted } : {}), owner: ownerOf(target) };
}

export type PreviewResult =
	| { ok: false; reason: string }
	| { ok: true; bytes: Buffer; width: number; height: number; shapes: number; pane: number; source: "screen" | "document" };

/**
 * The focused canvas as cropped pixels for the composer's live preview. Unlike a capture it never
 * steals focus, and a pane box that cannot be named (several canvases, none focused) is skipped rather
 * than thrown: the preview keeps its last good frame and the next poll retries.
 */
export async function capturePreview(deps: DrawingDeps, canvas: CanvasBlock): Promise<PreviewResult> {
	// A passive shot photographs whichever canvas pane is focused and crops the box `dump` reports for
	// it. When our pane is not the focused one that is someone else's drawing, so the hash-addressed
	// document is the only safe source; a focused canvas may still use the pixel-honest screenshot.
	if (canvas.focused !== true) {
		const fallback = await captureFromDocument(deps, canvas);
		if (!fallback?.rendered) return { ok: false, reason: "the canvas is not focused and its document is not ready yet" };
		return { ok: true, bytes: fallback.rendered.bytes, width: fallback.rendered.width, height: fallback.rendered.height, shapes: Number(canvas.shapes ?? 0), pane: canvas.id, source: "document" };
	}
	try {
		const state = await deps.ctl(["state"]);
		const pane = await shootCanvasPane(deps, canvas, { focus: false, roots: drawingRoots(deps, state) });
		return { ok: true, bytes: pane.bytes, width: pane.width, height: pane.height, shapes: Number(canvas.shapes ?? 0), pane: canvas.id, source: "screen" };
	} catch (error) {
		const fallback = await captureFromDocument(deps, canvas);
		if (!fallback?.rendered) return { ok: false, reason: error instanceof Error ? error.message : String(error) };
		return { ok: true, bytes: fallback.rendered.bytes, width: fallback.rendered.width, height: fallback.rendered.height, shapes: Number(canvas.shapes ?? 0), pane: canvas.id, source: "document" };
	}
}

/**
 * One command, two steps, so the + button and `/drawing` behave the same: with no canvas it opens
 * one; with a drawing it attaches it; with an empty canvas it brings that canvas forward.
 */
export async function drawingAction(deps: DrawingDeps, owner?: CanvasOwner): Promise<DrawingResult> {
	const state = await deps.ctl(["state"]);
	if (!canvasControlAvailable(state)) throw new Error("This Tern build has no canvas blocks; drawing needs the desktop Tern app");
	// Only the canvas this instance opened. Opening a second whiteboard because another tab happens to
	// have one is exactly the bug this ownership record exists to prevent.
	const canvas = resolveOwned(state, owner);
	if (!canvas) return openCanvas(deps);
	if (Number(canvas.shapes ?? 0) < 1) {
		await deps.focus(canvas.id);
		return { status: "empty", pane: canvas.id, owner: ownerOf(canvas) };
	}
	return captureCanvas(deps, canvas);
}
