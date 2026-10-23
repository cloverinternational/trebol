#!/usr/bin/env -S node --experimental-strip-types
/**
 * Visual harness for the live work card, not an assertion test: it drives the real PiTernBridge with the events a
 * real session emits (a fake session object, so no model, provider or SDK is involved) and writes TSP to its own
 * terminal. Run it inside a Tern pane to look at the card:
 *
 *   tern new tab --cwd "$PWD" --keep-open -- sh -c 'TERN_LIVE_DEMO=1 node tools/e2e/tern-live-work-demo.mjs'
 *   tern focus <block>            # show the tab
 *   tern ctl shot work-live       # target/shots/tern/live/work-live.png
 *
 * EXPAND=1 mirrors Ctrl+O (every step open); SPEED=2 slows the scripted turn down for a mid-run look.
 * Everything it asserts is in .pi/test/tern/work-table.test.ts and turn-work.test.ts; this only renders.
 */
import { PiTernBridge } from "../../.pi/lib/tern/bridge.ts";
import { helloQuery, splitInput } from "../../.pi/lib/tern/tsp.ts";
import { removeRunningWork, setRunningWork } from "../../.pi/lib/ui/running-work-store.ts";

const listeners = new Set();
const session = {
	state: {},
	subscribe(l) { listeners.add(l); return () => listeners.delete(l); },
	prompt: () => new Promise(() => {}),
	abort: async () => {},
	dispose() {},
	sessionManager: { getSessionId: () => "demo", getEntries: () => [], getBranch: () => [], getCwd: () => process.cwd() },
	model: { provider: "anthropic", id: "opus" },
};
const emit = (e) => { for (const l of [...listeners]) l(e); };
let bridge;
// It takes over the terminal it runs in (raw input, TSP surface), so it needs an explicit opt-in from the tab you
// opened for it and gives the terminal back on any exit. Without the opt-in it does nothing at all.
if (process.env.TERN_LIVE_DEMO !== "1") {
	console.error("Visual harness: open it in its own Tern tab, TERN_LIVE_DEMO=1 node tools/e2e/tern-live-work-demo.mjs");
	process.exit(2);
}
const restoreTerminal = () => { try { process.stdin.setRawMode(false); } catch { /* not a tty */ } };
process.on("exit", restoreTerminal);
process.on("SIGTERM", () => { restoreTerminal(); process.exit(0); });
process.on("SIGINT", () => { restoreTerminal(); process.exit(0); });
// Probe Tern, then speak TSP with the credits it grants and hand every terminal event back to the bridge.
process.stdin.setRawMode(true);
process.stdin.resume();
let pending = "";
process.stdin.on("data", (chunk) => {
	const parsed = splitInput(pending + chunk.toString());
	pending = parsed.rest;
	for (const msg of parsed.messages) {
		if (!bridge && msg.verb === "r" && Array.isArray(msg.body.kinds)) {
			bridge = new PiTernBridge(session, { write: (d) => process.stdout.write(d), surfaceId: "pi", credits: Number(msg.body.credits) || 2, kinds: msg.body.kinds });
			bridge.start("pi");
			// EXPAND=1 mirrors Ctrl+O: every card opens with its steps and bodies.
			if (process.env.EXPAND === "1") bridge.toggleToolOutput();
			void run();
			continue;
		}
		bridge?.handle(msg);
	}
});
process.stdout.write(helloQuery("pi"));
const scale = Number(process.env.SPEED ?? 1);
const wait = (ms) => new Promise((r) => setTimeout(r, ms * scale));
async function run() {
const text = (s) => ({ type: "text", text: s });

emit({ type: "agent_start" });
emit({ type: "message_start", message: { role: "user", content: [text("Fix the flaky login test and verify it")] } });
emit({ type: "message_start", message: { role: "assistant", content: [] } });
emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Looking at the failing test first." } });
emit({ type: "message_end", message: { role: "assistant", content: [text("Looking at the failing test first.")], stopReason: "toolUse" } });
await wait(400);

emit({ type: "tool_execution_start", toolCallId: "s1", toolName: "read", args: { path: "src/auth/login.test.ts" } });
await wait(500);
emit({ type: "tool_execution_end", toolCallId: "s1", toolName: "read", result: { content: [text("export function login(user) { /* ... */ }")] }, isError: false });
await wait(300);

const LONG = "pnpm exec vitest run src/auth/login.test.ts src/auth/session.test.ts --reporter=verbose --coverage.enabled=false --pool=forks --poolOptions.forks.singleFork --testTimeout=20000 --bail=0 2>&1 | tee /tmp/login-tests.log";
emit({ type: "tool_execution_start", toolCallId: "s2", toolName: "bash", args: { command: LONG, description: "Run the login tests" } });
for (const line of ["", "> vitest run -- login", "", " RUN  v1.6.0", "", " ✓ src/auth/login.test.ts (3 tests) 412ms", "   ✓ rejects an empty password", "   ✗ keeps the session alive (expected 1 call, got 2)", "   ✓ trims the user name", ""]) {
	await wait(220);
	emit({ type: "tool_execution_update", toolCallId: "s2", partialResult: { content: [text(line + "\n")] } });
}
await wait(400);
emit({ type: "tool_execution_end", toolCallId: "s2", toolName: "bash", result: { content: [text("1 failed | 2 passed")], details: { exit_code: 1, duration_ms: 3800 } }, isError: true });
await wait(400);
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
await wait(900);
emit({ type: "tool_execution_end", toolCallId: "s3", toolName: "apply_patch", result: { content: [text("1 file changed")] }, isError: false });
await wait(400);
// A running subagent (the background card's `agent` row) and a TaskManage batch (a checklist) beside it.
setRunningWork({ id: "demo-agent", kind: "subagent", label: "Agent demo-agent", status: "running", startedAt: Date.now() - 12_000, detail: "Review the parser and report smells", tokens: 18_400 });
emit({ type: "tool_execution_start", toolCallId: "s4", toolName: "TaskManage", args: { operations: [
	{ key: "a", op: "create", subject: "Fix the flaky login test" },
	{ key: "b", op: "create", subject: "Re-run the suite and attach evidence" },
	{ key: "c", op: "update", taskId: "7", status: "in_progress" },
] } });
await wait(700);
emit({ type: "tool_execution_end", toolCallId: "s4", toolName: "TaskManage", result: { content: [text("3 operations")], details: { batch: { results: [
	{ key: "a", op: "create", status: "ok", data: { task: { id: "4", subject: "Fix the flaky login test", status: "in_progress" } } },
	{ key: "b", op: "create", status: "ok", data: { task: { id: "5", subject: "Re-run the suite and attach evidence", status: "pending" } } },
	{ key: "c", op: "update", status: "failed", error: { message: "task #7 is blocked by #3" } },
] } } }, isError: false });
removeRunningWork("demo-agent");
await wait(400);
emit({ type: "tool_execution_start", toolCallId: "s5", toolName: "bash", args: { command: "npm test -- login", description: "Re-run the login tests" } });
await wait(700);
emit({ type: "tool_execution_end", toolCallId: "s5", toolName: "bash", result: { content: [text("3 passed")], details: { exit_code: 0, duration_ms: 3400 } }, isError: false });
await wait(300);
emit({ type: "message_start", message: { role: "assistant", content: [] } });
emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Fixed: the session counter was incremented twice, so the test now passes." } });
emit({ type: "message_end", message: { role: "assistant", content: [text("Fixed: the session counter was incremented twice, so the test now passes.")], stopReason: "stop" } });
emit({ type: "agent_end" });
}
// Never outlive the look: a bounded lifetime, so a forgotten tab cannot linger.
setTimeout(() => process.exit(0), Number(process.env.LIFETIME_MS ?? 180_000));
setInterval(() => {}, 1_000);
