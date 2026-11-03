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
  return { bridge, writes, prompt, session };
}

describe("Tern /mcp", () => {
  it("opens from startup, isolates edits/pastes, and restores the composer on Escape", async () => {
    const { bridge, writes, prompt } = bridgeWith();
    try {
      bridge.start("test"); bridge.setDraft("keep this draft");
      await bridge.handle({ verb: "e", body: { ev: "action", act: "mcp.open" } } as any);
      bridge.applyMcpKey({ kind: "text", text: "github" });
      bridge.pasteText("search only");
      bridge.handle({ verb: "e", body: { ev: "edit", id: "composer", from: 0, to: 15, len: 15, cursor: 4, text: "oops" } } as any);
      expect(bridge.draft).toBe("keep this draft");
      expect(prompt).not.toHaveBeenCalled();
      writes.length = 0;
      bridge.escape();
      expect(bridge.draft).toBe("keep this draft");
      expect(writes.join("")).toContain('"del","mcp-overlay"');
    } finally { bridge.close(); }
  });

  it("reads late registrations and exposure changes without a model turn", async () => {
    const owner = {};
    const { bridge, writes, prompt, session } = bridgeWith();
    let definitions: typeof DEFINITIONS = [];
    let active = ["tool_search"];
    session.getAllTools = () => definitions;
    session.getActiveToolNames = () => active;
    try {
      bridge.start("test");
      publishMcpInventory(owner, deriveMcpInventory([], []), "s1");
      // Background connection completes after the startup alignment snapshot.
      definitions = DEFINITIONS;
      writes.length = 0;
      await bridge.submit("/mcp");
      expect(drawn(writes)).toContain('"k":"overlay"');
      expect(drawn(writes)).toContain('"id":"hoja"');
      await bridge.handle({ verb: "e", body: { ev: "select", id: "mcp-servers", item: "hoja" } } as any);
      expect(drawn(writes)).toContain("Deferred tools are discoverable through tool_search");

      definitions = [{ name: "mcp__hoja__list_issues", exposure: "hidden" }];
      active = [];
      writes.length = 0;
      await bridge.submit("/mcp");
      expect(drawn(writes)).toContain("Hidden tools are unreachable by design");

      // A current empty registry must also beat a stale nonempty snapshot.
      publishMcpInventory(owner, deriveMcpInventory(DEFINITIONS, []), "s1");
      definitions = [];
      writes.length = 0;
      await bridge.submit("/mcp");
      expect(drawn(writes)).toContain("No MCP servers observed");
      expect(drawn(writes)).not.toContain("No MCP servers are configured");
      expect(prompt).not.toHaveBeenCalled();
    } finally {
      bridge.close();
      clearMcpInventory(owner);
    }
  });

  it("opens a native inventory instead of dispatching to Pi's unrenderable TUI panel", async () => {
    const owner = {};
    const { bridge, writes, prompt, session } = bridgeWith();
    session.getAllTools = () => DEFINITIONS;
    session.getActiveToolNames = () => ["mcp__github__get_me", "codemode"];
    try {
      bridge.start("test");
      publishMcpInventory(owner, deriveMcpInventory(DEFINITIONS, ["mcp__github__get_me", "codemode"]), "s1");
      writes.length = 0;
      await bridge.submit("/mcp");
      const surface = drawn(writes);
      expect(surface).toContain('"k":"overlay"');
      expect(surface).toContain('"k":"table"');
      expect(surface).toContain("github");
      await bridge.handle({ verb: "e", body: { ev: "select", id: "mcp-servers", item: "hoja" } } as any);
      expect(drawn(writes)).toContain("Deferred tools need tool_search, which is inactive");
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
      expect(drawn(writes)).toContain("Pi management adapter unavailable");
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
