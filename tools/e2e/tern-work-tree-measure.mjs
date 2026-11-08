#!/usr/bin/env -S node --experimental-strip-types
/**
 * Measures the collapsed work transcript in Tern itself: drives the real PiTernBridge with the events of one
 * realistic turn, replays its frames into a headless `tern serve`, then reports what the terminal actually
 * painted — one row per element, its text, glyph and rule counts, the card's box and the visible controls.
 *
 *   node tools/e2e/tern-work-tree-measure.mjs [--json] [--size=1100x900] [--live]
 *
 * Exit 1 when the work card is absent, so a green run means Tern really rendered it.
 */
import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiTernBridge } from "../../.pi/lib/tern/bridge.ts";
import { TERN_WORK_CSS } from "../../.pi/lib/tern/work-style.ts";

const TERN = process.env.TERN_BIN ?? "tern";
const verbose = process.argv.includes("--verbose");
const step = (message) => { if (verbose) process.stderr.write(`[measure] ${message}\n`); };
const text = (s) => ({ type: "text", text: s });
const listeners = new Set();
const session = {
	state: {},
	subscribe: (listener) => (listeners.add(listener), () => listeners.delete(listener)),
	prompt: () => new Promise(() => {}),
	abort: async () => {},
	dispose() {},
	sessionManager: { getSessionId: () => "work-tree-measure", getEntries: () => [], getBranch: () => [], getCwd: () => process.cwd() },
};
const emit = (event) => { for (const listener of [...listeners]) listener(event); };

const writes = [];
const bridge = new PiTernBridge(session, { write: (data) => writes.push(data), surfaceId: "pi", credits: 1_000_000 });
bridge.start("pi");
// Expanded mirrors Ctrl+O (every step body visible); --live stops before the turn settles.
bridge.toggleToolOutput();

emit({ type: "agent_start" });
emit({ type: "message_start", message: { role: "user", content: [text("Fix the flaky login test and verify it")] } });
emit({ type: "message_start", message: { role: "assistant", content: [] } });
emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Looking at the failing test first." } });
emit({ type: "message_end", message: { role: "assistant", content: [text("Looking at the failing test first.")], stopReason: "toolUse" } });
emit({ type: "tool_execution_start", toolCallId: "s1", toolName: "read", args: { path: "src/auth/login.test.ts" } });
emit({ type: "tool_execution_end", toolCallId: "s1", toolName: "read", result: { content: [text("export function login(user) { /* ... */ }")], details: { duration_ms: 480 } }, isError: false });

const LONG = "pnpm exec vitest run src/auth/login.test.ts src/auth/session.test.ts --reporter=verbose --coverage.enabled=false --pool=forks --testTimeout=20000";
emit({ type: "tool_execution_start", toolCallId: "s2", toolName: "bash", args: { command: LONG, description: "Run the login tests" } });
emit({ type: "tool_execution_update", toolCallId: "s2", partialResult: { content: [text(" RUN  v1.6.0\n ✓ src/auth/login.test.ts (3 tests) 412ms\n   ✗ keeps the session alive\n")] } });
emit({ type: "tool_execution_end", toolCallId: "s2", toolName: "bash", result: { content: [text("1 failed | 2 passed")], details: { exit_code: 1, duration_ms: 3800 } }, isError: true });

emit({ type: "tool_execution_start", toolCallId: "s3", toolName: "apply_patch", args: { input: [
	"*** Begin Patch",
	"*** Update File: src/auth/login.ts",
	"@@ export function login(user) {",
	"   const session = open(user);",
	"-  calls++;",
	"+  calls = 1;",
	"   return session;",
	" }",
	"*** End Patch",
].join("\n") } });
emit({ type: "tool_execution_end", toolCallId: "s3", toolName: "apply_patch", result: { content: [text("1 file changed")], details: { duration_ms: 640 } }, isError: false });

emit({ type: "tool_execution_start", toolCallId: "s4", toolName: "TaskManage", args: { operations: [
	{ key: "a", op: "create", subject: "Fix the flaky login test" },
	{ key: "b", op: "update", taskId: "7", status: "in_progress" },
] } });
emit({ type: "tool_execution_end", toolCallId: "s4", toolName: "TaskManage", result: { content: [text("2 operations")], details: { batch: { results: [
	{ key: "a", op: "create", status: "ok", data: { task: { id: "4", subject: "Fix the flaky login test", status: "in_progress" } } },
	{ key: "b", op: "update", status: "failed", error: { message: "task #7 is blocked by #3" } },
] } }, details2: undefined }, isError: false });

emit({ type: "tool_execution_start", toolCallId: "s5", toolName: "bash", args: { command: "npm test -- login", description: "Re-run the login tests" } });
if (process.argv.includes("--live")) {
	emit({ type: "tool_execution_update", toolCallId: "s5", partialResult: { content: [text(" RUN  v1.6.0\n ✓ src/auth/login.test.ts\n")] } });
} else {
	emit({ type: "tool_execution_end", toolCallId: "s5", toolName: "bash", result: { content: [text("3 passed")], details: { exit_code: 0, duration_ms: 3400 } }, isError: false });
	emit({ type: "message_start", message: { role: "assistant", content: [] } });
	emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Fixed: the session counter was incremented twice." } });
	emit({ type: "message_end", message: { role: "assistant", content: [text("Fixed: the session counter was incremented twice.")], stopReason: "stop" } });
	emit({ type: "agent_end" });
}

const dir = mkdtempSync(join(tmpdir(), "tern-work-tree-"));
const sock = join(dir, "ctl.sock");
const rec = join(dir, "frames.jsonl");
const cssFile = join(dir, "work.css");
let child;
const keep = process.argv.includes("--keep");
const cleanup = () => { child?.kill(); if (!keep) rmSync(dir, { recursive: true, force: true }); };
process.on("exit", cleanup);

const lines = [];
let t = 0;
for (const write of writes) {
	for (const hit of write.matchAll(/\x1b_tsp;([A-Za-z]);([\s\S]*?)\x1b\\/g)) {
		try { lines.push(JSON.stringify({ t: (t += 16), dir: "out", verb: hit[1], body: JSON.parse(hit[2]) })); } catch { /* not a frame */ }
	}
}
writeFileSync(rec, lines.join("\n") + "\n");
writeFileSync(cssFile, TERN_WORK_CSS);

child = spawn(TERN, ["serve", "--control", sock], { cwd: dir, stdio: "ignore", detached: true });
const deadline = Date.now() + 30_000;
while (!existsSync(sock)) {
	if (Date.now() > deadline) throw new Error("tern serve did not open its control socket");
	execFileSync("sleep", ["0.05"]);
}
function ctl(command) {
	step(`ctl ${command.slice(0, 80)}`);
	const raw = execFileSync(TERN, ["ctl", "--control", sock, command], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 30_000 });
	step(`ctl ok ${command.slice(0, 40)}`);
	const reply = JSON.parse(raw);
	if (reply.ok !== true) throw new Error(`tern ctl ${command}: ${reply.error ?? "failed"}`);
	return reply;
}

const size = (process.argv.find((a) => a.startsWith("--size=")) ?? "--size=1100x900").slice("--size=".length).split("x");
ctl(`resize ${size[0]} ${size[1]}`);
ctl(`surface-play "${rec}"`);
ctl(`css work ${cssFile}`);
ctl("wait 600");

const nodes = (selector) => ctl(`tree ${selector}`).nodes ?? [];
const styleOf = (selector) => (ctl(`dump ${selector}`).elements ?? [])[0] ?? null;
const textOf = (selector) => nodes(selector).map((node) => node.text).filter((value) => typeof value === "string" && value !== "");

const card = nodes("[data-role='tern.work'], [data-role='tern.work-live']")[0];
if (!card) {
	console.error("FAIL: Tern painted no work card");
	cleanup();
	process.exit(1);
}
const hrStyle = styleOf(".sf-tool-hr");
const summary = {
	card: { rect: card.rect, text: card.text ?? "" },
	// Head x positions: the card at the left, its steps indented under it (the tree reads without rules).
	lefts: nodes(".sf-tool").map((node) => node.rect?.[0] ?? null),
	textLefts: { verbs: nodes(".sf-tool-title").map((node) => node.rect?.[0] ?? null), notes: nodes("[data-role='tern.work-note']").map((node) => node.rect?.[0] ?? null) },
	counts: {
		tools: nodes(".sf-tool").length,
		icons: nodes(".sf-tool-ic").length,
		rules: nodes(".sf-tool-hr").length,
		bars: nodes(".sf-tool-bar").length,
		buttons: nodes("[data-role='tern.work'] button, [data-role='tern.work-live'] button").length,
		hoverActions: nodes(".sf-tool-acts button").length,
		timers: nodes(".sf-tool-time").length,
		chevrons: nodes(".sf-chev").length,
		stepsRunning: nodes(".sf-tool.st-running").length,
		stepsError: nodes(".sf-tool.st-error").length,
	},
	rows: {
		verbs: textOf(".sf-tool-title"),
		targets: textOf(".sf-tool-target"),
		times: textOf(".sf-tool-time"),
	},
	ruleStyle: hrStyle ? { border: hrStyle.borderTopWidth ?? null, height: hrStyle.height ?? null } : null,
	controls: nodes("[data-role='tern.work'] button, [data-role='tern.work-live'] button").map((node) => node.text ?? ""),
	shot: (() => { try { return ctl(process.argv.includes("--live") ? "shot work-tree-live" : "shot work-tree"); } catch { return null; } })(),
};
console.log(process.argv.includes("--json") ? JSON.stringify(summary, null, 2) : `work card ${JSON.stringify(summary, null, 2)}`);
// Keep the visual next to the numbers so a reviewer can judge the tree, not only its counts.
if (summary.shot?.png) copyFileSync(join(dir, summary.shot.png), join(process.cwd(), "artifacts", process.argv.includes("--live") ? "work-tree-live.png" : "work-tree.png"));
if (keep) process.stderr.write(`[measure] kept ${dir}\n`);
process.exit(0);
