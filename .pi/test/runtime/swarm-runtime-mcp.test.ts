import { expect, it, vi } from "vitest";
import { registerMcpFallback } from "../../../extensions/mcp-fallback/extension.ts";
import { startupNotices } from "../../lib/ui/startup-notices.ts";

it("turns invalid MCP startup config into a startup notice instead of throwing", async () => {
  const handlers = new Map<string, any>();
  const pi: any = {
    getCwd: () => process.cwd(), mcpManifests: [{ id: "bad", type: "http", url: "https://example.test", headers: { "x-admin-key": "literal-secret" } }],
    on: (name: string, fn: any) => handlers.set(name, fn), registerTool: vi.fn(), registerCommand: vi.fn(), getActiveTools: () => [], getAllTools: () => [], setActiveTools: vi.fn(),
  };
  registerMcpFallback(pi);
  await handlers.get("session_start")();
  expect(startupNotices().at(-1)?.message).toContain("MCP startup failed");
  expect(startupNotices().at(-1)?.message).toContain("x-admin-key");
});

it("leaves /mcp and discovery to the installed adapter", async () => {
  const handlers = new Map<string, any>(); const commands: string[] = [];
  const pi: any = {
    mcpManifests: [{ id: "invalid", type: "stdio" }],
    on: (n: string, fn: any) => handlers.set(n, fn), registerTool: vi.fn(),
    registerCommand: (n: string) => commands.push(n),
    getCommands: () => [{ name: "pi-mcp" }],
  };
  const state = registerMcpFallback(pi);
  await handlers.get("session_start")({}, {});
  expect(commands).toContain("swarm-mcp");
  expect(commands).not.toContain("mcp");
  expect(state.mcp).toBeUndefined();
});

it("leaves servers to Pi's built-in MCP when /mcp is registered", async () => {
  const handlers = new Map<string, any>(); const notices: string[] = [];
  const commands = new Map<string, any>();
  const pi: any = {
    mcpManifests: [{ id: "would-connect", type: "stdio", command: "true" }],
    on: (n: string, fn: any) => handlers.set(n, fn), registerTool: vi.fn(),
    registerCommand: (n: string, spec: any) => commands.set(n, spec),
    getCommands: () => [{ name: "mcp" }],
  };
  const state = registerMcpFallback(pi);
  await handlers.get("session_start")({}, {});
  expect(state.mcp).toBeUndefined();
  await commands.get("swarm-mcp").handler("", { ui: { notify: (m: string) => notices.push(m), select: vi.fn() } });
  expect(state.mcp).toBeUndefined();
  expect(notices.join("\n")).toContain("/mcp");
});

it("still runs when neither Pi's /mcp nor an adapter is present", async () => {
  const handlers = new Map<string, any>();
  const pi: any = {
    mcpManifests: [], on: (n: string, fn: any) => handlers.set(n, fn), registerTool: vi.fn(), registerCommand: vi.fn(),
    getCommands: () => [{ name: "swarm-mcp" }], getActiveTools: () => [], getAllTools: () => [], setActiveTools: vi.fn(),
  };
  const state = registerMcpFallback(pi);
  await handlers.get("session_start")({}, {});
  expect(state.mcp).toBeDefined();
  await state.mcp?.close();
});
