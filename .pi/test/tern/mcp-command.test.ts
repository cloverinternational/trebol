import { describe, expect, it, vi } from "vitest";
import { PiTernBridge } from "../../lib/tern/bridge.ts";
import { clearMcpInventory, deriveMcpInventory, publishMcpInventory } from "../../lib/tools/mcp-inventory.ts";
import { parseTspMessages } from "../../lib/tern/tsp.ts";

const DEFINITIONS = [
  { name: "mcp__github__get_me", exposure: "direct" },
  { name: "mcp__hoja__list_issues", exposure: "deferred" },
];

/** The surface as Tern holds it: ops applied in order. */
const drawn = (writes: string[]) => {
  const nodes = new Map<string, unknown>();
  for (const w of writes) for (const m of parseTspMessages(w)) for (const op of ((m.body as { ops?: unknown[][] }).ops ?? [])) {
    if (op[0] === "add") nodes.set(String(op[1]), op[4]);
    if (op[0] === "del") nodes.delete(String(op[1]));
    if (op[0] === "set") nodes.set(String(op[1]), { ...(nodes.get(String(op[1])) as object ?? {}), ...(op[2] as object) });
  }
  return JSON.stringify([...nodes]);
};

function bridgeWith(prompt = vi.fn(async () => {})) {
  const session: any = {
    sessionManager: { getSessionId: () => "s1", getCwd: () => process.cwd(), getEntries: () => [], getBranch: () => [] },
    subscribe: () => () => {},
    prompt,
    abort: async () => {},
    dispose() {},
  };
  const writes: string[] = [];
  const bridge = new PiTernBridge(session, {
    write: (d: string) => writes.push(d),
    credits: 1000,
    commands: {
      extensionCommands: () => [{ invocationName: "mcp", description: "Manage MCP servers" }],
      promptTemplates: () => [],
      skills: () => [],
    },
  } as any);
  return { bridge, writes, prompt };
}

describe("Tern /mcp", () => {
  it("prints the inventory instead of dispatching to Pi's unrenderable TUI panel", async () => {
    const owner = {};
    const { bridge, writes, prompt } = bridgeWith();
    try {
      bridge.start("test");
      publishMcpInventory(owner, deriveMcpInventory(DEFINITIONS, ["mcp__github__get_me", "codemode"]), "s1");
      writes.length = 0;
      await bridge.submit("/mcp");
      const surface = drawn(writes);
      expect(surface).toContain("MCP servers (2)");
      expect(surface).toContain("github");
      expect(surface).toContain("deferred: needs tool_search, which is not active");
      // The command never reached Pi's handler, so no model turn started.
      expect(prompt).not.toHaveBeenCalled();
    } finally {
      bridge.close();
      clearMcpInventory(owner);
    }
  });

  it("says the inventory is unavailable before any session published it", async () => {
    const { bridge, writes } = bridgeWith();
    try {
      bridge.start("test");
      writes.length = 0;
      await bridge.submit("/mcp");
      expect(drawn(writes)).toContain("MCP inventory unavailable");
    } finally {
      bridge.close();
    }
  });

  it("leaves subcommands on Pi's own handler", async () => {
    const { bridge, prompt } = bridgeWith();
    try {
      bridge.start("test");
      await bridge.submit("/mcp reconnect github");
      expect(prompt).toHaveBeenCalledWith("/mcp reconnect github");
    } finally {
      bridge.close();
    }
  });
});
