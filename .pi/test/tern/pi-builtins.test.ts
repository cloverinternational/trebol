// The Tern runner must load Pi's own built-in extensions, so `/mcp` and MCP tools are Pi's, not a copy.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createAgentSessionFromServices, createAgentSessionServices, SessionManager } from "@earendil-works/pi-coding-agent";
import { piBuiltinExtensions, withMcpStatus } from "../../lib/tern/pi-builtins.ts";
import { readMcpStatus } from "../../lib/tools/mcp-status.ts";

describe("piBuiltinExtensions", () => {
	it("is Pi's own list, with MCP kept replaceable", async () => {
		const list = await piBuiltinExtensions();
		expect(list.map((e) => e.name)).toEqual(expect.arrayContaining(["mcp", "codemode", "tool-search"]));
		expect(list.every((e) => e.builtin === true)).toBe(true);
		expect(list.find((e) => e.name === "mcp")).toMatchObject({ replaceable: true });
	});

	it("registers Pi's /mcp in a session built the way the Tern runner builds it", async () => {
		const dir = mkdtempSync(join(tmpdir(), "tern-builtins-"));
		writeFileSync(join(dir, "mcp.json"), JSON.stringify({ mcpServers: { off: { command: "never-started", enabled: false } } }));
		const extensionFactories = (await piBuiltinExtensions()) as never;
		const services = await createAgentSessionServices({ cwd: dir, agentDir: dir, resourceLoaderOptions: { extensionFactories } });
		const { session } = await createAgentSessionFromServices({ services, sessionManager: SessionManager.inMemory(dir) });
		const commands = session.extensionRunner.getRegisteredCommands().map((c: { name: string }) => c.name);
		expect(commands).toContain("mcp");
		session.dispose();
	});
});

describe("withMcpStatus", () => {
	function fakePi() {
		const handlers = new Map<string, (e: unknown, ctx: unknown) => unknown>();
		const registered: string[] = [];
		return {
			handlers, registered,
			pi: { on: (n: string, h: (e: unknown, ctx: unknown) => unknown) => handlers.set(n, h), registerTool: (d: { name: string }) => registered.push(d.name), getActiveTools: () => ["read"] },
		};
	}
	const ctx = { sessionManager: { getSessionId: () => "builtins-session" } };

	it("publishes servers with reachable tools and clears on shutdown", async () => {
		const { pi, handlers, registered } = fakePi();
		let api: any;
		withMcpStatus((p) => {
			api = p;
			p.on("session_start", () => {});
			p.on("session_shutdown", () => {});
		})(pi);
		await handlers.get("session_start")!({}, ctx);
		expect(readMcpStatus("builtins-session")).toEqual({ connected: [] });
		api.registerTool({ name: "mcp__github__search" });
		api.registerTool({ name: "list_mcp_resources" });
		expect(registered).toEqual(["mcp__github__search", "list_mcp_resources"]);
		expect(readMcpStatus("builtins-session")).toEqual({ connected: ["github"] });
		api.registerTool({ name: "mcp__github__search", exposure: "hidden" });
		expect(readMcpStatus("builtins-session")).toEqual({ connected: [] });
		expect(api.getActiveTools()).toEqual(["read"]);
		await handlers.get("session_shutdown")!({}, ctx);
		expect(readMcpStatus("builtins-session")).toBeUndefined();
	});
});
