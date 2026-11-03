#!/usr/bin/env -S node --experimental-strip-types
/**
 * Visual harness for the /tree session picker and for Edit/Resend on your messages, not an assertion test: it opens
 * a temp COPY of a real session file with Pi's own SessionManager and drives the real PiTernBridge, so the pane shows
 * real entries, forks and hook noise. navigateTree branches the copy by AgentSession's rule for a user entry (leaf =
 * parent) and prompt appends the prompt plus a canned reply, so no model runs and the original file is untouched.
 * Run it in a Tern pane:
 *
 *   tern new tab --cwd "$PWD" --keep-open -- sh -c 'TERN_LIVE_DEMO=1 SESSION=<file.jsonl> node --experimental-strip-types tools/e2e/tern-tree-demo.mjs'
 *   tern ctl shot tree-live       # target/shots/tern/live/tree-live.png
 *
 * FILTER=<no-tools|user|default|labeled|all> picks the opening tab; OPEN=chat skips /tree and shows the transcript.
 * Assertions live in .pi/test/tern/session-tree.test.ts and message-actions.test.ts.
 */
import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { PiTernBridge } from "../../.pi/lib/tern/bridge.ts";
import { helloQuery, splitInput } from "../../.pi/lib/tern/tsp.ts";

if (process.env.TERN_LIVE_DEMO !== "1" || !process.env.SESSION) {
	console.error("Visual harness: TERN_LIVE_DEMO=1 SESSION=<session.jsonl> node --experimental-strip-types tools/e2e/tern-tree-demo.mjs");
	process.exit(2);
}
const copy = join(mkdtempSync(join(tmpdir(), "tern-demo-")), "session.jsonl");
copyFileSync(process.env.SESSION, copy);
const manager = SessionManager.open(copy);
const listeners = new Set();
const emit = (e) => { for (const l of [...listeners]) l(e); };
const session = {
	state: {},
	subscribe: (l) => { listeners.add(l); return () => listeners.delete(l); },
	prompt: async (text, opts) => {
		emit({ type: "agent_start" });
		manager.appendMessage({ role: "user", content: [{ type: "text", text }, ...(opts?.images ?? [])], timestamp: Date.now() });
		manager.appendMessage({ role: "assistant", content: [{ type: "text", text: `(demo reply to: ${text.slice(0, 60)})` }], api: "demo", provider: "demo", model: "demo", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() });
		emit({ type: "session_tree" });
		emit({ type: "agent_end" });
	},
	abort: async () => {},
	dispose() {},
	sessionManager: { getSessionId: () => "tree-demo", getEntries: () => manager.getEntries(), getBranch: () => manager.getBranch(), getEntry: (id) => manager.getEntry(id), getCwd: () => process.cwd(), getTree: () => manager.getTree(), getLeafId: () => manager.getLeafId(), getSessionName: () => manager.getSessionName() },
	navigateTree: async (id) => {
		const target = manager.getEntry(id);
		if (target?.type === "message" && target.message.role === "user") { if (target.parentId) manager.branch(target.parentId); else manager.resetLeaf(); }
		else manager.branch(id);
		emit({ type: "session_tree" });
		return { cancelled: false };
	},
	model: { provider: "anthropic", id: "opus" },
};
const restoreTerminal = () => { try { process.stdin.setRawMode(false); } catch { /* not a tty */ } };
process.on("exit", restoreTerminal);
process.on("SIGTERM", () => { restoreTerminal(); process.exit(0); });
process.stdin.setRawMode(true);
process.stdin.resume();
let bridge;
let pending = "";
process.stdin.on("data", (chunk) => {
	const parsed = splitInput(pending + chunk.toString());
	pending = parsed.rest;
	for (const msg of parsed.messages) {
		if (!bridge && msg.verb === "r" && Array.isArray(msg.body.kinds)) {
			bridge = new PiTernBridge(session, { write: (d) => process.stdout.write(d), surfaceId: "pi", credits: Number(msg.body.credits) || 2, kinds: msg.body.kinds });
			bridge.start("pi");
			if (process.env.OPEN === "chat") continue;
			bridge.setDraft("/tree");
			void bridge.submitDraft().then(() => {
				if (process.env.FILTER) bridge.handle({ verb: "e", body: { ev: "action", sf: "pi", id: "session-tree-picker", act: "tab", value: process.env.FILTER } });
			});
			continue;
		}
		bridge?.handle(msg);
	}
});
process.stdout.write(helloQuery("pi"));
