#!/usr/bin/env -S node --experimental-strip-types
/**
 * Verifies Pi Voice's live waveform in Tern itself: the real bridge, replaying the meter an extension
 * publishes through `ui.ternMeter`, measured with `ctl tree` in a headless `tern serve`.
 *
 *   node --experimental-strip-types tools/e2e/tern-voice-wave.mjs [--json] [--shot]
 *
 * Exit 1 unless the chart paints full width immediately above the editor row, its bar count matches the
 * amplitude history, and the whole strip disappears when the meter is cleared.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiTernBridge } from "../../.pi/lib/tern/bridge.ts";
import { PI_COMPOSER_CSS } from "../../.pi/lib/tern/composer-style.ts";

const TERN = process.env.TERN_BIN ?? "tern";
const listeners = new Set();
const session = {
	state: {},
	subscribe: (listener) => (listeners.add(listener), () => listeners.delete(listener)),
	prompt: () => new Promise(() => {}),
	abort: async () => {},
	dispose() {},
	sessionManager: { getSessionId: () => "voice-wave-measure", getEntries: () => [], getBranch: () => [], getCwd: () => process.cwd() },
};

const dir = mkdtempSync(join(tmpdir(), "tern-voice-wave-"));
const sock = join(dir, "ctl.sock");
const cssFile = join(dir, "composer.css");
let child;
const cleanup = () => {
	try { if (existsSync(sock)) ctl("quit"); } catch { /* already gone */ }
	child?.kill();
	rmSync(dir, { recursive: true, force: true });
};
process.on("exit", cleanup);

// Frames as `tern serve` replays them; a frame is one APC message.
const frameLines = (writes) => {
	const lines = [];
	let t = 0;
	for (const write of writes) {
		for (const hit of write.matchAll(/\x1b_tsp;([A-Za-z]);([\s\S]*?)\x1b\\/g)) {
			try { lines.push(JSON.stringify({ t: (t += 16), dir: "out", verb: hit[1], body: JSON.parse(hit[2]) })); } catch { /* not a frame */ }
		}
	}
	return lines;
};

const writes = [];
const bridge = new PiTernBridge(session, { write: (data) => writes.push(data), surfaceId: "pi", credits: 1_000_000 });
bridge.start("pi");
const ui = bridge.uiContext();

const levels = Array.from({ length: 96 }, (_, i) => Math.abs(Math.sin((i + 1) * 0.42)) * 0.9);
ui.ternMeter({ levels, elapsedMs: 4200, modelState: "ready", microphoneStopped: false });
// Every write from the start: the handshake creates the surface the later frames update.
const liveFrames = frameLines(writes);
const withMeter = writes.length;

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

const size = (process.argv.find((a) => a.startsWith("--size=")) ?? "--size=900x760").slice("--size=".length).split("x");
ctl(`resize ${size[0]} ${size[1]}`);
ctl(`css composer ${cssFile}`);
writeFileSync(join(dir, "live.jsonl"), liveFrames.join("\n") + "\n");
ctl(`surface-play "${join(dir, "live.jsonl")}"`);
ctl("wait 600");

const shot = (name) => { if (!process.argv.includes("--shot")) return; try { ctl(`shot ${name}`); } catch (error) { console.error(`shot ${name}: ${error instanceof Error ? error.message : String(error)}`); } };
const box = (selector) => (ctl(`tree ${selector}`).nodes ?? [])[0]?.rect ?? null;
const count = (selector) => (ctl(`tree ${selector}`).nodes ?? []).length;

shot("voice-wave");
const chart = box("[data-role='pi.composer.wave.chart']");
const row = box("[data-role='pi.composer.wave']");
const editor = box("[data-role='omp.composer.line']");
const meta = box("[data-role='pi.composer.wave.meta']");
const bars = count("[data-role='pi.composer.wave.chart'] .b");
const failure = [];

if (!chart) failure.push("Tern painted no [data-role='pi.composer.wave.chart']");
if (!row) failure.push("Tern painted no [data-role='pi.composer.wave']");
if (bars !== levels.length) failure.push(`bar count ${bars} != ${levels.length} amplitude columns`);
if (chart && editor) {
	if (chart[1] + chart[3] > editor[1] + 1) failure.push(`the waveform is not above the editor (${chart[1] + chart[3]} > ${editor[1]})`);
	if (chart[2] < editor[2] * 0.5) failure.push(`the waveform is narrow (${chart[2]} of ${editor[2]})`);
}
if (!meta) failure.push("the take's elapsed/model facts are missing");

// Clearing the meter is the stop path: the strip and its row must be gone, not merely empty.
ui.ternMeter(undefined);
writeFileSync(join(dir, "cleared.jsonl"), frameLines(writes.slice(withMeter)).join("\n") + "\n");
ctl(`surface-play "${join(dir, "cleared.jsonl")}"`);
ctl("wait 300");
const after = count("[data-role='pi.composer.wave']");
if (after !== 0) failure.push(`the waveform survives with no take (${after} node(s))`);

bridge.close?.();
const summary = {
	chartRect: chart,
	rowRect: row,
	editorRect: editor,
	metaRect: meta,
	bars,
	waveNodesAfterStop: after,
	failures: failure,
};
console.log(process.argv.includes("--json") ? JSON.stringify(summary, null, 2) : `voice composer waveform ${JSON.stringify(summary)}`);
cleanup();
process.exit(failure.length ? 1 : 0);
