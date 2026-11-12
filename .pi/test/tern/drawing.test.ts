import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { canvasRect, captureCanvas, capturePreview, drawingAction, ownerOf, pickCanvas, previewKey, resolveOwned, shotCandidates } from "../../lib/tern/drawing.ts";
import { cropPng, decodePng, encodePng, pngSize } from "../../lib/tern/png-crop.ts";
import { PiTernBridge, type PiSessionLike } from "../../lib/tern/bridge.ts";
import { ESC, parseTspMessages } from "../../lib/tern/tsp.ts";

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
		const first = await drawingAction(deps);
		expect(first).toEqual({ status: "opened", pane: 9, owner: { pane: 9, canvas: "" } });
		expect(calls.some((c) => c[0] === "canvas" && c[1] === "new")).toBe(true);
		// The next press finds the canvas this instance opened and brings it forward.
		expect(await drawingAction(deps, first.status === "opened" ? first.owner : undefined)).toEqual({ status: "empty", pane: 9, owner: { pane: 9, canvas: "" } });
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
		const ctl = async () => ({ ok: true, canvas_blocks: [{ id: 4, shapes: 0, focused: true, canvas: "canvas:aaaaaaaaaaaaaaaa" }] });
		expect(await drawingAction({ ctl, focus: async () => {}, workspace: "/tmp" }, { pane: 4, canvas: "canvas:aaaaaaaaaaaaaaaa" })).toEqual({ status: "empty", pane: 4, owner: { pane: 4, canvas: "canvas:aaaaaaaaaaaaaaaa" } });
	});
});

describe("live preview", () => {
	it("keys on the canvas, its ink and its camera, so a settled canvas costs one state poll", () => {
		const canvas = { id: 7, shapes: 3, camera: { x: 0, y: 0, zoom: 1 } };
		expect(previewKey(canvas)).toBe(previewKey({ ...canvas }));
		expect(previewKey({ ...canvas, shapes: 4 })).not.toBe(previewKey(canvas));
		expect(previewKey({ ...canvas, camera: { x: 1, y: 0, zoom: 1 } })).not.toBe(previewKey(canvas));
		expect(previewKey({ ...canvas, camera: { x: 0, y: 0, zoom: 1.5 } })).not.toBe(previewKey(canvas));
		expect(previewKey(undefined)).toBeUndefined();
	});

	it("captures a preview from the focused pane without stealing focus", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-drawing-preview-"));
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
		const focused: number[] = [];
		const preview = await capturePreview({ ctl, focus: async (pane: number) => { focused.push(pane); }, workspace: dir, roots: [dir] }, state.canvas_blocks[0]);
		expect(preview.ok).toBe(true);
		if (preview.ok !== true) return;
		expect({ width: preview.width, height: preview.height, shapes: preview.shapes, pane: preview.pane }).toEqual({ width: 30, height: 40, shapes: 2, pane: 9 });
		const pixels = decodePng(preview.bytes);
		expect([...pixels.rgba.subarray(0, 4)]).toEqual([10, 20, 7, 255]);
		expect(focused).toEqual([]);
	});

	it("never photographs the focused pane when our canvas is not the focused one", async () => {
		// With several tabs, `shot` + `dump section.tn-pane.canvas` describes whichever pane is focused.
		// An unfocused preview must therefore use the hash-addressed document or report not-ready.
		const dir = await mkdtemp(join(tmpdir(), "pi-drawing-preview-"));
		let shots = 0;
		const ctl = async (args: string[]) => {
			if (args[0] === "shot") { shots++; return { ok: true, png: "unused.png" }; }
			if (args[0] === "state") return { ok: true, focused: { cwd: dir }, canvas_blocks: [{ id: 3, shapes: 1 }, { id: 5, shapes: 1, focused: true }] };
			return { ok: true, elements: [{ path: "section.tn-pane.canvas.on", visible: true, rect: [20, 0, 10, 10] }] };
		};
		const focused: number[] = [];
		const preview = await capturePreview({ ctl, focus: async (pane: number) => { focused.push(pane); }, workspace: dir, roots: [dir] }, { id: 3, shapes: 1 });
		expect(preview).toMatchObject({ ok: false, reason: expect.stringMatching(/not focused/) });
		expect(shots).toBe(0);
		expect(focused).toEqual([]);
	});
});

describe("PiTernBridge drawing preview", () => {
	// The poll is the bridge's own timer on real time: each step waits a hair over the active cadence,
	// exactly as the live harness does. Everything else (ctl, focus, shots) is the same fake as above.
	const calls: string[][] = [];
	let shapes = 0;
	// Only the canvas this bridge opened exists. Ownership is what keeps a second Pi tab's whiteboard out
	// of this preview, so the fixture has to model opening rather than assume a focused canvas is ours.
	const HASH = "0123456789abcdef0123456789abcdef";
	let opened = false;
	const state = () => ({
		ok: true,
		focused: { cwd: dir },
		canvas_blocks: opened ? [{ id: 9, shapes, focused: true, camera: { x: 0, y: 0, zoom: 1 }, canvas: `canvas:${HASH}` }] : [],
	});
	let dir = "";
	const shotRel = "target/shots/tern/live/pi-drawing-test.png";
	const ctl = async (args: string[]) => {
		calls.push(args);
		if (args[0] === "canvas" && args[1] === "new") { opened = true; return { ok: true }; }
		if (args[0] === "state") return state();
		if (args[0] === "shot") return { ok: true, png: shotRel };
		if (args[0] === "dump") return { ok: true, elements: [{ path: "main>section.tn-pane.canvas.on", visible: true, rect: [10, 20, 30, 40] }], header: { viewport: { width: 100 } } };
		return { ok: false, error: "unexpected" };
	};
	const writes: string[] = [];
	const session = {
		subscribe: () => () => {},
		prompt: async () => {},
		abort: async () => {},
		dispose() {},
		model: { provider: "p", id: "m", input: ["text"] },
		sessionManager: { getSessionId: () => "s1", getEntries: () => [], getBranch: () => [], getCwd: () => dir },
	} as unknown as PiSessionLike;
	let bridge: PiTernBridge;
	// One active poll (1.5 s) plus its file I/O, with slack for a loaded machine.
	const pollOnce = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 1900));
	const quiet = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
	const tree = () => {
		const nodes = new Map<string, any>();
		const add = (n: any, parent: string): void => { nodes.set(n.id, { ...n, c: undefined, parent }); for (const c of n.c ?? []) add(c, n.id); };
		const del = (id: string): void => { for (const [cid, n] of [...nodes]) if (n.parent === id) del(cid); nodes.delete(id); };
		for (const w of writes) {
			if (!w.startsWith(`${ESC}_tsp;f;`)) continue;
			for (const op of (parseTspMessages(w)[0]?.body as { ops: unknown[][] }).ops) {
				if (op[0] === "add") add(op[4], String(op[2]));
				else if (op[0] === "del") del(String(op[1]));
				else if (op[0] === "set") { const n = nodes.get(String(op[1])); if (n) n.p = { ...n.p, ...(op[2] as Record<string, unknown>) }; }
			}
		}
		return nodes;
	};

	beforeAll(async () => {
		dir = await mkdtemp(join(tmpdir(), "pi-drawing-bridge-"));
		await mkdir(join(dir, "target/shots/tern/live"), { recursive: true });
		await writeFile(join(dir, shotRel), fixture(100, 100));
		bridge = new PiTernBridge(session, {
			write: (d) => writes.push(d), surfaceId: "pi", credits: 1000,
			drawing: { ctl, focus: async () => {}, workspace: dir, roots: [dir] },
		});
		bridge.start("pi");
		// The document is opened by this instance, exactly as the + button and /drawing do it.
		await bridge.submit("/drawing");
		await quiet(300);
	});
	afterAll(() => {
		bridge?.close();
	});

	it("surfaces the drawn canvas as a live preview row, and a settled canvas re-renders nothing", { timeout: 15_000 }, async () => {
		shapes = 2;
		await pollOnce();
		const nodes = tree();
		const row = nodes.get("drawing-preview");
		expect(row?.parent).toBe("composer-col");
		const cropped = cropPng(await readFile(join(dir, shotRel)), { x: 10, y: 20, w: 30, h: 40 });
		expect(nodes.get("drawing-preview.img")?.p).toMatchObject({ blob: createHash("sha256").update(cropped).digest("hex"), w: 30, h: 40 });
		expect(nodes.get("drawing-preview.send")?.p).toMatchObject({ role: "pi.composer.drawing-send", actions: { click: "drawing.send" } });
		expect(nodes.get("drawing-preview.hide")?.p).toMatchObject({ role: "pi.composer.drawing-hide", actions: { click: "drawing.discard" } });
		const settled = writes.length;
		const shots = calls.filter((c) => c[0] === "shot").length;
		await quiet(3400); // two more active polls with the same shapes and camera
		expect(writes.length).toBe(settled);
		expect(calls.filter((c) => c[0] === "shot")).toHaveLength(shots);
	});

	it("re-captures when the ink changes, and a new blob precedes the frame that references it", async () => {
		shapes = 3;
		await pollOnce();
		const nodes = tree();
		expect(nodes.get("drawing-preview.img")?.p?.w).toBe(30);
		expect(calls.filter((c) => c[0] === "shot")).toHaveLength(2);
		const fresh = writes.slice(-8);
		const firstFrame = fresh.findIndex((x) => x.startsWith(`${ESC}_tsp;f;`));
		expect(fresh.some((x, i) => x.startsWith(`${ESC}_tsp;b;`) && i < firstFrame)).toBe(true);
	});

	it("Attach captures the focused canvas and turns it into an ordinary image chip; the preview yields", async () => {
		bridge.handle({ verb: "e", body: { sf: "pi", ev: "action", act: "drawing.send" } } as never);
		await quiet(500);
		expect(bridge.attachments.map((a) => a.kind)).toEqual(["image"]);
		expect(bridge.attachments[0]?.blob?.mime).toBe("image/png");
		// The file's path rides in the composer too, so a failed image still leaves a readable reference.
		expect(bridge.draft).toMatch(/Drawing: artifacts\/tern-drawings\/pi-drawing-[a-z0-9]+\.png/);
		const nodes = tree();
		expect(nodes.has("drawing-preview")).toBe(false); // the chip carries it now
		expect(nodes.get("composer-chips")?.k).toBe("row");
		expect(nodes.get("chip-1.img")?.p).toMatchObject({ blob: bridge.attachments[0]?.blob?.id });
	});

	it("a new stroke after an attach brings the preview back; Hide clears it until the next stroke", { timeout: 20_000 }, async () => {
		shapes = 4;
		await pollOnce();
		expect(tree().has("drawing-preview")).toBe(true);
		bridge.handle({ verb: "e", body: { sf: "pi", ev: "action", act: "drawing.discard" } } as never);
		expect(tree().has("drawing-preview")).toBe(false);
		await quiet(3200);
		expect(tree().has("drawing-preview")).toBe(false); // unchanged canvas stays hidden
		shapes = 5;
		await pollOnce();
		expect(tree().has("drawing-preview")).toBe(true);
	});

	it("attaching with nothing drawn reports it and adds nothing", async () => {
		shapes = 0;
		const draft = bridge.draft;
		bridge.handle({ verb: "e", body: { sf: "pi", ev: "action", act: "drawing.send" } } as never);
		await quiet(400);
		expect(bridge.attachments).toHaveLength(1); // the earlier attach only
		expect(bridge.draft).toBe(draft); // an empty canvas adds no path
		await quiet(2600);
		expect(tree().has("drawing-preview")).toBe(false); // an empty canvas previews nothing
	});
});

describe("document fallback", () => {
	// A Tern window started from `/` cannot write `target/shots/tern/live`, so `ctl shot` fails with a
	// permission error. Tern still persists the canvas document under its state directory; rendering it
	// is the capture that needs no screenshot.
	const HASH = "d7fafaf096a22741e87081984bdd02ae";
	const doc = { format: 2, shapes: [{ type: "ink", x: 40, y: 40, props: { size: 4, points: [0, 0, 0.5, 100, 100, 0.5] } }] };
	const stateWith = async (shapes: number) => {
		const dir = await mkdtemp(join(tmpdir(), "pi-doc-state-"));
		await mkdir(join(dir, HASH), { recursive: true });
		await writeFile(join(dir, HASH, "canvas.json"), JSON.stringify({ ...doc, shapes: doc.shapes.slice(0, shapes) }));
		return dir;
	};
	const shotFails = async (args: string[]) => {
		if (args[0] === "state") return { ok: true, focused: { cwd: "/tmp" }, canvas_blocks: [{ id: 9, shapes: 1, focused: true, canvas: `canvas:${HASH}` }] };
		if (args[0] === "shot") return { ok: false, error: "cannot write target/shots/tern/live: Permission denied (os error 13)" };
		return { ok: false, error: "unexpected" };
	};

	it("captures the persisted document when the screenshot cannot be written", async () => {
		const stateDir = await stateWith(1);
		const workspace = await mkdtemp(join(tmpdir(), "pi-doc-out-"));
		const result = await captureCanvas({ ctl: shotFails, focus: async () => {}, workspace, roots: [workspace], stateDir, now: () => 1 });
		expect(result).toMatchObject({ status: "attached", source: "document", shapes: 1, width: 128, height: 128 });
		if (result.status !== "attached") return;
		const image = decodePng(await readFile(result.path));
		let ink = 0;
		for (let i = 0; i < image.rgba.length; i += 4) if (image.rgba[i]! + image.rgba[i + 1]! + image.rgba[i + 2]! < 450) ink++;
		expect(ink).toBeGreaterThan(100);
	});

	it("previews from the document without a shot and without stealing focus", async () => {
		const stateDir = await stateWith(1);
		const focused: number[] = [];
		const preview = await capturePreview({ ctl: shotFails, focus: async (pane: number) => { focused.push(pane); }, workspace: "/tmp", stateDir }, { id: 9, shapes: 1, canvas: `canvas:${HASH}` });
		expect(preview).toMatchObject({ ok: true, source: "document", shapes: 1 });
		expect(focused).toEqual([]);
	});

	it("waits out a document that lags the canvas state instead of rendering a stale frame", async () => {
		const stateDir = await stateWith(1); // the state already counts 2 shapes
		const preview = await capturePreview({ ctl: shotFails, focus: async () => {}, workspace: "/tmp", stateDir }, { id: 9, shapes: 2, canvas: `canvas:${HASH}` });
		expect(preview.ok).toBe(false);
		if (preview.ok) return;
		expect(preview.reason).toMatch(/not focused|not ready/);
	});

	it("surfaces the control error when neither a screenshot nor a document exists", async () => {
		const emptyState = await mkdtemp(join(tmpdir(), "pi-doc-empty-"));
		await expect(captureCanvas({ ctl: shotFails, focus: async () => {}, workspace: "/tmp", roots: ["/tmp"], stateDir: emptyState }, { id: 9, shapes: 1, focused: true, canvas: `canvas:${HASH}` }))
			.rejects.toThrow(/Permission denied/);
	});
});

describe("canvas ownership", () => {
	const doc = { format: 2, shapes: [{ type: "ink", x: 40, y: 40, props: { size: 4, points: [0, 0, 0.5, 100, 100, 0.5] } }] };
	const stateWithDoc = async (hash: string, shapes: number) => {
		const dir = await mkdtemp(join(tmpdir(), "pi-owner-state-"));
		await mkdir(join(dir, hash), { recursive: true });
		await writeFile(join(dir, hash, "canvas.json"), JSON.stringify({ ...doc, shapes: doc.shapes.slice(0, shapes) }));
		return dir;
	};
	const ours = { pane: 2, canvas: "canvas:ours" };

	it("matches by canvas hash even when another tab's canvas is focused", () => {
		const state = { canvas_blocks: [{ id: 1, canvas: "canvas:other", shapes: 7, focused: true }, { id: 2, canvas: "canvas:ours", shapes: 3 }] };
		expect(resolveOwned(state, ours)).toMatchObject({ id: 2 });
		// A stale pane id (window reloaded) does not matter: the hash is the key.
		expect(resolveOwned(state, { pane: 1, canvas: "canvas:ours" })).toMatchObject({ id: 2 });
		expect(ownerOf({ id: 2, canvas: "canvas:ours" })).toEqual(ours);
	});

	it("a closed canvas is absent, never replaced by the nearest one", () => {
		const state = { canvas_blocks: [{ id: 1, canvas: "canvas:other", shapes: 7, focused: true }] };
		expect(resolveOwned(state, ours)).toBeUndefined();
		expect(resolveOwned(state, undefined)).toBeUndefined();
	});

	it("uses the pane id only when no hash was ever reported", () => {
		expect(resolveOwned({ canvas_blocks: [{ id: 2, shapes: 1 }] }, { pane: 2, canvas: "" })).toMatchObject({ id: 2 });
		expect(resolveOwned({ canvas_blocks: [{ id: 2, shapes: 1 }] }, { pane: 3, canvas: "" })).toBeUndefined();
	});

	it("an owned empty canvas comes forward instead of adopting another tab's ink", async () => {
		const state = { canvas_blocks: [{ id: 1, canvas: "canvas:other", shapes: 9, focused: true }, { id: 2, canvas: "canvas:ours", shapes: 0 }] };
		const ctl = async (args: string[]) => (args[0] === "state" ? state : { ok: false, error: "unexpected" });
		const focused: number[] = [];
		const result = await drawingAction({ ctl, focus: async (pane: number) => { focused.push(pane); }, workspace: "/tmp" }, ours);
		expect(result).toMatchObject({ status: "empty", pane: 2 });
		expect(focused).toEqual([2]);
	});

	it("opens a new canvas when the owned one is gone, and never adopts the other tab's", async () => {
		let created = false;
		const ctl = async (args: string[]) => {
			if (args[0] === "state") {
				return {
					ok: true,
					canvas_blocks: created
						? [{ id: 1, canvas: "canvas:other", shapes: 9, focused: true }, { id: 5, canvas: "canvas:new", shapes: 0, focused: true }]
						: [{ id: 1, canvas: "canvas:other", shapes: 9, focused: true }],
				};
			}
			if (args[0] === "canvas" && args[1] === "new") { created = true; return { ok: true }; }
			return { ok: false, error: "unexpected" };
		};
		const result = await drawingAction({ ctl, focus: async () => {}, workspace: "/tmp" }, { pane: 4, canvas: "canvas:closed" });
		expect(result).toMatchObject({ status: "opened", owner: { pane: 5, canvas: "canvas:new" } });
	});

	it("previews an unfocused owned canvas from its document, firing no shot at all", async () => {
		const hash = "0123456789abcdef0123456789abcdef";
		const stateDir = await stateWithDoc(hash, 1);
		let shots = 0;
		let dumps = 0;
		const ctl = async (args: string[]) => {
			if (args[0] === "shot") { shots++; return { ok: true, png: "unused.png" }; }
			if (args[0] === "dump") dumps++;
			return { ok: true, canvas_blocks: [] };
		};
		const preview = await capturePreview(
			{ ctl, focus: async () => {}, workspace: "/tmp", stateDir },
			{ id: 2, shapes: 1, canvas: `canvas:${hash}`, focused: false },
		);
		expect(preview).toMatchObject({ ok: true, source: "document", shapes: 1, pane: 2 });
		expect({ shots, dumps }).toEqual({ shots: 0, dumps: 0 });
	});

	it("picks the newly focused canvas when two appear at once", async () => {
		let states = 0;
		const ctl = async (args: string[]) => {
			if (args[0] === "state") {
				states++;
				return states === 1
					? { ok: true, canvas_blocks: [{ id: 1, canvas: "canvas:other", shapes: 4, focused: false }] }
					: {
						ok: true,
						canvas_blocks: [
							{ id: 1, canvas: "canvas:other", shapes: 4, focused: false },
							{ id: 6, canvas: "canvas:theirs", shapes: 0, focused: false },
							{ id: 7, canvas: "canvas:mine", shapes: 0, focused: true },
						],
					};
			}
			if (args[0] === "canvas") return { ok: true };
			return { ok: false };
		};
		const { openCanvas } = await import("../../lib/tern/drawing.ts");
		const result = await openCanvas({ ctl, focus: async () => {}, workspace: "/tmp" });
		expect(result).toMatchObject({ status: "opened", pane: 7, owner: { pane: 7, canvas: "canvas:mine" } });
	});
});
