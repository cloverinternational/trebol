#!/usr/bin/env -S node --experimental-strip-types
/**
 * Visual harness for the `/context` card, not an assertion test: it drives the real PiTernBridge with a fake
 * session shaped like a live one (a big system prompt with the skills block, a tool roster, a transcript and
 * the provider's reported usage), opens the card the way a click on the composer's context meter does, and
 * writes TSP to its own terminal. Run it inside a Tern pane:
 *
 *   tern new tab --cwd "$PWD" --keep-open -- sh -c 'TERN_CONTEXT_DEMO=1 node tools/e2e/tern-context-card.mjs'
 *   tern focus <block>              # show the tab
 *   tern ctl shot context-card      # target/shots/tern/live/context-card.png
 *
 * ESTIMATE=1 drops the provider's usage, so the card shows its all-estimate state.
 * Everything it asserts is in .pi/test/tern/context-panel.test.ts; this only renders.
 */
import { appendFileSync } from "node:fs";
import { StdinBuffer } from "@earendil-works/pi-tui";
import { PiTernBridge } from "../../.pi/lib/tern/bridge.ts";
import { helloQuery, splitInput } from "../../.pi/lib/tern/tsp.ts";
import { keyEffect } from "../../.pi/lib/tern/keys.ts";

if (process.env.TERN_CONTEXT_DEMO !== "1") {
	console.error("Visual harness: open it in its own Tern tab, TERN_CONTEXT_DEMO=1 node tools/e2e/tern-context-card.mjs");
	process.exit(2);
}

// A realistic window's worth of text: the shape matters, not the words.
const filler = (label, bytes) => `## ${label}\n` + `${label} guidance for the agent. `.repeat(Math.ceil(bytes / 40));
const skills = `<available_skills>\n${["swarm-skill", "loop", "tweets", "tern-ui-rendering", "ui-clickability-audit", "repo-publish-snapshot"]
	.map((name) => `  <skill>\n    <name>${name}</name>\n    <description>${"What this skill covers and when to use it. ".repeat(6)}</description>\n  </skill>\n`)
	.join("")}</available_skills>`;
const systemPrompt = [filler("Mission", 9000), filler("Operating protocol", 6000), skills, filler("Context", 5000)].join("\n");
const tools = ["bash", "read", "edit", "write", "apply_patch", "search", "TaskManage", "hoja_list", "memory_history", "tern"].map((name) => ({
	name,
	description: `${name} — ${"the tool description the model reads, with its usage rules. ".repeat(6)}`,
	parameters: { type: "object", properties: { command: { type: "string" }, timeout_seconds: { type: "number" } }, required: ["command"] },
}));
const messages = [
	{ role: "user", content: [{ type: "text", text: "Port OMP's /context card into the Tern bridge. ".repeat(40) }] },
	{ role: "assistant", content: [{ type: "text", text: "Reading the OMP sources and the bridge. ".repeat(60) }] },
	{ role: "user", content: [{ type: "text", text: "Tool result: 412 lines of source. ".repeat(300) }] },
];

const listeners = new Set();
const session = {
	state: {},
	subscribe(l) { listeners.add(l); return () => listeners.delete(l); },
	prompt: () => new Promise(() => {}),
	abort: async () => {},
	dispose() {},
	sessionManager: { getSessionId: () => "demo", getEntries: () => [], getBranch: () => [], getCwd: () => process.cwd() },
	model: { provider: "anthropic", id: "claude-opus-4", name: "Claude Opus 4", contextWindow: 200_000 },
	systemPrompt,
	agent: { state: { systemPrompt, tools, messages } },
	getContextUsage: () => (process.env.ESTIMATE === "1" ? { tokens: null, contextWindow: 200_000 } : { tokens: 68_400, contextWindow: 200_000 }),
	settingsManager: { getCompactionSettings: () => ({ enabled: true, reserveTokens: 20_000 }) },
	getSessionStats: () => ({ cost: 0.4182 }),
};

const log = (line) => { if (process.env.DEMO_LOG) appendFileSync(process.env.DEMO_LOG, `${line}\n`); };
const restoreTerminal = () => { try { process.stdin.setRawMode(false); } catch { /* not a tty */ } };
process.on("exit", restoreTerminal);
process.on("SIGTERM", () => { restoreTerminal(); process.exit(0); });
process.on("SIGINT", () => { restoreTerminal(); process.exit(0); });
process.stdin.setRawMode(true);
process.stdin.resume();

let bridge;
let pending = "";
// The runner's key path (run.ts): whole key sequences, routed like the real pane, so `/context` can be typed into
// this harness from outside (`tern send <block> /context`).
const keyBuffer = new StdinBuffer();
keyBuffer.on("data", (sequence) => {
	const effect = keyEffect(sequence);
	if (!bridge || !effect) return;
	if (bridge.applyEditKey(effect)) return;
	if (effect.kind === "escape") bridge.escape();
	else if (effect.kind === "submit") void bridge.submitDraft();
	else if (effect.kind === "backspace") bridge.backspaceDraft();
	else if (effect.kind === "text") bridge.appendDraft(effect.text);
});
// Pasted text stays in the draft; embedded newlines do not submit.
keyBuffer.on("paste", (text) => bridge?.pasteText(text));
process.stdin.on("data", (chunk) => {
	const parsed = splitInput(pending + chunk.toString());
	pending = parsed.rest;
	for (const msg of parsed.messages) {
		log(`in ${msg.verb} ${JSON.stringify(msg.body).slice(0, 120)}`);
		if (!bridge && msg.verb === "r" && Array.isArray(msg.body.kinds)) {
			log(`hello credits=${msg.body.credits}`);
			bridge = new PiTernBridge(session, {
				write: (d) => { process.stdout.write(d); log(`write ${d.slice(0, 220)}`); },
				surfaceId: "pi",
				credits: Number(msg.body.credits) || 2,
				kinds: msg.body.kinds,
			});
			bridge.start("pi");
			// A turn in the transcript, so the card floats over real work instead of an empty pane. Timed: Tern
			// only acks (and so only lets frames through) while the tab is focused and drawn.
			setTimeout(() => {
				emit({ type: "agent_start" });
				emit({ type: "message_start", message: { role: "user", content: [{ type: "text", text: "Port OMP's /context card into the Tern bridge" }] } });
				emit({ type: "message_start", message: { role: "assistant", content: [] } });
				emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Read both sources; the split has to anchor on Pi's own total." }], stopReason: "toolUse" } });
				emit({ type: "tool_execution_start", toolCallId: "c1", toolName: "read", args: { path: "artifacts/omp-cli-source/packages/tui/src/status-line/context-usage.ts" } });
				emit({ type: "tool_execution_end", toolCallId: "c1", toolName: "read", result: { content: [{ type: "text", text: "export function computeContextBreakdown(…)" }] }, isError: false });
				emit({ type: "agent_end", messages: [] });
			}, 1200);
			// The two ways in: MODE=click is a click on the composer's context meter (OMP's `status.context`);
			// MODE=command is `/context` typed into the composer and submitted, the runner's own key path.
			setTimeout(() => {
				if (process.env.MODE === "command") {
					log("submitting /context");
					bridge.setDraft("/context");
					void bridge.submitDraft();
				} else {
					log("dispatching status.context");
					bridge.handle({ verb: "e", body: { ev: "action", sf: "pi", act: "status.context", id: "ctx" } });
				}
			}, 2000);
			// A marker the harness can poll before taking its shot: the card's first frame has been drawn by now.
			setTimeout(() => log("opened"), 3200);
			continue;
		}
		bridge?.handle(msg);
	}
	keyBuffer.process(parsed.keys);
});
const emit = (e) => { for (const l of [...listeners]) l(e); };
process.stdout.write(helloQuery("pi"));
