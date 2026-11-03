import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearMcpHost, publishMcpHost, readMcpHost } from "../../lib/tern/mcp-host.ts";

const owners: object[] = [];
const dirs: string[] = [];
afterEach(() => { owners.splice(0).forEach(clearMcpHost); dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })); });
function fixture(trusted = true) {
  const dir = mkdtempSync(join(tmpdir(), "mcp-host-")); dirs.push(dir);
  mkdirSync(join(dir, ".pi"));
  writeFileSync(join(dir, ".pi", "mcp.json"), JSON.stringify({ mcpServers: { "local-test": { command: "never-run", enabled: false, env: { TOKEN: "SECRET_NOT_FOR_UI" } } } }));
  const owner = {}; owners.push(owner);
  const id = dir;
  const handler = vi.fn(async (_args: string, _ctx: any) => {});
  const ctx = { cwd: dir, isProjectTrusted: () => trusted, sessionManager: { getSessionId: () => id }, ui: { input: vi.fn(), notify: vi.fn() } };
  publishMcpHost(owner, id, { getMcpServers: () => [] }, ctx, handler);
  return { dir, owner, id, ctx, handler, host: readMcpHost(id)! };
}
describe("Pi MCP host adapter", () => {
  it("loads configured tool-less servers through Pi and never exposes transport secrets", async () => {
    const { host } = fixture();
    const result = await host.configuration();
    expect(result.servers.find((s) => s.name === "local-test")).toMatchObject({ namespace: "mcp__local_test", scope: "project", enabled: false });
    expect(JSON.stringify(result)).not.toContain("SECRET_NOT_FOR_UI");
    expect(JSON.stringify(result)).not.toContain("never-run");
  });
  it("honors session-only project trust rather than blindly loading project config", async () => {
    const { host } = fixture(false);
    expect((await host.configuration()).servers.some((s) => s.name === "local-test")).toBe(false);
  });
  it("uses Pi command handler with native prompt path and suppresses raw diagnostics", async () => {
    const { host, handler, ctx } = fixture();
    handler.mockImplementation(async (_args, commandCtx) => { commandCtx.ui.notify("Bearer SECRET", "error"); });
    const result = await host.command("login", "local-test");
    expect(handler).toHaveBeenCalledWith("login local-test", expect.objectContaining({ mode: "rpc", hasUI: true }));
    expect(handler.mock.calls[0]![1].ui.input).toBe(ctx.ui.input);
    expect(result.ok).toBe(false); expect(JSON.stringify(result)).not.toContain("SECRET");
    expect(ctx.ui.notify).not.toHaveBeenCalled();
  });
  it("uses Pi CLI for isolated project add/remove without opening a connection", async () => {
    const { host, dir } = fixture();
    const result = await host.add('{"mcpServers":{"new-test":{"command":"never-run"}}}', true);
    expect(result.ok).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, ".pi", "mcp.json"), "utf8")).mcpServers["new-test"].command).toBe("never-run");
    expect((await host.remove("new-test", "project")).ok).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, ".pi", "mcp.json"), "utf8")).mcpServers["new-test"]).toBeUndefined();
  });
  it("rejects stale host references after disposal", async () => {
    const { host, owner, handler } = fixture();
    clearMcpHost(owner);
    expect((await host.command("reconnect", "local-test")).ok).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });
  it("invalidates an earlier lease even on reload of the same session ID", async () => {
    const { host, owner, id, ctx, handler } = fixture();
    publishMcpHost(owner, id, {}, ctx, handler);
    expect((await host.command("reconnect", "local-test")).ok).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });
});
