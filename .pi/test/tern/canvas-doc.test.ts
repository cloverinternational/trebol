// The persisted whiteboard document and its pure-Node rasterizer: the capture path that needs no
// screenshot (a Tern window started from an unwritable cwd cannot write `ctl shot`).
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canvasDocBounds, canvasStateDir, readCanvasDoc, renderCanvasDoc } from "../../lib/tern/canvas-doc.ts";
import { decodePng, pngSize } from "../../lib/tern/png-crop.ts";

const HASH = "d7fafaf096a22741e87081984bdd02ae";

async function stateWith(doc: unknown): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pi-canvas-doc-"));
	await mkdir(join(dir, HASH), { recursive: true });
	await writeFile(join(dir, HASH, "canvas.json"), JSON.stringify(doc));
	return dir;
}

const inkDoc = {
	format: 2,
	meta: { look: "sketch", paper: "dots" },
	shapes: [{ id: "a", type: "ink", x: 40, y: 40, props: { color: "@0", size: 4, points: [0, 0, 0.5, 50, 50, 0.5, 100, 100, 0.5] } }],
};

const inkPixels = (bytes: Buffer): number => {
	const image = decodePng(bytes);
	let ink = 0;
	for (let i = 0; i < image.rgba.length; i += 4) if (image.rgba[i]! + image.rgba[i + 1]! + image.rgba[i + 2]! < 450) ink++;
	return ink;
};

describe("canvas documents", () => {
	it("reads the persisted document by canvas hash and refuses anything else", async () => {
		const dir = await stateWith(inkDoc);
		expect(readCanvasDoc({ canvas: `canvas:${HASH}` }, dir)?.shapes).toHaveLength(1);
		expect(readCanvasDoc({ canvas: HASH }, dir)?.shapes).toHaveLength(1);
		expect(readCanvasDoc({ canvas: "canvas:not-a-hash" }, dir)).toBeUndefined();
		expect(readCanvasDoc({ canvas: `canvas:${"0".repeat(32)}` }, dir)).toBeUndefined();
		expect(readCanvasDoc({}, dir)).toBeUndefined();
		const broken = await mkdtemp(join(tmpdir(), "pi-canvas-doc-"));
		await mkdir(join(broken, HASH), { recursive: true });
		await writeFile(join(broken, HASH, "canvas.json"), "{ not json");
		expect(readCanvasDoc({ canvas: HASH }, broken)).toBeUndefined();
	});

	it("finds the app's state store the way the app does", () => {
		expect(canvasStateDir({ XDG_STATE_HOME: "/state" })).toBe("/state/tern/canvases");
		expect(canvasStateDir({})).toMatch(/\/\.local\/state\/tern\/canvases$/);
	});

	it("bounds every shape kind, with padding for the ink width", () => {
		const box = canvasDocBounds({
			shapes: [
				{ type: "ink", x: 40, y: 40, props: { size: 4, points: [0, 0, 0.5, 100, 100, 0.5] } },
				{ type: "geo", x: 200, y: 10, props: { form: "rect", w: 50, h: 30, stroke: { width: 2 } } },
				{ type: "text", x: 10, y: 300, props: { text: "hi", w: 40, h: 20 } },
				{ type: "unknown", x: 0, y: 0 },
			],
		}, 12);
		// Leftmost is the text at x=10, rightmost the rect's 200+50+stroke/2; padding is 12 a side.
		expect(box).toEqual({ x: -2, y: -3, w: 265, h: 335 });
		expect(canvasDocBounds({ shapes: [] })).toBeUndefined();
		expect(canvasDocBounds({ shapes: [{ type: "unknown", x: 1, y: 2 }] })).toBeUndefined();
	});

	it("rasterizes ink as visible, correctly sized pixels on paper", () => {
		const rendered = renderCanvasDoc(inkDoc)!;
		expect(rendered).toMatchObject({ shapes: 1, textOmitted: false });
		// 100 px of stroke + 4 px wide + 12 px padding each side.
		expect({ width: rendered.width, height: rendered.height }).toEqual({ width: 128, height: 128 });
		expect(pngSize(rendered.bytes)).toEqual({ width: 128, height: 128 });
		expect(inkPixels(rendered.bytes)).toBeGreaterThan(100);
	});

	it("draws geo outlines and text boxes, and reports text as outlined rather than lettered", () => {
		const geo = renderCanvasDoc({ shapes: [{ type: "geo", x: 0, y: 0, props: { form: "rect", w: 60, h: 40, stroke: { width: 2 } } }] })!;
		expect(geo.width).toBe(86); // 60 + stroke 2 + padding 12 a side
		expect(inkPixels(geo.bytes)).toBeGreaterThan(50);
		const ellipse = renderCanvasDoc({ shapes: [{ type: "geo", x: 0, y: 0, props: { form: "ellipse", w: 60, h: 40, stroke: { width: 2 } } }] })!;
		expect(inkPixels(ellipse.bytes)).toBeGreaterThan(50);
		const text = renderCanvasDoc({ shapes: [{ type: "text", x: 0, y: 0, props: { text: "hello", w: 40, h: 20 } }] })!;
		expect(text.textOmitted).toBe(true);
		expect({ width: text.width, height: text.height }).toEqual({ width: 64, height: 44 });
	});

	it("scales down a far-from-origin canvas and never up", () => {
		const wide = renderCanvasDoc({ shapes: [{ type: "ink", x: 0, y: 0, props: { size: 4, points: [0, 0, 0.5, 4000, 0, 0.5] } }] })!;
		expect(Math.max(wide.width, wide.height)).toBeLessThanOrEqual(1400);
		const tiny = renderCanvasDoc({ shapes: [{ type: "ink", x: 0, y: 0, props: { size: 4, points: [0, 0, 0.5, 10, 10, 0.5] } }] })!;
		expect(tiny.width).toBe(38); // 10 + stroke + padding, at scale 1
	});

	it("renders nothing when there is nothing drawable", () => {
		expect(renderCanvasDoc({ shapes: [] })).toBeUndefined();
		expect(renderCanvasDoc({ shapes: [{ type: "unknown" }] })).toBeUndefined();
	});
});
