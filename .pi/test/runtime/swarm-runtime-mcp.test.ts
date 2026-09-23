import { expect, it, vi } from "vitest";
import { registerSwarmRuntime } from "../../extensions/00-runtime/swarm-runtime.ts";
import { startupNotices } from "../../lib/ui/startup-notices.ts";

it("turns invalid MCP startup config into a startup notice instead of throwing", async () => {
  const handlers = new Map<string, any>();
  const pi: any = {
    getCwd: () => process.cwd(), mcpManifests: [{ id: "bad", type: "http", url: "https://example.test", headers: { "x-admin-key": "literal-secret" } }],
    on: (name: string, fn: any) => handlers.set(name, fn), registerTool: vi.fn(), registerCommand: vi.fn(), getActiveTools: () => [], getAllTools: () => [], setActiveTools: vi.fn(),
  };
  registerSwarmRuntime(pi);
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
  const state = registerSwarmRuntime(pi);
  await handlers.get("session_start")({}, {});
  expect(commands).toContain("swarm-mcp");
  expect(commands).not.toContain("mcp");
  expect(state.mcp).toBeUndefined();
});
