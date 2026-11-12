#!/usr/bin/env -S node --experimental-strip-types
/**
 * Verifies the composer's live whiteboard preview in Tern itself, not in our own CSS: runs the real
 * bridge's poll against a fake `ctl` (a focused canvas whose ink grows, each level shot as its own
 * fixture PNG), replays the bridge's frames into a headless `tern serve`, then measures what Tern
 * actually painted.
 *
 *   node --experimental-strip-types tools/e2e/tern-drawing-preview.mjs
 *
 * Exit 1 unless: the preview row paints above the editor line with a real image box and both controls,
 * and a changed canvas re-captures into a new blob frame that the painted image references. Attach and
 * Hide are bridge-level behavior and are covered by the unit suite; a played surface has no owner to
 * receive clicks, so they are not exercised here.
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiTernBridge } from "../../.pi/lib/tern/bridge.ts";
import { PI_COMPOSER_CSS } from "../../.pi/lib/tern/composer-style.ts";
import { cropPng, encodePng } from "../../.pi/lib/tern/png-crop.ts";

const TERN = process.env.TERN_BIN ?? "tern";
// Mirrors the bridge's active poll cadence (bridge.ts DRAWING_ACTIVE_MS); a local copy keeps the
// harness independent of the module's private constants.
const ACTIVE_MS = 1500;
const listeners = new Set();
const session = {
	state: {},
	subscribe: (listener) => (listeners.add(listener), () => listeners.delete(listener)),
	prompt: () => new Promise(() => {}),
	abort: async () => {},
	dispose() {},
	sessionManager: { getSessionId: () => "drawing-preview-e2e", getEntries: () => [], getBranch: () => [], getCwd: () => process.cwd() },
};

const dir = mkdtempSync(join(tmpdir(), "tern-drawing-preview-"));
const sock = join(dir, "ctl.sock");
const cssFile = join(dir, "composer.css");
let child;
const cleanup = () => { try { if (existsSync(sock)) ctl("quit"); } catch { /* already gone */ } child?.kill(); rmSync(dir, { recursive: true, force: true }); };
process.on("exit", cleanup);

// The fake Tern the poll talks to: one focused canvas whose ink the harness can grow. Each ink level
// gets its own fixture PNG (a different drawn rectangle), so a re-capture must produce a new blob id.
// Absolute shot paths are honored by shotCandidates; the fixture carries the pixels.
const fixturePng = (level) => {
	const rgba = Buffer.alloc(100 * 100 * 4);
	for (let y = 0; y < 100; y++) for (let x = 0; x < 100; x++) {
		const i = (y * 100 + x) * 4;
		const ink = x >= level * 10 && x < level * 10 + 20 && y > 20 && y < 80;
		rgba[i] = ink ? 20 : x & 0xff; rgba[i + 1] = ink ? 30 : y & 0xff; rgba[i + 2] = 7; rgba[i + 3] = 255;
	}
	const file = join(dir, `canvas-shot-${level}.png`);
	writeFileSync(file, encodePng({ width: 100, height: 100, rgba }));
	return file;
};
let shapes = 2;
// The bridge only previews the canvas this instance opened; opening it here mirrors the + button.
let opened = false;
const CANVAS = `canvas:${"0123456789abcdef0123456789abcdef"}`;
const fakeCtl = async (args) => {
	if (args[0] === "canvas" && args[1] === "new") { opened = true; return { ok: true }; }
	if (args[0] === "state") return { ok: true, focused: { cwd: dir }, canvas_blocks: opened ? [{ id: 9, shapes, focused: true, camera: { x: 0, y: 0, zoom: 1 }, canvas: CANVAS }] : [] };
	if (args[0] === "shot") return { ok: true, png: fixturePng(Math.min(shapes, 3)) };
	if (args[0] === "dump") return { ok: true, elements: [{ path: "main>section.tn-pane.canvas.on", visible: true, rect: [10, 20, 30, 40] }], header: { viewport: { width: 100 } } };
	return { ok: false, error: "unexpected ctl call" };
};

const writes = [];
const bridge = new PiTernBridge(session, {
	write: (data) => writes.push(data),
	surfaceId: "pi",
	credits: 1_000_000,
	drawing: { ctl: fakeCtl, focus: async () => {}, workspace: dir, roots: [dir] },
});
bridge.start("pi");
await bridge.submit("/drawing");
// openCanvas polls `state` every 100 ms until the new block appears.
await new Promise((resolve) => setTimeout(resolve, 400));

const frameLines = (writes, from = 0) => {
	const lines = [];
	let t = 0;
	for (const write of writes.slice(from)) {
		for (const hit of write.matchAll(/\x1b_tsp;([A-Za-z]);([\s\S]*?)\x1b\\/g)) {
			try { lines.push(JSON.stringify({ t: (t += 16), dir: "out", verb: hit[1], body: JSON.parse(hit[2]) })); } catch { /* not a frame */ }
		}
	}
	return lines;
};
let played = 0;
// The frames the bridge wrote, and the blob a render actually references (Tern's tree reports boxes
// only, not props, so the frames are the authoritative record of what Tern was told to paint). A blob
// frame is not JSON (`tsp;b;id=…;mime=…;<base64>`), so it is read straight from the raw writes.
const frames = () => {
	const out = [];
	for (const write of writes) for (const hit of write.matchAll(/\x1b_tsp;([A-Za-z]);([\s\S]*?)\x1b\\/g)) {
		try { out.push({ verb: hit[1], body: JSON.parse(hit[2]) }); } catch { /* not a frame */ }
	}
	return out;
};
const imageBlobInFrames = () => {
	for (let i = frames().length - 1; i >= 0; i--) {
		const hit = /"drawing-preview\.img"[\s\S]*?"blob":"([0-9a-f]+)"/.exec(JSON.stringify(frames()[i]?.body));
		if (hit) return hit[1];
	}
	return undefined;
};
const blobFrameIds = () => {
	const ids = new Set();
	for (const write of writes) for (const hit of write.matchAll(/\x1b_tsp;b;(?:c=[^;]+;)?(?:m=1;)?id=([0-9a-f]+);/g)) ids.add(hit[1]);
	return ids;
};
writeFileSync(cssFile, PI_COMPOSER_CSS);

child = spawn(TERN, ["serve", "--control", sock], { cwd: process.cwd(), stdio: "ignore", detached: true });
const deadline = Date.now() + 30_000;
while (!existsSync(sock)) {
	if (Date.now() > deadline) throw new Error("tern serve did not open its control socket");
	execFileSync("sleep", ["0.05"]);
}
function ctl(command) {
	const raw = execFileSync(TERN, ["ctl", "--control", sock, command], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
	const reply = JSON.parse(raw);
	if (reply.ok !== true) throw new Error(`tern ctl ${command}: ${reply.error ?? "failed"}`);
	return reply;
}
const count = (selector) => (ctl(`tree ${selector}`).nodes ?? []).length;
const box = (selector) => (ctl(`tree ${selector}`).nodes ?? [])[0]?.rect ?? null;
const play = (lines, name) => { const file = join(dir, `${name}.jsonl`); writeFileSync(file, lines.join("\n") + "\n"); ctl(`surface-play "${file}"`); };
const replayNew = (name) => { if (writes.length > played) { play(frameLines(writes, played), name); played = writes.length; } };
const wait = (ms) => ctl(`wait ${ms}`);
// Non-blocking: the bridge's poll is a timer on this process's event loop, so a sync sleep would starve
// it and nothing would ever be captured.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

ctl("resize 900 760");
ctl(`css composer ${cssFile}`);
play(frameLines(writes), "live");
wait(600);

const failure = [];
const previewSel = "[data-role='pi.composer.drawing-preview']";

// 1. The poll's first pass is eager: within one active tick the drawn canvas must surface the preview,
//    replayed as a delta the way Tern would receive the frames from a live pane.
await sleep(ACTIVE_MS + 900);
replayNew("preview-1");
wait(500);
const row = box(previewSel);
if (!row || (row[2] === 0 && row[3] === 0)) failure.push("the preview row never painted after the poll found the drawn canvas");
const img = box("[data-role='pi.composer.drawing.image']");
if (!img || (img[2] === 0 && img[3] === 0)) failure.push("the preview's image node has no painted box");
const sendBtn = box("[data-role='pi.composer.drawing-send']");
if (!sendBtn || (sendBtn[2] === 0 && sendBtn[3] === 0)) failure.push("the Attach drawing button has no painted box");
const hideBtn = box("[data-role='pi.composer.drawing-hide']");
if (!hideBtn || (hideBtn[2] === 0 && hideBtn[3] === 0)) failure.push("the Hide button has no painted box");
const line = box("[data-role='omp.composer.line']");
if (row && line && row[1] >= line[1]) failure.push("the preview row does not sit above the editor line");

// 2. A changed canvas re-captures: a new frame paints, and the image references the newest blob.
shapes = 3;
await sleep(ACTIVE_MS + 900);
if (process.env.DEBUG) console.error("after bump:", JSON.stringify({ writes: writes.length, frames: frames().length, blobs: [...blobFrameIds()].length, imgBlob: imageBlobInFrames() }));
replayNew("preview-2");
wait(500);
if (count(previewSel) !== 1) failure.push("the preview did not repaint after the canvas changed");
// The bridge hashes the cropped bytes: the dump's box on the fixture, cropped exactly as the bridge does.
const cropped = cropPng(readFileSync(fixturePng(Math.min(shapes, 3))), { x: 10, y: 20, w: 30, h: 40 });
const newestBlob = createHash("sha256").update(cropped).digest("hex");
const imageBlob = imageBlobInFrames();
if (imageBlob !== newestBlob) failure.push(`the newest render references blob ${imageBlob}, not the newest capture ${newestBlob}`);
if (!blobFrameIds().has(newestBlob)) failure.push("the newest capture's bytes were never sent as a TSP blob frame");

if (failure.length) {
	console.error(`FAIL:\n  - ${failure.join("\n  - ")}`);
	cleanup();
	process.exit(1);
}
console.log("ok: the preview paints above the editor line with image and both controls, and re-captures on change");
cleanup();
process.exit(0);
