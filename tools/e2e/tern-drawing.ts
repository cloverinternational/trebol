// Live end-to-end check for Tern's native whiteboard path. Run inside a Tern pane:
//   node --experimental-strip-types tools/e2e/tern-drawing.ts
// It opens its own canvas, draws one stroke through the control command, captures only that pane,
// asserts the PNG has the pane's size and actual ink, then closes the canvas it created.
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { captureCanvas } from "../../.pi/lib/tern/drawing.ts";
import { decodePng, pngSize } from "../../.pi/lib/tern/png-crop.ts";

const run = promisify(execFile);
const ctl = async (args: string[]) => JSON.parse((await run("tern", ["ctl", ...args], { timeout: 60_000, maxBuffer: 64 * 1024 * 1024 })).stdout);

if (!process.env.TERN_PANE) {
	console.log("skip: TERN_PANE is not set (this harness needs a live Tern window)");
	process.exit(0);
}

const before = new Set<number>((await ctl(["state"])).canvas_blocks?.map((c: any) => c.id) ?? []);
const opened = await ctl(["canvas", "new"]);
if (opened.ok !== true) throw new Error(`canvas new failed: ${opened.error}`);
const state = await ctl(["state"]);
const pane = state.canvas_blocks?.find((c: any) => !before.has(c.id));
if (!pane) throw new Error("canvas new returned ok but no canvas appeared");

try {
	await ctl(["canvas", "tool", "draw"]);
	const stroke = await ctl(["canvas", "draw", "40,40", "120,60", "200,150", "260,90"]);
	if (stroke.ok !== true) throw new Error(`canvas draw failed: ${stroke.error}`);
	const drawn = await ctl(["state"]);
	const counted = drawn.canvas_blocks?.find((c: any) => c.id === pane.id);
	if (!counted || counted.shapes < 1) throw new Error("the stroke did not become a shape");

	const result = await captureCanvas({
		ctl,
		focus: async (id) => { await run("tern", ["focus", String(id)], { timeout: 30_000 }); },
		workspace: process.cwd(),
		roots: [process.cwd()],
	}, counted);
	if (result.status !== "attached") throw new Error(`expected an attachment, got ${result.status}`);
	const image = decodePng(await readFile(result.path));
	if (image.width !== result.width || image.height !== result.height) throw new Error("capture and PNG disagree on size");
	let ink = 0;
	for (let i = 0; i < image.rgba.length; i += 4) {
		if (image.rgba[i]! + image.rgba[i + 1]! + image.rgba[i + 2]! < 300) ink++;
	}
	if (ink === 0) throw new Error("the cropped PNG is blank: the capture is not the drawing");
	console.log(`ok: ${pngSize(await readFile(result.path)).width}x${pngSize(await readFile(result.path)).height}, ${ink} ink pixels, ${result.shapes} shape(s), ${result.path}`);
} finally {
	await run("tern", ["close", String(pane.id), "--json"], { timeout: 30_000 }).catch(() => {});
}
