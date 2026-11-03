#!/usr/bin/env -S node --experimental-strip-types
// Fixture-only native rendering: no commands or agents are launched.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BackgroundPanel } from "../../.pi/lib/tern/background-panel.ts";
import { backgroundWorkOutputNodes } from "../../.pi/lib/tern/bridge.ts";
import { TernInlineSurface, parseTspMessages } from "../../.pi/lib/tern/tsp.ts";

const output = resolve("artifacts/background-ui"); mkdirSync(output, { recursive: true });
const transcript = join(output, "fixture-agent.jsonl");
const message = (id, role, content, rest = {}) => JSON.stringify({ id, type: "message", message: { role, content, ...rest } });
writeFileSync(transcript, [
	message("assignment", "user", "Review the parser and verify the edge cases."),
	message("analysis", "assistant", [{ type: "text", text: "## Review progress\n\nThe parser now handles **partial writes** without losing prior entries.\n\n- Checked runtime ownership\n- Added boundary tests\n- Running the focused suite" }]),
	message("call", "assistant", [{ type: "toolCall", name: "Bash", arguments: {} }]),
	message("result", "toolResult", [{ type: "text", text: '{"tests":42,"passed":42,"duration_ms":810}' }], { toolName: "Bash" }),
].join("\n") + "\n");
const items = [
	{ id: "build", kind: "bash", label: "Build application", detail: "npm run build", status: "running", startedAt: Date.now() - 18000, output: "Compiling TypeScript…\n\u001b[32m✓ 184 modules transformed\u001b[0m\nwarning: source map missing for optional dependency\nBundling assets…\n10%\r75%", stop() {} },
	{ id: "review", kind: "subagent", label: "Parser review", detail: "Review boundary handling and regression coverage", status: "running", startedAt: Date.now() - 45000, tokens: 8400, transcriptPath: transcript, stop() {} },
	{ id: "queued", kind: "subagent", label: "Documentation audit", detail: "Check native UI contracts", status: "queued", startedAt: Date.now() },
	{ id: "failed", kind: "bash", label: "Integration tests", detail: "npm run test:integration", status: "failed", startedAt: Date.now() - 60000, endedAt: Date.now() - 30000, output: "ERROR: database unavailable\nNo requests were sent." },
];
const dir = mkdtempSync(join(tmpdir(), "bg-native-")); const sock = join(dir, "ctl.sock");
const child = spawn("tern", ["serve", "--control", sock], { cwd: output, stdio: "ignore" });
const ctl = (command) => {
	const reply = JSON.parse(execFileSync("tern", ["ctl", "--control", sock, command], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }));
	if (!reply.ok) throw new Error(`${command}: ${reply.error}`); return reply;
};
try {
	const deadline = Date.now() + 20000;
	while (!existsSync(sock)) { if (Date.now() > deadline) throw new Error("Tern control timeout"); await new Promise((r) => setTimeout(r, 50)); }
	for (const [view, width] of [["baseline", 1400], ["build", 1400], ["review", 1400], ["review", 480], ["failed", 1000]]) {
		const panel = new BackgroundPanel(); panel.select(view);
		const writes = []; const surface = new TernInlineSurface((s) => writes.push(s), `bg-${view}-${width}`, 10000);
		surface.open("Background manager fixture");
		surface.render([{ id: "fixture", k: "text", p: { text: "Native background manager · deterministic fixtures" } }], [], "bg-search", view === "baseline" ? backgroundWorkOutputNodes(items[0]) : panel.nodes(items, width < 600 ? 60 : 140));
		const file = join(output, `${view}-${width}.jsonl`);
		writeFileSync(file, writes.flatMap(parseTspMessages).map((m, i) => JSON.stringify({ t: i * 16, dir: "out", verb: m.verb, body: m.body })).join("\n") + "\n");
		ctl(`resize ${width} 900`); ctl(`surface-play "${file}"`); ctl("wait 150");
		const tree = ctl("tree .sf-overlay *"); writeFileSync(join(output, `${view}-${width}.tree.json`), JSON.stringify(tree, null, 2));
		if (!tree.nodes?.length) throw new Error("No native overlay rendered");
		console.log(JSON.stringify({ view, width, screenshot: ctl(`shot ${view}-${width}`) }));
	}
} finally { try { ctl("quit"); } catch {} child.kill(); rmSync(dir, { recursive: true, force: true }); }
