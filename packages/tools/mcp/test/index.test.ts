import { describe, expect, it, vi } from "vitest";
import { MCPError, MCPManager, validateManifest } from "../src/index.js";

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
