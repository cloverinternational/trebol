#!/usr/bin/env -S node --experimental-strip-types
/**
 * Visual harness for the Tern git panel, not an assertion test: it drives the real PiTernBridge against a
 * real git worktree (GIT_DEMO_CWD) with a fake session, opens the panel, and writes TSP to its own terminal.
 *
 *   tern new tab --cwd "$PWD" --keep-open -- sh -c \
 *     'TERN_GIT_DEMO=1 GIT_DEMO_CWD=/tmp/git-demo node tools/e2e/tern-git-panel-demo.mjs'
 *   tern focus <block>
 *   tern ctl shot git-panel
 *
 * HELP=1 opens the key sheet; UNIFIED=1 starts in unified instead of split.
 */
import { PiTernBridge } from "../../.pi/lib/tern/bridge.ts";
import { keyEffect } from "../../.pi/lib/tern/keys.ts";
import { helloQuery, splitInput } from "../../.pi/lib/tern/tsp.ts";
import { StdinBuffer } from "@earendil-works/pi-tui";

const cwd = process.env.GIT_DEMO_CWD;
if (process.env.TERN_GIT_DEMO !== "1" || !cwd) {
	console.error("Visual harness: run it in its own Tern tab with TERN_GIT_DEMO=1 and GIT_DEMO_CWD=<repo>");
	process.exit(2);
}

const listeners = new Set();
const session = {
	state: {},
	subscribe(l) { listeners.add(l); return () => listeners.delete(l); },
	prompt: () => new Promise(() => {}),
	abort: async () => {},
	dispose() {},
	sessionManager: { getSessionId: () => "git-demo", getEntries: () => [], getBranch: () => [], getCwd: () => cwd },
	model: { provider: "anthropic", id: "opus" },
};

let bridge;
const keyBuffer = new StdinBuffer();
keyBuffer.on("data", (sequence) => {
	const effect = keyEffect(sequence);
	if (effect && bridge?.applyGitKey(effect)) return;
});
keyBuffer.on("paste", (text) => {
	bridge?.applyGitPaste(text);
});
const restoreTerminal = () => { try { process.stdin.setRawMode(false); } catch { /* not a tty */ } };
process.on("exit", restoreTerminal);
process.on("SIGTERM", () => { restoreTerminal(); process.exit(0); });
process.on("SIGINT", () => { restoreTerminal(); process.exit(0); });

process.stdin.setRawMode(true);
process.stdin.resume();
let pending = "";
process.stdin.on("data", (chunk) => {
	const parsed = splitInput(pending + chunk.toString());
	pending = parsed.rest;
	keyBuffer.process(parsed.keys);
	for (const msg of parsed.messages) {
		if (!bridge && msg.verb === "r" && Array.isArray(msg.body.kinds)) {
			bridge = new PiTernBridge(session, { write: (d) => process.stdout.write(d), surfaceId: "pi", credits: Number(msg.body.credits) || 2, kinds: msg.body.kinds });
			bridge.start("pi");
			setTimeout(() => {
				bridge.handle({ verb: "e", body: { ev: "action", sf: "pi", act: "git.open" } });
				if (process.env.UNIFIED === "1") {
					bridge.handle({ verb: "e", body: { ev: "select", sf: "pi", id: "git-diff-mode", item: "unified" } });
				}
				if (process.env.HELP === "1") {
					bridge.handle({ verb: "e", body: { ev: "action", sf: "pi", act: "git.help" } });
				}
			}, 300);
			continue;
		}
		bridge?.handle(msg);
	}
});
process.stdout.write(helloQuery("pi"));
setTimeout(() => process.exit(0), Number(process.env.LIFETIME_MS ?? 180_000));
setInterval(() => {}, 1_000);
