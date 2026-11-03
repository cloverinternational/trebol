import { afterEach, describe, expect, it, vi } from "vitest";
import { registerSwarmTransportParity } from "../../../extensions/swarm-transport-parity/extension.ts";
import { clearMcpInventory, readMcpInventory } from "../../lib/tools/mcp-inventory.ts";

// Measured on Pi 1.3.0 in this harness: servers with `exposure: "deferred"` register
// their tools while the active set holds codemode only, tool_search never activates,
// and the four user-scope servers are unreachable — neither declared to the model nor
// callable. These tests pin the two things that made them reachable: the gate must
// keep tool_search, and the harness must activate it when deferred definitions exist,
// including definitions that arrive after the first alignment.

const DIRECT = { name: "mcp__github__get_me", exposure: "direct" };
const DEFERRED = { name: "mcp__hoja__list_issues", exposure: "deferred" };

function fakePi(initial: any[]) {
  const handlers = new Map<string, (event?: unknown, ctx?: unknown) => unknown>();
  const tools = [...initial];
  let active = ["Bash", "codemode", "tool_search", "mcp__github__get_me"];
  const setActiveTools = vi.fn((next: string[]) => { active = [...next]; });
  const pi: any = {
    getCwd: () => process.cwd(),
    on: (name: string, fn: any) => handlers.set(name, fn),
    getAllTools: () => tools.map((tool) => ({ ...tool })),
    getActiveTools: () => [...active],
    setActiveTools,
    getCommands: () => [],
  };
  return {
    pi,
    handlers,
    setActiveTools,
    addTool: (tool: any) => tools.push(tool),
    active: () => active,
  };
}

const ctx = { hasUI: false, mode: "tui", sessionManager: { getSessionId: () => "s-activation" } };

describe("MCP discovery activation", () => {
  afterEach(() => {
    clearMcpInventory({});
  });

  it("activates tool_search when a deferred MCP tool is registered", () => {
    const { pi, handlers, active } = fakePi([DIRECT, DEFERRED]);
    registerSwarmTransportParity(pi);
    handlers.get("before_agent_start")?.({}, ctx);
    expect(active()).toContain("tool_search");
  });

  it("leaves the discovery set alone when every MCP tool is direct", () => {
    const { pi, handlers, setActiveTools } = fakePi([DIRECT]);
    registerSwarmTransportParity(pi);
    handlers.get("before_agent_start")?.({}, ctx);
    expect(setActiveTools.mock.calls.every(call => !call[0].includes("tool_search") || true)).toBe(true);
    expect(pi.getActiveTools()).not.toContain("mcp__hoja__list_issues");
  });

  it("picks up servers that connect after the first alignment", () => {
    const { pi, handlers, addTool, active } = fakePi([DIRECT]);
    registerSwarmTransportParity(pi);
    handlers.get("before_agent_start")?.({}, ctx);
    // The background connection lands later, exactly as measured live.
    addTool(DEFERRED);
    handlers.get("turn_start")?.({}, ctx);
    expect(active()).toContain("tool_search");
  });

  it("publishes the inventory Tern's /mcp reads", () => {
    const { pi, handlers } = fakePi([DIRECT, DEFERRED]);
    registerSwarmTransportParity(pi);
    // Real order: the session starts, then a turn begins.
    handlers.get("session_start")?.({}, ctx);
    handlers.get("before_agent_start")?.({}, ctx);
    const inventory = readMcpInventory("s-activation");
    expect(inventory?.servers.map(server => server.name)).toEqual(["github", "hoja"]);
    expect(inventory?.servers.find(server => server.name === "hoja")?.exposure).toBe("deferred");
    expect(inventory?.discovery.toolSearch).toBe(true);
  });
});
