import { afterEach, describe, expect, it, vi } from "vitest";
import { McpController, mcpServerRows, type McpSnapshot } from "../../lib/tern/mcp-controller.ts";
import { mcpPanelNodes } from "../../lib/tern/mcp-panel.ts";
import { previewMcpAdd, type McpHost, type McpConfiguration } from "../../lib/tern/mcp-host.ts";

const configuration: McpConfiguration = { trusted: true, errors: 0, servers: [
  { name: "git-hub", namespace: "mcp__git_hub", scope: "global", enabled: true, exposure: "deferred", transport: "http", oauth: true, override: false },
  { name: "disabled", namespace: "mcp__disabled", scope: "project", enabled: false, exposure: "hidden", transport: "stdio", oauth: false, override: false },
] };
const managers: McpController[] = [];
afterEach(() => { managers.splice(0).forEach((m) => m.close()); vi.useRealTimers(); });
function fixture() {
  let snapshot: McpSnapshot = { tools: [{ name: "mcp__git_hub__search", description: "Search repositories", exposure: "deferred", parameters: { type: "object" } }], active: ["tool_search"], connected: ["git_hub"] };
  const host: McpHost = { configuration: vi.fn(async () => configuration), command: vi.fn(async () => ({ ok: true, message: "done" })), add: vi.fn(async () => ({ ok: true, message: "saved" })), remove: vi.fn(async () => ({ ok: true, message: "removed" })) };
  const changed = vi.fn();
  const reload = vi.fn(async () => {});
  const manager = new McpController({ host: () => host, snapshot: () => snapshot, reload }, changed);
  managers.push(manager);
  return { manager, host, changed, reload, setSnapshot: (s: McpSnapshot) => { snapshot = s; } };
}
const rendered = (m: McpController, cols = 120) => JSON.stringify(mcpPanelNodes(m, cols));

describe("native MCP control center", () => {
  it("joins configured IDs to Pi namespaces and keeps disabled/tool-less servers", async () => {
    const { manager } = fixture(); await manager.show();
    expect(manager.rows.map((r) => [r.id, r.tools.length, r.observed])).toEqual([["git-hub", 1, true], ["disabled", 0, false]]);
    expect(rendered(manager)).toContain('"k":"overlay"');
    expect(rendered(manager)).toContain('"k":"table"');
    expect(rendered(manager)).toContain("Deferred tools are discoverable");
    expect(rendered(manager)).toContain("Disabled");
    expect(rendered(manager, 60)).toContain('"id":"mcp-server-view","k":"col"');
  });
  it("designs loading, empty, failure and successful states without inventing connection health", async () => {
    const { manager, host, setSnapshot } = fixture();
    setSnapshot({ tools: [], active: [] });
    let finish!: (c: McpConfiguration) => void;
    host.configuration = () => new Promise((resolve) => { finish = resolve; });
    const pending = manager.show();
    expect(rendered(manager)).toContain('"k":"skeleton"');
    finish({ trusted: false, errors: 0, servers: [] }); await pending;
    expect(rendered(manager)).toContain('"k":"empty"');
    host.configuration = async () => { throw new Error("SECRET_TOKEN"); };
    await manager.refresh();
    expect(rendered(manager)).toContain("Could not read Pi");
    expect(rendered(manager)).not.toContain("SECRET_TOKEN");
  });
  it("filters and inspects tool schemas without executing tools", async () => {
    const { manager, host } = fixture(); await manager.show();
    await manager.action("mcp.tab", "tools");
    manager.key({ kind: "text", text: "repositories" });
    expect(manager.tools).toHaveLength(1);
    expect(rendered(manager)).toContain('"id":"mcp-schema"');
    expect(host.command).not.toHaveBeenCalled();
    manager.key({ kind: "selectAll" }); manager.key({ kind: "text", text: "missing" });
    expect(rendered(manager)).toContain("No matching tools");
  });
  it("requires an explicit review before adding and redacts secrets from review", async () => {
    const { manager, host } = fixture(); await manager.show();
    await manager.action("mcp.add");
    manager.key({ kind: "text", text: '{"mcpServers":{"demo":{"url":"https://example.org/mcp","headers":{"Authorization":"Bearer SECRET_VALUE_123456789"}}}}' });
    await manager.action("mcp.save"); expect(host.add).not.toHaveBeenCalled();
    await manager.action("mcp.preview");
    expect(rendered(manager)).toContain("Confirm plaintext save");
    expect(rendered(manager)).not.toContain("SECRET_VALUE");
    await manager.action("mcp.scope", "project");
    expect(manager.project).toBe(false);
    manager.event({ ev: "edit", id: "mcp-add-input", from: 0, to: manager.input.text.length, len: manager.input.text.length, cursor: 0, text: "" });
    await manager.action("mcp.save"); expect(host.add).toHaveBeenCalledOnce();
    expect(manager.input.text).toBe("");
    manager.input.undo(); expect(manager.input.text).toBe("");
  });
  it("confirms removal using immutable ID/scope, not a newly selected row", async () => {
    const { manager, host } = fixture(); await manager.show();
    await manager.action("mcp.confirm-remove"); expect(host.remove).not.toHaveBeenCalled();
    await manager.action("mcp.remove");
    manager.selected = "disabled";
    await manager.action("mcp.confirm-remove");
    expect(host.remove).toHaveBeenCalledWith("git-hub", "global");
  });
  it("keeps operations single-flight and discards stale UI completion", async () => {
    const { manager, host } = fixture(); await manager.show();
    let finish!: (v: any) => void;
    host.command = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    const pending = manager.action("mcp.reconnect");
    await manager.action("mcp.reconnect"); expect(host.command).toHaveBeenCalledOnce();
    manager.close(); finish({ ok: true, message: "stale result" }); await pending;
    expect(manager.notice).toBeUndefined(); expect(manager.open).toBe(false);
  });
  it("polls only local registry while visible and cleans up on close", async () => {
    vi.useFakeTimers();
    const { manager, changed, host, setSnapshot } = fixture(); await manager.show();
    changed.mockClear();
    setSnapshot({ tools: [], active: [] });
    await vi.advanceTimersByTimeAsync(1100);
    expect(changed).toHaveBeenCalled(); expect(host.configuration).toHaveBeenCalledTimes(1);
    manager.close(); changed.mockClear();
    await vi.advanceTimersByTimeAsync(3000); expect(changed).not.toHaveBeenCalled();
  });
  it("rejects pasted scope flags and invalid IDs without echoing input", () => {
    expect(previewMcpAdd("demo --local -- echo hi")).toHaveProperty("error");
    expect(previewMcpAdd("demo --local=true -- echo hi")).toHaveProperty("error");
    expect(previewMcpAdd("demo -l=true -- echo hi")).toHaveProperty("error");
    expect(previewMcpAdd('bad "SECRET')).toHaveProperty("error");
    expect(JSON.stringify(previewMcpAdd('{"token":"SUPER_SECRET"}'))).not.toContain("SUPER_SECRET");
  });
  it("does not call a hidden registration a connected server", () => {
    expect(mcpServerRows(undefined, { tools: [{ name: "mcp__off__tool", exposure: "hidden" }], active: [] })[0]?.observed).toBe(false);
  });
});
