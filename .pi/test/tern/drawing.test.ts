import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canvasRect, captureCanvas, drawingAction, pickCanvas, shotCandidates } from "../../lib/tern/drawing.ts";
import { cropPng, decodePng, encodePng, pngSize } from "../../lib/tern/png-crop.ts";

// A deterministic opaque image: R is x, G is y, B is 7.
function fixture(width: number, height: number): Buffer {
	const rgba = Buffer.alloc(width * height * 4);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const i = (y * width + x) * 4;
			rgba[i] = x & 0xff;
			rgba[i + 1] = y & 0xff;
			rgba[i + 2] = 7;
			rgba[i + 3] = 255;
		}
	}
	return encodePng({ width, height, rgba });
}

describe("PNG crop", () => {
	it("round-trips RGBA and keeps the cropped pixels exactly", () => {
		const source = fixture(12, 9);
		const cropped = cropPng(source, { x: 3, y: 2, w: 5, h: 4 });
		expect(pngSize(cropped)).toEqual({ width: 5, height: 4 });
		const image = decodePng(cropped);
		expect([...image.rgba.subarray(0, 4)]).toEqual([3, 2, 7, 255]);
		expect([...image.rgba.subarray((3 * 5 + 4) * 4, (3 * 5 + 4) * 4 + 4)]).toEqual([7, 5, 7, 255]);
	});

	it("clamps a rectangle to the image instead of reading out of bounds", () => {
		const cropped = cropPng(fixture(6, 6), { x: 4.4, y: 4.6, w: 9, h: 9 });
		expect(pngSize(cropped)).toEqual({ width: 2, height: 1 });
	});
});

describe("native canvas control", () => {
	it("prefers the focused canvas and never invents one", () => {
		expect(pickCanvas({ canvas_blocks: [{ id: 1, shapes: 0 }, { id: 2, shapes: 3, focused: true }] })).toMatchObject({ id: 2 });
		expect(pickCanvas({ canvas_blocks: [] })).toBeUndefined();
		expect(pickCanvas({})).toBeUndefined();
	});

	it("tries the app's plausible roots, nearest first", () => {
		const [first] = shotCandidates("target/shots/tern/live/x.png", ["/home/me/work"]);
		expect(first).toBe("/home/me/work/target/shots/tern/live/x.png");
		expect(shotCandidates("/tmp/x.png", ["/a"])).toEqual(["/tmp/x.png"]);
	});

	it("uses the focused canvas pane box and refuses an ambiguous one", () => {
		const dump = {
			elements: [
				{ path: "main>section.tn-pane.canvas.off", visible: true, rect: [0, 0, 10, 10] },
				{ path: "main>section.tn-pane.canvas.on", visible: true, rect: [20, 30, 40, 50] },
			],
		};
		expect(canvasRect(dump)).toEqual({ x: 20, y: 30, w: 40, h: 50 });
		expect(() => canvasRect({ elements: dump.elements.map((e) => ({ ...e, path: e.path.replace(".on", "").replace(".off", "") })) }))
			.toThrow(/Several canvases/);
	});

	it("opens a canvas when none exists, and focuses an empty one instead of adding another", async () => {
		const calls: string[][] = [];
		let opened = false;
		const ctl = async (args: string[]) => {
			calls.push(args);
			if (args[0] === "canvas") { opened = true; return { ok: true }; }
			if (args[0] === "shot") return { ok: true, png: "target/shots/tern/live/x.png" };
			if (args[0] === "dump") return { ok: true, elements: [{ path: "section.tn-pane.canvas.on", visible: true, rect: [0, 0, 10, 10] }], header: { viewport: { width: 10 } } };
			return { ok: true, canvas_blocks: opened ? [{ id: 9, shapes: 0 }] : [] };
		};
		const focused: number[] = [];
		const deps = { ctl, focus: async (pane: number) => { focused.push(pane); }, workspace: "/tmp", roots: ["/tmp"], now: () => 1 };
		expect(await drawingAction(deps)).toEqual({ status: "opened", pane: 9 });
		expect(calls.some((c) => c[0] === "canvas" && c[1] === "new")).toBe(true);
		// The next press finds the empty canvas and brings it forward.
		expect(await drawingAction(deps)).toEqual({ status: "empty", pane: 9 });
		expect(focused).toEqual([9]);
	});

	it("captures only the canvas pane, not the whole window", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-drawing-"));
		const shotRel = "target/shots/tern/live/pi-drawing-test.png";
		await mkdir(join(dir, "target/shots/tern/live"), { recursive: true });
		await writeFile(join(dir, shotRel), fixture(100, 100));
		const state = { focused: { cwd: dir }, canvas_blocks: [{ id: 9, shapes: 2, focused: true }] };
		const ctl = async (args: string[]) => {
			if (args[0] === "state") return state;
			if (args[0] === "shot") return { ok: true, png: shotRel };
			if (args[0] === "dump") return { ok: true, elements: [{ path: "main>section.tn-pane.canvas.on", visible: true, rect: [10, 20, 30, 40] }], header: { viewport: { width: 100 } } };
			return { ok: false, error: "unexpected" };
		};
		const result = await captureCanvas({ ctl, focus: async () => {}, workspace: dir, roots: [dir] });
		expect(result.status).toBe("attached");
		if (result.status !== "attached") return;
		expect({ width: result.width, height: result.height, shapes: result.shapes }).toEqual({ width: 30, height: 40, shapes: 2 });
		const pixels = decodePng(await readFile(result.path));
		expect([...pixels.rgba.subarray(0, 4)]).toEqual([10, 20, 7, 255]);
	});

	it("refuses to attach a blank canvas", async () => {
		const ctl = async () => ({ ok: true, canvas_blocks: [{ id: 4, shapes: 0, focused: true }] });
		expect(await drawingAction({ ctl, focus: async () => {}, workspace: "/tmp" })).toEqual({ status: "empty", pane: 4 });
	});
});
