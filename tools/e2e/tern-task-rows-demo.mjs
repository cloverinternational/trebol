#!/usr/bin/env -S node --experimental-strip-types
/**
 * Visual harness for the task popover's rows mode, not an assertion test: it drives the real
 * PiTernBridge against a seeded `pi-swarm-task-state` entry and writes TSP to its own terminal, so
 * Tern renders the actual tree. Run it inside a Tern pane:
 *
 *   tern new tab --cwd "$PWD" --keep-open -- sh -c 'TERN_TASK_ROWS_DEMO=1 node tools/e2e/tern-task-rows-demo.mjs'
 *   tern ctl css e2e-pin /tmp/pin.css   # pins the hover popover open for the shot
 *   tern ctl shot task-rows
 *
 * The popover is always in the tree and only its visibility is the stylesheet's business, so the
 * pin sheet changes nothing the bridge draws. MODE=list|board|graph picks the layout (default graph).
 */
import { PiTernBridge } from "../../.pi/lib/tern/bridge.ts";
import { helloQuery, splitInput } from "../../.pi/lib/tern/tsp.ts";

const listeners = new Set();
const base = { priority: "medium", dependsOn: [], notes: [], createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" };
const taskState = {
	type: "custom",
	customType: "pi-swarm-task-state",
	data: {
		schemaVersion: 2, revision: 1, savedAt: "2026-01-01T00:00:00Z", nextId: 6, keys: {}, tasks: [
			{ ...base, id: "1", subject: "Recover the old Agent-MCP visualisation", status: "completed",
				questions: [{ id: "where", text: "Which commit holds the graph?" }],
				answers: [{ question: "where", evidence: "artifacts/agent-mcp-old-viz.notes.md#Provenance, tool:Bash#5" }] },
			{ ...base, id: "2", subject: "Draw the example SVG", status: "completed",
				questions: [{ id: "size", text: "Do the sizes follow the code?" }],
				answers: [{ question: "size", evidence: "artifacts/agent-mcp-old-viz.svg" }] },
			{ ...base, id: "3", subject: "Add a Tern work/tasks view", status: "in_progress", active: true,
				questions: [
					{ id: "schema", text: "What shape does TaskManage really store?" },
					{ id: "sizes", text: "How big are answers and evidence?" },
					{ id: "design", text: "Where does the graph mount in Tern?" },
				],
				answers: [{ question: "schema", answer: "snapshots, not the tool result", evidence: "artifacts/taskmanage-schema-report.md#3. Real Task model (from `pi-swarm-task-state`)" }] },
			{ ...base, id: "4", subject: "E2E verify in a live pane", status: "in_progress", dependsOn: ["3"],
				questions: [{ id: "shot", text: "Does a screenshot show the tree?" }] },
			{ ...base, id: "5", subject: "Promote the graph to a full sheet", status: "pending",
				questions: [{ id: "scope", text: "Sheet or popover?" }] },
		],
	},
};

const session = {
	state: {},
	subscribe(l) { listeners.add(l); return () => listeners.delete(l); },
	prompt: () => new Promise(() => {}),
	abort: async () => {},
	dispose() {},
	sessionManager: { getSessionId: () => "task-graph-demo", getEntries: () => [taskState], getBranch: () => [taskState], getCwd: () => process.cwd() },
	model: { provider: "anthropic", id: "opus" },
};

if (process.env.TERN_TASK_ROWS_DEMO !== "1") {
	console.error("Visual harness: open it in its own Tern tab, TERN_TASK_ROWS_DEMO=1 node tools/e2e/tern-task-rows-demo.mjs");
	process.exit(2);
}
const restoreTerminal = () => { try { process.stdin.setRawMode(false); } catch { /* not a tty */ } };
process.on("exit", restoreTerminal);
process.on("SIGTERM", () => { restoreTerminal(); process.exit(0); });
process.on("SIGINT", () => { restoreTerminal(); process.exit(0); });

process.stdin.setRawMode(true);
process.stdin.resume();
let pending = "";
let bridge;


process.stdin.on("data", (chunk) => {
	const parsed = splitInput(pending + chunk.toString());
	pending = parsed.rest;
	for (const msg of parsed.messages) {
		if (!bridge && msg.verb === "r" && Array.isArray(msg.body.kinds)) {
			bridge = new PiTernBridge(session, { write: (d) => process.stdout.write(d), surfaceId: "pi", credits: Number(msg.body.credits) || 2, kinds: msg.body.kinds });
			bridge.start("pi");
			continue;
		}
		bridge?.handle(msg);
	}
});

process.stdout.write(helloQuery("pi"));
setInterval(() => {}, 1 << 30);
