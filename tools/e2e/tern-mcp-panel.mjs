#!/usr/bin/env -S node --experimental-strip-types
// Deterministic native-render smoke. No real MCP connections, config writes or credentials.
// Produces TSP recordings, native screenshots and element trees under artifacts/tern-mcp.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { McpController } from "../../.pi/lib/tern/mcp-controller.ts";
import { mcpPanelNodes } from "../../.pi/lib/tern/mcp-panel.ts";
import { TernInlineSurface, parseTspMessages } from "../../.pi/lib/tern/tsp.ts";

const output = resolve("artifacts/tern-mcp"); mkdirSync(output, { recursive: true });
const names = ["github", "blender", "hoja", "exa", "archived"];
const config = { trusted: true, errors: 0, servers: names.map((name, i) => ({ name, namespace: `mcp__${name}`, scope: i === 2 ? "project" : "global", transport: i === 1 ? "stdio" : "http", enabled: i !== 4, exposure: i === 4 ? "hidden" : "deferred", oauth: i !== 1, override: false })) };
const tools = names.slice(0, 4).flatMap((name) => ["search", "get_details", "list_items"].map((tool) => ({ name: `mcp__${name}__${tool}`, description: `${tool.replaceAll("_", " ")} using ${name}. This is a deterministic rendering fixture, not a live server.`, exposure: "deferred", parameters: { type: "object", properties: { query: { type: "string", description: "Search phrase" } }, required: ["query"] } })));
const host = { configuration: async () => config, command: async () => ({ ok: true, message: "Fixture only" }), add: async () => ({ ok: true, message: "Fixture only" }), remove: async () => ({ ok: true, message: "Fixture only" }) };
const manager = new McpController({ host: () => host, snapshot: () => ({ tools, active: ["tool_search"], connected: names.slice(0, 4) }), reload: async () => {} }, () => {});
await manager.show();

const dir = mkdtempSync(join(tmpdir(), "tern-mcp-render-"));
const sock = join(dir, "ctl.sock");
const child = spawn("tern", ["serve", "--control", sock], { cwd: output, stdio: "ignore" });
const ctl = (command) => {
	const reply = JSON.parse(execFileSync("tern", ["ctl", "--control", sock, command], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }));
	if (!reply.ok) throw new Error(`${command}: ${reply.error}`);
	return reply;
};
try {
	const deadline = Date.now() + 20000;
	while (!existsSync(sock)) { if (Date.now() > deadline) throw new Error("Tern control socket timed out"); await new Promise((r) => setTimeout(r, 50)); }
	for (const [view, width] of [["servers", 1400], ["tools", 1400], ["diagnostics", 1000], ["servers", 480], ["add", 1000], ["preview", 1000], ["remove", 1000]]) {
		manager.form = undefined;
		if (view === "add" || view === "preview") {
			await manager.action("mcp.add");
			manager.input.setText('{"mcpServers":{"docs":{"url":"https://example.org/mcp"}}}');
			if (view === "preview") await manager.action("mcp.preview");
		} else if (view === "remove") await manager.action("mcp.remove");
		else await manager.action("mcp.tab", view);
		const writes = [];
		const surface = new TernInlineSurface((s) => writes.push(s), `mcp-${view}-${width}`, 10000);
		surface.open("MCP render fixture");
		surface.render([{ id: "fixture-title", k: "text", p: { text: "MCP control center · deterministic native rendering fixture" } }], [], manager.focusId, mcpPanelNodes(manager, width < 600 ? 60 : 140));
		const recording = writes.flatMap(parseTspMessages).map((m, i) => JSON.stringify({ t: i * 16, dir: "out", verb: m.verb, body: m.body })).join("\n") + "\n";
		const file = join(output, `${view}-${width}.jsonl`); writeFileSync(file, recording);
		ctl(`resize ${width} 900`); ctl(`surface-play "${file}"`); ctl("wait 150");
		const tree = ctl("tree .sf-overlay *");
		writeFileSync(join(output, `${view}-${width}.tree.json`), JSON.stringify(tree, null, 2));
		if (!tree.nodes?.some((n) => n.text?.includes("MCP"))) throw new Error(`${view}: overlay not rendered`);
		console.log(JSON.stringify({ view, width, elements: tree.nodes.length, screenshot: ctl(`shot ${view}-${width}`) }));
	}
} finally {
	manager.close(); try { ctl("quit"); } catch { /* already gone */ }
	child.kill(); rmSync(dir, { recursive: true, force: true });
}
