import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerMcpFallback } from "../../../extensions/mcp-fallback/extension.ts";
import { readMcpStatus } from "../../lib/tools/mcp-status.ts";

// A real stdio MCP server: answers initialize, tools/list and resources/list, nothing else.
const SERVER = `
import { createInterface } from "node:readline";
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
	const msg = JSON.parse(line);
	if (msg.id === undefined) return;
	if (msg.method === "initialize") reply(msg.id, { protocolVersion: "2025-11-25", capabilities: {}, serverInfo: { name: "fixture", version: "1" } });
	else if (msg.method === "tools/list") reply(msg.id, { tools: [] });
	else if (msg.method === "resources/list") reply(msg.id, { resources: [] });
	else reply(msg.id, {});
});
`;

let dir: string;
let pis: Array<ReturnType<typeof fakePi>>;
let eager: Record<string, unknown>;

function fakePi(manifests: unknown[]) {
	let sessionId = "fixture-session";
	const handlers: Record<string, Array<(event: unknown, ctx: unknown) => unknown>> = {};
	const commands: Record<string, { handler: (args: string, ctx: unknown) => Promise<unknown> }> = {};
	const pi = {
		mcpManifests: manifests,
		getCwd: () => dir,
		on: (event: string, fn: (event: unknown, ctx: unknown) => unknown) => { (handlers[event] ??= []).push(fn); },
		registerCommand: (name: string, opts: { handler: (args: string, ctx: unknown) => Promise<unknown> }) => { commands[name] = opts; },
		registerTool: vi.fn(),
		setActiveTools: vi.fn(),
		getActiveTools: () => [],
		getAllTools: () => [],
		getCommands: () => [],
		commands,
		setSession: (id:string) => {sessionId=id;},
		emit: async (event: string) => { for (const fn of handlers[event] ?? []) await fn({}, { sessionManager: {getSessionId:()=>sessionId}, ui: { notify: vi.fn(), select: vi.fn() } }); },
	};
	pis.push(pi);
	return pi;
}

function start(manifests: unknown[]) {
	const pi = fakePi(manifests);
	registerMcpFallback(pi as never, { cwd: dir });
	return pi;
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "mcp-status-"));
	writeFileSync(join(dir, "server.mjs"), SERVER);
	eager = { id: "fixture", type: "stdio", command: process.execPath, args: [join(dir, "server.mjs")] };
	pis = [];
	(globalThis as Record<symbol, unknown>)[Symbol.for("pi-swarm-mcp-status")] = undefined;
});

afterEach(async () => {
	for (const pi of pis) await pi.emit("session_shutdown");
	rmSync(dir, { recursive: true, force: true });
});

describe("mcp-fallback publishes authoritative connection state", () => {
	it("is unavailable before session start, then lists the server only after it connects", async () => {
		const pi = start([eager]);
		expect(readMcpStatus("fixture-session")).toBeUndefined();
		await pi.emit("session_start");
		expect(readMcpStatus("fixture-session")).toEqual({ connected: ["fixture"] });
	});

	it("reads none for a configured but lazy server until a discover connects it", async () => {
		const pi = start([{ ...eager, lazy: true }]);
		await pi.emit("session_start");
		expect(readMcpStatus("fixture-session")).toEqual({ connected: [] });
		await pi.commands["swarm-mcp"].handler("discover fixture", { ui: { notify: vi.fn() } });
		expect(readMcpStatus("fixture-session")).toEqual({ connected: ["fixture"] });
	});

	it("returns to unavailable on shutdown, and a stale instance cannot clear a newer session's status", async () => {
		const first = start([eager]);
		await first.emit("session_start");
		const second = start([eager]);
		await second.emit("session_start");
		expect(readMcpStatus("fixture-session")).toEqual({ connected: ["fixture"] });
		await first.emit("session_shutdown");
		expect(readMcpStatus("fixture-session")).toEqual({ connected: ["fixture"] });
		await second.emit("session_shutdown");
		expect(readMcpStatus("fixture-session")).toBeUndefined();
	});

	it("moves the snapshot on session switch", async () => {const pi=start([eager]);await pi.emit("session_start");pi.setSession("next");await pi.emit("session_switch");expect(readMcpStatus("fixture-session")).toBeUndefined();expect(readMcpStatus("next")).toEqual({connected:["fixture"]});});
	it("is unavailable when the manifest is rejected at startup", async () => {
		const pi = start([{ id: "bad id", type: "stdio", command: process.execPath }]);
		await pi.emit("session_start");
		expect(readMcpStatus("fixture-session")).toBeUndefined();
	});
});
