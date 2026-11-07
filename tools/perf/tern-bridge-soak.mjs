#!/usr/bin/env node
// Long-run soak: drives one live bridge through hours' worth of use and samples cost and retained heap as it
// goes. Anything that grows with runtime shows up as a rising column.
//   node --expose-gc tools/perf/tern-bridge-soak.mjs [turns=2000]
// Each turn: a user request, a bash step streaming 40 growing updates, a read, a streamed answer, and typing.
// Every 25th turn runs a noisy command (4 MB of output over 200 updates). A final phase streams one command
// for 20 000 updates, as a build or log tail left running for hours would.
import { performance } from "node:perf_hooks";
import { PiTernBridge } from "../../.pi/lib/tern/bridge.ts";

const turns = Number(process.argv[2] ?? 2000);
const listeners = new Set();
let written = 0;
const session = {
	subscribe(l) { listeners.add(l); return () => listeners.delete(l); },
	prompt() { return new Promise(() => {}); }, async abort() {}, dispose() {},
	sessionManager: { getBranch: () => [], getSessionId: () => "soak", getCwd: () => "/nonexistent-soak" },
};
const bridge = new PiTernBridge(session, { write: (d) => { written += d.length; }, surfaceId: "pi", credits: 1e9 });
bridge.start();
const emit = (e) => { for (const l of listeners) l(e); };
let len = 0;
const key = () => { bridge.handle({ verb: "e", body: { ev: "edit", sf: "pi", id: "composer", from: len, to: len, len, cursor: len + 1, text: "x" } }); len++; };
const clear = () => { bridge.handle({ verb: "e", body: { ev: "edit", sf: "pi", id: "composer", from: 0, to: len, len, cursor: 0, text: "" } }); len = 0; };
const timed = (fn) => { const t = performance.now(); fn(); return performance.now() - t; };
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return +s[s.length >> 1].toFixed(3); };
const user = (t) => ({ role: "user", content: [{ type: "text", text: t }] });
const text = (t) => [{ type: "text", text: t }];
const line = (i) => `2026-11-07T10:00:00Z INFO worker[${i % 7}] processed batch ${i} in ${i % 97} ms ok\n`;

function turn(i, noisy) {
	emit({ type: "agent_start" });
	emit({ type: "message_start", message: user(`task ${i}`) });
	emit({ type: "message_end", message: user(`task ${i}`) });
	emit({ type: "message_start", message: { role: "assistant", content: [] } });
	emit({ type: "message_update", message: {}, assistantMessageEvent: { type: "toolcall_start" } });
	emit({ type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", id: `b${i}`, name: "bash", arguments: {} }] } });
	emit({ type: "tool_execution_start", toolCallId: `b${i}`, toolName: "bash", args: { command: noisy ? "npm test" : `rg ${i}` } });
	const updates = noisy ? 200 : 40, per = noisy ? 250 : 3;
	let out = "";
	for (let u = 0; u < updates; u++) { for (let k = 0; k < per; k++) out += line(u * per + k); emit({ type: "tool_execution_update", toolCallId: `b${i}`, partialResult: { content: text(out) } }); }
	emit({ type: "tool_execution_end", toolCallId: `b${i}`, toolName: "bash", result: { content: text(out), details: { exit_code: 0, duration_ms: 50 } }, isError: false });
	emit({ type: "tool_execution_start", toolCallId: `r${i}`, toolName: "read", args: { path: `f${i}.ts` } });
	emit({ type: "tool_execution_end", toolCallId: `r${i}`, toolName: "read", result: { content: text("const a = 1;\n".repeat(300)) }, isError: false });
	emit({ type: "message_start", message: { role: "assistant", content: [] } });
	for (let d = 0; d < 30; d++) emit({ type: "message_update", message: {}, assistantMessageEvent: { type: "text_delta", delta: `word${d} ` } });
	emit({ type: "message_end", message: { role: "assistant", content: text("done") } });
	emit({ type: "agent_end" });
	for (let k = 0; k < 10; k++) key();
	clear();
}

const rows = [];
const sample = (at) => {
	global.gc?.(); global.gc?.();
	const keys = []; for (let k = 0; k < 60; k++) keys.push(timed(key)); clear();
	rows.push({ turn: at, keyMs: median(keys), heapMB: +(process.memoryUsage().heapUsed / 1048576).toFixed(1), items: bridge.items.length, wireMB: +(written / 1048576).toFixed(0) });
	console.log(JSON.stringify(rows.at(-1)));
};
sample(0);
const t0 = performance.now();
for (let i = 1; i <= turns; i++) { turn(i, i % 25 === 0); if (i % Math.max(1, turns / 10) === 0) sample(i); }
const runS = (performance.now() - t0) / 1000;

// One command left streaming for hours: does each update get slower as its output grows?
emit({ type: "agent_start" });
emit({ type: "message_start", message: user("tail the logs") });
emit({ type: "message_end", message: user("tail the logs") });
emit({ type: "tool_execution_start", toolCallId: "tail", toolName: "bash", args: { command: "tail -f app.log" } });
let out = "";
const upd = [];
for (let u = 0; u < 20000; u++) {
	out += line(u);
	upd.push(timed(() => emit({ type: "tool_execution_update", toolCallId: "tail", partialResult: { content: text(out) } })));
}
const first = median(upd.slice(0, 500)), last = median(upd.slice(-500));
global.gc?.();
console.log(JSON.stringify({ phase: "long-running command", updates: 20000, outputMB: +(out.length / 1048576).toFixed(1), firstUpdateMs: first, lastUpdateMs: last, heapMB: +(process.memoryUsage().heapUsed / 1048576).toFixed(1) }));
const a = rows[1], z = rows.at(-1);
console.log(JSON.stringify({ summary: true, turns, runS: +runS.toFixed(0), keyMsEarly: a.keyMs, keyMsLate: z.keyMs, heapMBEarly: a.heapMB, heapMBLate: z.heapMB, heapKBPerTurn: +(((z.heapMB - a.heapMB) * 1024) / (z.turn - a.turn)).toFixed(1) }));
bridge.close?.();
process.exit(0);
