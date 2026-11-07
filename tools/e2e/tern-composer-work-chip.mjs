#!/usr/bin/env -S node --experimental-strip-types
/**
 * Measures the composer's running-work pulse in Tern itself (not by reading our own CSS): seeds live
 * background work, replays the real bridge's frames into a headless `tern serve`, and reports what Tern
 * actually painted — whether the old dock card is gone, whether the pulse is inside the composer bar,
 * whether it costs the dock any height, and what the hidden/forced card really computes to.
 *
 *   node tools/e2e/tern-composer-work-chip.mjs [--json] [--size=900x760]
 *
 * Exit 1 if the old shelf survives, the pulse is missing, or the pulse changes the dock's height.
 * The hover reveal itself cannot be synthesised by `ctl`, so this forces the card visible through a
 * second stylesheet (the same rule the sheet applies on :hover/:focus-within) purely to measure its box.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiTernBridge } from "../../.pi/lib/tern/bridge.ts";
import { PI_COMPOSER_CSS } from "../../.pi/lib/tern/composer-style.ts";
import { removeRunningWork, setRunningWork } from "../../.pi/lib/ui/running-work-store.ts";

const TERN = process.env.TERN_BIN ?? "tern";
const listeners = new Set();
const session = {
	state: {},
	subscribe: (listener) => (listeners.add(listener), () => listeners.delete(listener)),
	prompt: () => new Promise(() => {}),
	abort: async () => {},
	dispose() {},
	sessionManager: { getSessionId: () => "work-chip-measure", getEntries: () => [], getBranch: () => [], getCwd: () => process.cwd() },
};

const dir = mkdtempSync(join(tmpdir(), "tern-work-chip-"));
const sock = join(dir, "ctl.sock");
const cssFile = join(dir, "composer.css");
let child;
const cleanup = () => { try { if (existsSync(sock)) ctl("quit"); } catch { /* already gone */ } child?.kill(); rmSync(dir, { recursive: true, force: true }); for (const id of ["m-1", "m-2"]) removeRunningWork(id); };
process.on("exit", cleanup);

// Frames as `tern serve` replays them; a frame is one APC message.
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
const play = (lines, name) => { const file = join(dir, `${name}.jsonl`); writeFileSync(file, lines.join("\n") + "\n"); ctl(`surface-play "${file}"`); };

const writes = [];
const bridge = new PiTernBridge(session, { write: (data) => writes.push(data), surfaceId: "pi", credits: 1_000_000 });
const now = Date.now();
setRunningWork({ id: "m-1", kind: "bash", label: "Build", status: "running", startedAt: now - 4200, detail: "npm run build", foreground: false });
setRunningWork({ id: "m-2", kind: "subagent", label: "Agent audit", status: "running", startedAt: now - 9000, detail: "Audit the parser", foreground: false });
bridge.start("pi");
// Collected while the bridge is still open: its final frame closes the surface, so it is never replayed.
const liveFrames = frameLines(writes, 0);
const withWork = writes.length;

writeFileSync(cssFile, PI_COMPOSER_CSS);

// Serve from the repo so `--shot` PNGs land under target/shots/tern/serve/, like Tern's other shots.
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
play(liveFrames, "live");
ctl("wait 600");

// --shot writes PNGs beside Tern's other shots so the pulse can actually be looked at, not just measured.
const shot = (name) => { if (!process.argv.includes("--shot")) return; try { ctl(`shot ${name}`); } catch (error) { console.error(`shot ${name}: ${error instanceof Error ? error.message : String(error)}`); } };
const box = (selector) => (ctl(`tree ${selector}`).nodes ?? [])[0]?.rect ?? null;
const style = (selector) => (ctl(`dump ${selector}`).elements ?? [])[0] ?? null;
const count = (selector) => (ctl(`tree ${selector}`).nodes ?? []).length;

if (process.env.DEBUG) {
	for (const sel of ["[data-role='omp.editor']", ".sf-dock", "[data-role='omp.composer.bar']", "[data-role='omp.composer.extras']", "[data-role='pi.composer.work']", "[data-role='pi.composer.work.count']", ".sf-spinner"]) {
		console.error(sel, JSON.stringify(ctl(`tree ${sel}`).nodes?.length ?? 0), JSON.stringify((ctl(`tree ${sel}`).nodes ?? []).slice(0, 3)));
	}
}
// A zero box is Tern's answer for display:none.
const isHidden = (rect) => !rect || (rect[2] === 0 && rect[3] === 0);
const dock = box("[data-role='omp.editor']");
const pulse = box("[data-role='pi.composer.work']");
const spinner = box("[data-role='pi.composer.work.pulse']");
const countText = box("[data-role='pi.composer.work.count']");
const nameAtRest = box("[data-role='pi.composer.work.now']");
const oldCard = count("[data-role='pi.background']");
const strayCard = count("[data-role='pi.composer.work.card']");
const failure = [];

if (oldCard !== 0) failure.push(`the old dock card is still painted (${oldCard} node(s))`);
if (!pulse) failure.push("Tern painted no [data-role='pi.composer.work']");
if (!spinner) failure.push("the pulse has no spinner element");
if (!countText) failure.push("the pulse has no count");
// The status band clips its own children, so a hover panel inside it could never paint; none is drawn.
if (strayCard !== 0) failure.push(`a hover card is in the tree (${strayCard}); the bar's band would clip it`);
if (!isHidden(nameAtRest)) failure.push(`the job's name is visible at rest: ${JSON.stringify(nameAtRest)}`);
if (pulse && box("[data-role='omp.composer.extras']")) {
	const extras = box("[data-role='omp.composer.extras']");
	// Same row as the git facts, to their right — not a band of its own.
	if (pulse[1] < extras[1] - 1 || pulse[1] > extras[1] + extras[3] + 1) failure.push("the pulse is not on the composer bar's row");
	if (pulse[0] < extras[0] - 1) failure.push("the pulse sits before the git facts");
}

// The reveal itself is :hover/:focus-within, which `ctl` cannot synthesise. Force the name visible with the
// same declaration the sheet applies on hover, so its real box and type can be measured.
shot("work-pulse");
const forceFile = join(dir, "force.css");
writeFileSync(forceFile, `[data-role='pi.composer.work'] [data-role='pi.composer.work.now'] { display: inline; }\n`);
ctl(`css work-force ${forceFile}`);
ctl("wait 200");
shot("work-name-shown");
const nameShown = box("[data-role='pi.composer.work.now']");
const nameStyle = style("[data-role='pi.composer.work.now']");
const barAfterReveal = box("[data-role='omp.composer.bar']");
if (isHidden(nameShown)) failure.push("the revealed name has no box");
else {
	if (nameStyle && parseFloat(nameStyle.fontSize) > 11) failure.push(`the revealed name is too large (${nameStyle.fontSize})`);
	if (barAfterReveal && dock && barAfterReveal[3] !== 24) failure.push(`revealing the name grows the bar (${barAfterReveal[3]}px)`);
	// Sibling text nodes are laid flush, so the name must space itself or it paints over the count.
	if (countText && nameShown[0] < countText[0] + countText[2]) failure.push(`the revealed name overlaps the count (${nameShown[0]} < ${countText[0] + countText[2]})`);
}
writeFileSync(forceFile, "");
ctl(`css work-force ${forceFile}`);
ctl("wait 100");

// Drain the work and play the bridge's own follow-up frames: the bar must not change height.
removeRunningWork("m-1");
removeRunningWork("m-2");
// The store subscription already re-rendered the live bridge; play only what it wrote after the drain.
play(frameLines(writes, withWork), "drained");
ctl("wait 400");
const dockAfter = box("[data-role='omp.editor']");
const pulseAfter = count("[data-role='pi.composer.work']");
if (pulseAfter !== 0) failure.push(`the pulse survives with no live work (${pulseAfter} node(s))`);
if (dock && dockAfter && dock[3] !== dockAfter[3]) failure.push(`the pulse changes the composer height (${dock[3]} -> ${dockAfter[3]})`);

bridge.close?.();
const summary = {
	dockHeight: dock?.[3] ?? null,
	dockHeightIdle: dockAfter?.[3] ?? null,
	pulseRect: pulse,
	spinnerRect: spinner,
	nameAtRest: nameAtRest ?? null,
	nameShown: nameShown ?? null,
	nameFontSize: nameStyle ? parseFloat(nameStyle.fontSize) : null,
	barHeightAfterReveal: barAfterReveal?.[3] ?? null,
	legacyShelfNodes: oldCard,
	failures: failure,
};
console.log(process.argv.includes("--json") ? JSON.stringify(summary, null, 2) : `composer work pulse ${JSON.stringify(summary)}`);
cleanup();
process.exit(failure.length ? 1 : 0);
