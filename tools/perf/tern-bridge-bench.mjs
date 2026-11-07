#!/usr/bin/env node
// Tern bridge cost on a real or synthetic session, outside vitest so it can run under resource limits:
//   node tools/perf/tern-bridge-bench.mjs <session.jsonl>        resume a real Pi session
//   node tools/perf/tern-bridge-bench.mjs --turns 1000           synthetic session
//   systemd-run --user --scope -p CPUQuota=25% node --max-old-space-size=96 tools/perf/tern-bridge-bench.mjs …
// Prints one JSON line: resume ms, first-frame bytes, heap, keystroke median/p95/max, bytes per key, and the
// cost of one streamed delta on the open turn.
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { PiTernBridge } from "../../.pi/lib/tern/bridge.ts";

const args = process.argv.slice(2);
const turnsAt = args.indexOf("--turns");
const keys = Number(process.env.KEYS ?? 200);

function branchFromJsonl(path) {
	const byId = new Map();
	let leaf;
	for (const line of readFileSync(path, "utf8").split("\n")) {
		if (!line) continue;
		const entry = JSON.parse(line);
		if (typeof entry.id !== "string") continue;
		byId.set(entry.id, entry);
		leaf = entry;
	}
	const branch = [];
	for (let e = leaf; e; e = e.parentId ? byId.get(e.parentId) : undefined) branch.push(e);
	return branch.reverse();
}

function syntheticBranch(turns) {
	const out = [];
	let parent = null;
	const push = (message) => { const id = `e${out.length}`; out.push({ type: "message", id, parentId: parent, message }); parent = id; };
	for (let i = 0; i < turns; i++) {
		push({ role: "user", content: [{ type: "text", text: `please fix issue ${i}` }] });
		push({ role: "assistant", content: [{ type: "text", text: `Looking at ${i}.` }, { type: "toolCall", id: `a${i}`, name: "bash", arguments: { command: `rg issue${i}` } }, { type: "toolCall", id: `b${i}`, name: "read", arguments: { path: `f${i}.ts` } }] });
		push({ role: "toolResult", toolCallId: `a${i}`, isError: false, content: [{ type: "text", text: `src/a.ts:${i}: hit\n`.repeat(20) }] });
		push({ role: "toolResult", toolCallId: `b${i}`, isError: false, content: [{ type: "text", text: "line\n".repeat(200) }] });
		push({ role: "assistant", content: [{ type: "text", text: `## Result ${i}\n\n- point one\n- point two\n\n\`\`\`ts\nconst x = ${i};\n\`\`\`\n` }] });
	}
	return out;
}

const t0 = performance.now();
const branch = turnsAt >= 0 ? syntheticBranch(Number(args[turnsAt + 1])) : branchFromJsonl(args[0]);
const parseMs = performance.now() - t0;
global.gc?.();
const heapBefore = process.memoryUsage().heapUsed;

const listeners = new Set();
let written = 0;
const session = {
	subscribe(l) { listeners.add(l); return () => listeners.delete(l); },
	prompt() { return new Promise(() => {}); },
	async abort() {},
	dispose() {},
	sessionManager: { getBranch: () => branch, getSessionId: () => "bench", getCwd: () => process.cwd() },
};
const bridge = new PiTernBridge(session, { write: (d) => { written += d.length; }, surfaceId: "pi", credits: 1e9 });

const r0 = performance.now();
bridge.start();
const resumeMs = performance.now() - r0;
const firstFrameBytes = written;
global.gc?.();
const heapAfter = process.memoryUsage().heapUsed;

let len = 0;
const key = () => { bridge.handle({ verb: "e", body: { ev: "edit", sf: "pi", id: "composer", from: len, to: len, len, cursor: len + 1, text: "x" } }); len++; };
for (let i = 0; i < 20; i++) key();
const times = [];
const before = written;
for (let i = 0; i < keys; i++) { const s = performance.now(); key(); times.push(performance.now() - s); }
const bytesPerKey = (written - before) / keys;
times.sort((a, b) => a - b);

// One open turn streaming text: the per-token cost a long session pays while the agent answers.
const emit = (e) => { for (const l of listeners) l(e); };
emit({ type: "agent_start" });
emit({ type: "message_start", message: { role: "user", content: [{ type: "text", text: "next request" }] } });
emit({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "next request" }] } });
emit({ type: "message_start", message: { role: "assistant", content: [] } });
const deltas = [];
for (let i = 0; i < keys; i++) { const s = performance.now(); emit({ type: "message_update", message: {}, assistantMessageEvent: { type: "text_delta", delta: "word " } }); deltas.push(performance.now() - s); }
deltas.sort((a, b) => a - b);
bridge.close?.();

const items = bridge.items.length;
const q = (xs, p) => +xs[Math.min(xs.length - 1, Math.floor(xs.length * p))].toFixed(3);
console.log(JSON.stringify({
	source: turnsAt >= 0 ? `synthetic:${args[turnsAt + 1]}` : args[0].split("/").pop(), branchEntries: branch.length, items,
	parseMs: +parseMs.toFixed(0), resumeMs: +resumeMs.toFixed(1), firstFrameKB: Math.round(firstFrameBytes / 1024),
	bridgeHeapMB: +((heapAfter - heapBefore) / 1048576).toFixed(1), rssMB: Math.round(process.memoryUsage().rss / 1048576),
	keyMedianMs: q(times, 0.5), keyP95Ms: q(times, 0.95), keyMaxMs: q(times, 1), bytesPerKey: Math.round(bytesPerKey),
	deltaMedianMs: q(deltas, 0.5), deltaP95Ms: q(deltas, 0.95),
}));
process.exit(0);
