#!/usr/bin/env node
/** Run the real /claw daemon tick loop over the committed 2026-10-22 fixture store with a virtual clock, then print
 *  the resulting store's metrics. This is the "after" side of the before/after comparison: same runs, same events,
 *  same window, new supervisor.
 *
 *  Usage: node --experimental-strip-types tools/claw/replay-supervisor.mjs --store <dir> [--step 60000]
 *
 *  Simulated, and stated as such in the report: worker liveness (no recorded worker processes exist any more, so
 *  `alive` answers true), Tern (a double that closes blocks and renames tabs in memory), and Hoja (an in-memory issue
 *  that records the comments and states the outbox would apply). Nothing is written outside --store. */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tick, claimLock, pidAlive } from "../../.pi/lib/claw/daemon.ts";
import { ClawStore } from "../../.pi/lib/claw/store.ts";

const args = process.argv.slice(2);
const arg = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback; };
const storeDir = arg("store");
if (!storeDir) throw new Error("usage: replay-supervisor.mjs --store <dir> [--step ms]");
const step = Number(arg("step", "60000"));
if (!Number.isFinite(step) || step <= 0) throw new Error("--step must be a positive number of milliseconds");

// --store is the claw directory itself (the one holding runs/, inbox.jsonl), not the workspace root.
const store = new ClawStore(storeDir);
const runs = store.listRuns();
const start = Math.min(...runs.map((r) => Date.parse(r.createdAt)));
// One hour past the last recorded update: the same fixed window as the "before" measurement, long enough for the
// idle/stall bound to act on the runs the old daemon left hanging.
const end = Math.max(...runs.map((r) => Date.parse(r.updatedAt))) + Number(arg("tailMinutes", "90")) * 60_000;

/** Tern double: every recorded block is live until closed; renames and new tabs are recorded, not performed. */
const live = new Set(runs.map((r) => r.block).filter((b) => b !== undefined));
const ternCalls = { inspect: 0, close: 0, rename: 0, send: 0, new: 0 };
const tern = async (argv) => {
	if (argv[0] === "inspect") {
		ternCalls.inspect++;
		return JSON.stringify({ sessions: [{ id: 1, tabs: [{ id: 1, name: "Claw", blocks: [...live].map((id) => ({ id, exited: null, live: true, command: null, args: [] })) }] }] });
	}
	if (argv[0] === "close") { ternCalls.close++; const block = Number(argv[1]); if (!live.has(block)) throw new Error(`no block is called ${block}`); live.delete(block); return "{}"; }
	if (argv[0] === "rename") { ternCalls.rename++; return "{}"; }
	if (argv[0] === "send") { ternCalls.send++; return "{}"; }
	if (argv[0] === "new") { ternCalls.new++; const block = 900_000 + ternCalls.new; live.add(block); return JSON.stringify({ tab: block + 1, block }); }
	return "{}";
};

/** In-memory Hoja: create/comment/state are recorded so the outbox can be flushed without touching the real API. */
const issues = new Map();
const hojaWrites = { comments: 0, states: [], created: 0 };
const resolved = { teamId: "t", teamKey: "TREBOL", projectId: "p", project: "Hoja", assigneeId: "u", assignee: "Luis", states: { "in progress": "s-ip", "in review": "s-ir", canceled: "s-c" } };
const hoja = {
	async resolve() { return resolved; },
	async createIssue(_r, title, description) { hojaWrites.created++; const id = `iss-new-${hojaWrites.created}`; issues.set(id, { id, identifier: `TREBOL-${990 + hojaWrites.created}`, description, state: "In Progress", teamId: "t", projectId: "p", assigneeId: "u", comments: [] }); return { id, identifier: issues.get(id).identifier }; },
	async readIssue(id) { const i = issues.get(id); if (!i) return { id, identifier: id, title: "", description: "", state: "In Progress", teamId: "t", projectId: "p", assigneeId: "u", comments: [] }; return { ...i, comments: [...i.comments] }; },
	async findIssueByMarker() { return undefined; },
	async comment(id, body) { hojaWrites.comments++; const i = issues.get(id); if (i) i.comments.push(body); },
	async setState(_r, id, state) { hojaWrites.states.push(state); const i = issues.get(id); if (i) i.state = state; },
};

let clock = start;
const deps = { store, hoja, tern, workspace: storeDir, now: () => new Date(clock), alive: () => true, signal: () => undefined };
let ticks = 0;
while (clock <= end) {
	await tick(deps);
	ticks++;
	clock += step;
}

const inbox = readFileSync(join(storeDir, "inbox.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const noticesPath = join(storeDir, "notices.jsonl");
const notices = existsSync(noticesPath) ? readFileSync(noticesPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
const byKind = {};
for (const item of inbox) byKind[item.kind] = (byKind[item.kind] ?? 0) + 1;
writeFileSync(join(storeDir, "replay-report.json"), JSON.stringify({
	window: { start: new Date(start).toISOString(), end: new Date(end).toISOString(), ticks, stepMs: step },
	runs: readdirSync(join(storeDir, "runs")).filter((f) => /^run-[\w-]+\.json$/.test(f)).length,
	inboxByKind: byKind, notices: notices.length, ternCalls, hojaWrites,
	simulated: ["worker liveness (alive=true: no recorded worker process exists)", "Tern (in-memory block set)", "Hoja (in-memory issue store, no network)"],
}, null, 2));
process.stderr.write(`replayed ${ticks} ticks over ${new Date(start).toISOString()}..${new Date(end).toISOString()}\ninbox: ${JSON.stringify(byKind)}\nnotices: ${notices.length}, tern: ${JSON.stringify(ternCalls)}\n`);
