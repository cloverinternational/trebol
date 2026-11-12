#!/usr/bin/env -S node --experimental-strip-types
/**
 * Verifies the picture-annotation card in Tern itself: the real bridge, its generated sheet and its
 * frames, replayed into a headless `tern serve`, then measured with `ctl tree`. This is the check that
 * TSP alone cannot make — that a mark actually has a position on the picture.
 *
 *   node --experimental-strip-types tools/e2e/tern-annotate.mjs
 *
 * Exit 1 unless the card, stage, picture, grid cell, crosshair, pin and note all paint with real boxes,
 * the pin sits where the clicked cell put it, and an arrow key moves the crosshair (so the sheet is
 * re-sent, not only installed once).
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiTernBridge } from "../../.pi/lib/tern/bridge.ts";
import { encodePng } from "../../.pi/lib/tern/png-crop.ts";

const TERN = process.env.TERN_BIN ?? "tern";
const dir = mkdtempSync(join(tmpdir(), "tern-annotate-"));
const sock = join(dir, "ctl.sock");
let child;
const cleanup = () => {
	try { if (existsSync(sock)) ctl("quit"); } catch { /* already gone */ }
	child?.kill();
	rmSync(dir, { recursive: true, force: true });
};
process.on("exit", cleanup);

// A 320×160 picture with a distinctive block, so the painted stage's aspect ratio is checkable.
const width = 320;
const height = 160;
const rgba = Buffer.alloc(width * height * 4);
for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
	const i = (y * width + x) * 4;
	const block = x > 40 && x < 120 && y > 40 && y < 120;
	rgba[i] = block ? 40 : 235; rgba[i + 1] = block ? 90 : 235; rgba[i + 2] = block ? 200 : 235; rgba[i + 3] = 255;
}
const png = join(dir, "shot.png");
writeFileSync(png, encodePng({ width, height, rgba }));

const listeners = new Set();
const session = {
	subscribe: (listener) => (listeners.add(listener), () => listeners.delete(listener)),
	prompt: () => new Promise(() => {}),
	abort: async () => {},
	dispose() {},
	sessionManager: { getSessionId: () => "annotate-e2e", getEntries: () => [], getBranch: () => [], getCwd: () => dir },
};
const emit = (event) => { for (const listener of listeners) listener(event); };

const writes = [];
const bridge = new PiTernBridge(session, { write: (data) => writes.push(data), surfaceId: "pi", credits: 1_000_000 });
bridge.start("pi");

// A picture reaches the transcript as a Read result; the bridge previews it from the file.
emit({ type: "tool_execution_start", toolCallId: "c1", toolName: "Read", args: { file_path: png } });
emit({ type: "tool_execution_end", toolCallId: "c1", toolName: "Read", result: { content: [] }, isError: false });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
await sleep(120);
await bridge.submit("/annotate");
// Click the cell at row 4, column 8 (centre of the picture, one third down), then pin it.
bridge.handle({ verb: "e", body: { ev: "action", act: "annotate.cell", id: "annotate-cell-4-8" } });
bridge.handle({ verb: "e", body: { ev: "key", key: "enter" } });
await sleep(20);

const frameLines = (from = 0) => {
	const lines = [];
	let t = 0;
	for (const write of writes.slice(from)) {
		for (const hit of write.matchAll(/\x1b_tsp;([A-Za-z]);([\s\S]*?)\x1b\\/g)) {
			try { lines.push(JSON.stringify({ t: (t += 16), dir: "out", verb: hit[1], body: JSON.parse(hit[2]) })); } catch { /* not JSON (blob) */ }
		}
	}
	return lines;
};

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
const box = (selector) => (ctl(`tree ${selector}`).nodes ?? [])[0]?.rect ?? null;
const play = (lines, name) => {
	const file = join(dir, `${name}.jsonl`);
	writeFileSync(file, lines.join("\n") + "\n");
	ctl(`surface-play "${file}"`);
};
let played = 0;
const replayNew = (name) => { if (writes.length > played) { play(frameLines(played), name); played = writes.length; } };
const wait = (ms) => ctl(`wait ${ms}`);

ctl("resize 900 760");
// A blob frame is not JSON, so the picture's bytes are carried inside the JSONL's frame order by the
// bridge's own blob frames; surface-play accepts them because they precede the render frame.
play(frameLines(0), "annotate");
played = writes.length;
wait(700);

const failure = [];
const card = box("[data-role='pi.annotate']");
if (!card || (card[2] === 0 && card[3] === 0)) failure.push("the annotation card never painted");
const stage = box("[data-id='annotate-stage']");
if (!stage || (stage[2] === 0 && stage[3] === 0)) failure.push("the stage has no painted box (the generated sheet may not have been accepted)");
const image = box("[data-id='annotate-image']");
if (!image || (image[2] === 0 && image[3] === 0)) failure.push("the picture has no painted box");
const cell = box("[data-id='annotate-cell-4-8']");
if (!cell || (cell[2] === 0 && cell[3] === 0)) failure.push("the clicked grid cell has no painted box (clicks could not land)");
const cursor = box("[data-id='annotate-cursor']");
if (!cursor || (cursor[2] === 0 && cursor[3] === 0)) failure.push("the crosshair has no painted box");
const pin = box("[data-id='annotate-pin-1']");
if (!pin || (pin[2] === 0 && pin[3] === 0)) failure.push("the pin has no painted box");
const note = box("[data-id='annotate-note']");
if (!note || (note[2] === 0 && note[3] === 0)) failure.push("the note field has no painted box");

if (stage && image) {
	// The picture must fill the stage, or percentage marks would not mean picture space.
	if (Math.abs(image[2] - stage[2]) > 2 || Math.abs(image[3] - stage[3]) > 2) {
		failure.push(`the picture (${image[2]}×${image[3]}) does not fill the stage (${stage[2]}×${stage[3]})`);
	}
	// 320×160 is 1:2, so the stage must be half as tall as it is wide.
	if (Math.abs(stage[3] - stage[2] / 2) > 2) failure.push(`the stage is ${stage[2]}×${stage[3]}, not the picture's 2:1 ratio`);
}
if (stage && pin) {
	const expectedX = stage[0] + stage[2] * ((8 + 0.5) / 16);
	const expectedY = stage[1] + stage[3] * ((4 + 0.5) / 9);
	const pinX = pin[0] + pin[2] / 2;
	const pinY = pin[1] + pin[3] / 2;
	if (Math.abs(pinX - expectedX) > 8 || Math.abs(pinY - expectedY) > 8) {
		failure.push(`the pin is at ${Math.round(pinX)},${Math.round(pinY)}, not at the clicked cell ${Math.round(expectedX)},${Math.round(expectedY)}`);
	}
}

// An arrow key must move the crosshair: that is the generated sheet being replaced, not just sent once.
const before = box("[data-id='annotate-cursor']");
for (let i = 0; i < 5; i++) bridge.handle({ verb: "e", body: { ev: "key", key: "right" } });
replayNew("moved");
wait(300);
const after = box("[data-id='annotate-cursor']");
if (!before || !after || after[0] <= before[0] + 2) failure.push(`the crosshair did not move right (${before?.[0]} → ${after?.[0]})`);
if (stage && after && Math.abs(after[3] - 16) > 2) failure.push("the crosshair lost its 16px size after the sheet was re-sent");

if (failure.length) {
	console.error(`FAIL:\n  - ${failure.join("\n  - ")}`);
	cleanup();
	process.exit(1);
}
console.log(`ok: stage ${stage[2]}×${stage[3]} with the picture filling it, pin at the clicked cell, ${Math.round(after[0] - before[0])}px nudge, note and controls painted`);
cleanup();
process.exit(0);
