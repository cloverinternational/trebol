import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MCPError, MCPManager, validateManifest, type MCPManifest } from "../src/index.js";

describe("MCP manifest security", () => {
  it("requires pinned stdio commands in closed mode and rejects inline header values", () => {
    expect(validateManifest({ id:"demo", type:"stdio", command:"node", headers:{Authorization:"TOKEN"} })).toContain("closed mode requires a pinned stdio command path");
    expect(validateManifest({ id:"demo", type:"http", url:"https://example.test", headers:{Authorization:"TOKEN"} })).toContain("header Authorization references non-allowlisted environment TOKEN");
  });
  it("allows explicit tool allowlists and validates remote URLs", () => {
    expect(validateManifest({id:"x",type:"http",url:"https://example.test",environment:["TOKEN"],headers:{authorization:"TOKEN"},tools:["a"],excludeTools:["b"]})).toContain("tools and excludeTools are mutually exclusive");
    expect(validateManifest({id:"x",type:"http",url:"file:///tmp"})).toContain("url must use http or https");
  });
});

describe("MCP manager", () => {
  it("connects only after discovery, reports connected servers, and resets on close so it can reconnect", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init: any) => {
      const body = JSON.parse(init.body);
      const result = body.method === "tools/list" ? { tools: [] } : body.method === "resources/list" ? { resources: [] } : {};
      return new Response(JSON.stringify({ result }), { status: 200 });
    });
    const changes = vi.fn();
    const manager = new MCPManager([{ id: "remote", type: "http", url: "https://example.test/mcp", lazy: true }], { onConnectionChange: changes });
    expect(manager.connectedServers()).toEqual([]);
    await manager.discover("remote");
    expect(manager.connectedServers()).toEqual(["remote"]);
    expect(changes).toHaveBeenCalledTimes(1);
    await manager.close();
    expect(manager.connectedServers()).toEqual([]);
    expect(changes).toHaveBeenCalledTimes(2);
    await manager.discover("remote");
    expect(manager.connectedServers()).toEqual(["remote"]);
    fetch.mockRestore();
  });
  it("does not expose literal API keys in manifest listings", () => {
    const manager = new MCPManager([{id:"srv",type:"http",url:"https://example.test",apiKey:"not-for-output",apiKeyHeader:"x-admin-key"}]);
    expect(JSON.stringify(manager.manifestsList())).not.toContain("not-for-output");
  });
  it("resolves allowlisted header names from the process environment", async () => {
    const previous = process.env.PLEXUS_ADMIN_KEY;
    process.env.PLEXUS_ADMIN_KEY = "test-secret";
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init: any) => {
      expect(init.headers["x-admin-key"]).toBe("test-secret");
      return new Response(JSON.stringify({ result: { tools: [] } }), { status: 200 });
    });
    const manager = new MCPManager([{ id: "plexus-management", type: "http", url: "http://100.121.114.16:4000/mcp/plexus", environment: ["PLEXUS_ADMIN_KEY"], headers: { "x-admin-key": "PLEXUS_ADMIN_KEY" } }]);
    await manager.discover("plexus-management");
    fetch.mockRestore();
    if (previous === undefined) delete process.env.PLEXUS_ADMIN_KEY; else process.env.PLEXUS_ADMIN_KEY = previous;
  });
  it("discovers lazily, namespaces tools, and enforces the allowlist", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({result:{tools:[{name:"ok",inputSchema:{type:"object"}},{name:"no"}]}}), {status:200}));
    const registered:any[]=[]; const manager=new MCPManager([{id:"srv",type:"http",url:"https://example.test",tools:["ok"]}],{registerTool:t=>registered.push(t)});
    expect(fetch).not.toHaveBeenCalled();
    expect((await manager.discover("srv")).map(x=>x.name)).toEqual(["ok"]);
    expect(registered[0].name).toBe("mcp__srv__ok");
    await expect(manager.call("srv","no",{})).rejects.toMatchObject({kind:"denied"});
    await manager.close(); fetch.mockRestore();
  });
  it("reports missing OAuth credentials as auth failures", async () => {
    const manager=new MCPManager([{id:"srv",type:"http",url:"https://example.test",oauth:{tokenEnv:"MISSING_PI_MCP_TOKEN"}}]);
    await expect(manager.discover("srv")).rejects.toBeInstanceOf(MCPError);
    await expect(manager.discover("srv")).rejects.toMatchObject({kind:"auth"});
  });
});

const STDIO_FIXTURE = String.raw`import { createInterface } from "node:readline";
import { existsSync, writeFileSync } from "node:fs";
const [crashFlag = "", mode = ""] = process.argv.slice(2);
const write = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.id === undefined) return;
  const reply = (result) => write({ id: msg.id, result });
  if (msg.method === "initialize") {
    if (mode === "fail-init") return write({ id: msg.id, error: { code: -32000, message: "init refused" } });
    const init = () => reply({ protocolVersion: "2025-11-25", capabilities: {}, serverInfo: { name: "fixture", version: "1" } });
    return mode === "slow-init" ? setTimeout(init, 300) : init();
  }
  if (msg.method === "tools/list") return reply({ tools: [{ name: "echo", inputSchema: { type: "object" } }] });
  if (msg.method === "resources/list") {
    reply({ resources: [] });
    if (mode === "exit-idle") setTimeout(() => process.exit(0), 50);
    return;
  }
  if (msg.method === "tools/call") {
    if (crashFlag && !existsSync(crashFlag)) { writeFileSync(crashFlag, "crashed"); process.exit(3); }
    return reply({ content: [{ type: "text", text: "ok" }] });
  }
  return reply({});
});
`;

async function waitUntil(check: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("condition not met");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

describe("MCP connection lifecycle", () => {
  let dir: string;
  let fixture: string;
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "mcp-fixture-")); fixture = join(dir, "server.mjs"); writeFileSync(fixture, STDIO_FIXTURE); });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const stdio = (id: string, crashFlag: string, mode: string): MCPManifest => ({ id, type: "stdio", command: process.execPath, args: [fixture, crashFlag, mode] });

  it("drops a stdio server whose process exits mid-call and reconnects on the next call", async () => {
    const registered: any[] = [];
    const changes = vi.fn();
    const manager = new MCPManager([stdio("crash", join(dir, "crash-mid-call"), "")], { registerTool: t => registered.push(t), onConnectionChange: changes });
    await manager.discover("crash");
    expect(manager.connectedServers()).toEqual(["crash"]);
    await expect(manager.call("crash", "echo", {})).rejects.toMatchObject({ kind: "transport" });
    expect(manager.connectedServers()).toEqual([]);
    expect(changes).toHaveBeenCalledTimes(2);
    await expect(manager.call("crash", "echo", {})).resolves.toMatchObject({ content: [{ text: "ok" }] });
    expect(manager.connectedServers()).toEqual(["crash"]);
    expect(registered.map(t => t.name)).toEqual(["mcp__crash__echo"]);
    await manager.close();
  });

  it("notices a stdio exit while idle without any call", async () => {
    const manager = new MCPManager([stdio("idle", "", "exit-idle")]);
    await manager.discover("idle");
    expect(manager.connectedServers()).toEqual(["idle"]);
    await waitUntil(() => manager.connectedServers().length === 0);
    await manager.close();
  });

  it("cancels a pending discovery that closes before it finishes", async () => {
    const changes = vi.fn();
    const manager = new MCPManager([stdio("slow", "", "slow-init")], { onConnectionChange: changes });
    const pending = manager.discover("slow");
    await manager.close();
    await expect(pending).rejects.toMatchObject({ kind: "transport" });
    expect(manager.connectedServers()).toEqual([]);
    expect(changes).not.toHaveBeenCalled();
    await expect(manager.discover("slow")).resolves.toHaveLength(1);
    expect(manager.connectedServers()).toEqual(["slow"]);
    await manager.close();
  });

  it("leaves no connection when initialize is refused", async () => {
    const manager = new MCPManager([stdio("refuse", "", "fail-init")]);
    await expect(manager.discover("refuse")).rejects.toMatchObject({ kind: "server" });
    expect(manager.connectedServers()).toEqual([]);
    await manager.close();
  });

  it("drops an HTTP server after an observed transport failure and reconnects", async () => {
    let down = false;
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init: any) => {
      const body = JSON.parse(init.body);
      if (down && body.method === "tools/call") throw new TypeError("fetch failed");
      const result = body.method === "tools/list" ? { tools: [{ name: "echo", inputSchema: { type: "object" } }] }
        : body.method === "tools/call" ? { content: [{ type: "text", text: "ok" }] }
        : body.method === "resources/list" ? { resources: [] } : {};
      return new Response(JSON.stringify({ result }), { status: 200 });
    });
    const manager = new MCPManager([{ id: "remote", type: "http", url: "https://example.test/mcp" }]);
    await manager.discover("remote");
    down = true;
    await expect(manager.call("remote", "echo", {})).rejects.toMatchObject({ kind: "transport" });
    expect(manager.connectedServers()).toEqual([]);
    down = false;
    await expect(manager.call("remote", "echo", {})).resolves.toMatchObject({ content: [{ text: "ok" }] });
    expect(manager.connectedServers()).toEqual(["remote"]);
    await manager.close();
    fetch.mockRestore();
  });
});
