import { describe, expect, it } from "vitest";
import { clearMcpInventory, deriveMcpInventory, publishMcpInventory, readMcpInventory } from "../../lib/tools/mcp-inventory.ts";
import { mcpInventoryLines } from "../../lib/tern/mcp-view.ts";

// Shape measured from Pi 1.3.0: project servers default to direct, user-scope
// servers came back with exposure "deferred", which only tool_search can reach.
const DEFINITIONS = [
  { name: "mcp__github__get_me", exposure: "direct" },
  { name: "mcp__github__list_issues", exposure: "direct" },
  { name: "mcp__hoja__list_issues", exposure: "deferred" },
  { name: "mcp__hoja__get_issue", exposure: "deferred" },
  { name: "Bash", exposure: "direct" },
];

describe("deriveMcpInventory", () => {
  it("groups mcp__ tools by server and reports active coverage", () => {
    const inventory = deriveMcpInventory(DEFINITIONS, ["mcp__github__get_me", "mcp__github__list_issues", "Bash", "codemode"]);
    expect(inventory.servers.map(s => s.name)).toEqual(["github", "hoja"]);
    expect(inventory.total).toBe(4);
    expect(inventory.active).toBe(2);
    expect(inventory.servers[0]).toMatchObject({ name: "github", exposure: "direct", total: 2, active: 2 });
    expect(inventory.servers[1]).toMatchObject({ name: "hoja", exposure: "deferred", total: 2, active: 0 });
    // Non-MCP tools never appear in the inventory.
    expect(Object.keys(inventory.tools)).toEqual(["github", "hoja"]);
  });

  it("records whether the discovery surfaces are active", () => {
    expect(deriveMcpInventory(DEFINITIONS, ["codemode"]).discovery).toEqual({ toolSearch: false, codemode: true });
    expect(deriveMcpInventory(DEFINITIONS, ["codemode", "tool_search"]).discovery).toEqual({ toolSearch: true, codemode: true });
  });

  it("marks a server whose tools disagree on exposure as unknown", () => {
    const mixed = [
      { name: "mcp__srv__a", exposure: "direct" },
      { name: "mcp__srv__b", exposure: "hidden" },
    ];
    expect(deriveMcpInventory(mixed, []).servers[0].exposure).toBe("unknown");
  });

  it("ignores malformed names and never leaks configuration", () => {
    const inventory = deriveMcpInventory([{ name: "mcp__broken" }, { name: "unrelated", exposure: "direct" }], []);
    expect(inventory.servers).toEqual([]);
    expect(inventory.total).toBe(0);
  });
});

describe("mcpInventoryLines (Tern /mcp)", () => {
  it("distinguishes an unpublished snapshot from an empty configuration", () => {
    expect(mcpInventoryLines(undefined)[0]).toMatch(/unavailable/i);
    expect(mcpInventoryLines(deriveMcpInventory([], []))[0]).toMatch(/No MCP tools are registered/i);
  });

  it("states each server's exposure and why its tools are or are not reachable", () => {
    const gated = deriveMcpInventory(DEFINITIONS, ["mcp__github__get_me", "mcp__github__list_issues", "codemode"]);
    const lines = mcpInventoryLines(gated);
    expect(lines[0]).toBe("MCP servers (2) · 2/4 tools active in this session");
    expect(lines[1]).toBe("  github · 2/2 active");
    // The failure the user hit: deferred tools with no tool_search to load them.
    expect(lines[2]).toBe("  hoja · 0/2 active · deferred: needs tool_search, which is not active");

    const repaired = deriveMcpInventory(DEFINITIONS, ["mcp__github__get_me", "mcp__github__list_issues", "codemode", "tool_search"]);
    expect(repaired.discovery.toolSearch).toBe(true);
    expect(mcpInventoryLines(repaired)[2]).toBe("  hoja · 0/2 active · deferred: loaded on demand by tool_search");
  });

  it("never prints a credential-looking value", () => {
    const inventory = deriveMcpInventory([{ name: "mcp__github__get_me", exposure: "direct" }], ["mcp__github__get_me"]);
    expect(mcpInventoryLines(inventory).join("\n")).not.toMatch(/token|secret|authorization/i);
  });
});

describe("inventory slot", () => {
  it("is session-scoped and cleared by its owner", () => {
    const owner = {};
    const other = {};
    publishMcpInventory(owner, deriveMcpInventory(DEFINITIONS, []), "s1");
    publishMcpInventory(other, deriveMcpInventory([], []), "s2");
    expect(readMcpInventory("s1")?.total).toBe(4);
    expect(readMcpInventory("s2")?.total).toBe(0);
    expect(readMcpInventory("other")).toBeUndefined();
    clearMcpInventory(owner);
    expect(readMcpInventory("s1")).toBeUndefined();
    // Only the owner's slot went away.
    expect(readMcpInventory("s2")).toBeDefined();
    clearMcpInventory(other);
  });
});
