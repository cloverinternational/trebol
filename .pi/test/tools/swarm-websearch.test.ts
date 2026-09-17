import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import extension from "../../extensions/30-tools/swarm-websearch.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); delete process.env.PI_SWARM_WEBSEARCH_CONFIG; delete process.env.TEST_MCP_TOKEN; vi.restoreAllMocks(); });
const setup = (config?: unknown) => { const root = join(tmpdir(), `swarm-websearch-${Date.now()}-${Math.random()}`); roots.push(root); mkdirSync(join(root, ".pi", "config"), { recursive: true }); if (config !== undefined) writeFileSync(join(root, ".pi", "config", "swarm-websearch.json"), JSON.stringify(config)); const tools: any[] = []; const handlers = new Map<string, any>(); const pi: any = { getCwd: () => root, registerTool: (tool: any) => tools.push(tool), registerCommand: (name: string, spec: any) => handlers.set(name, spec), on: (name: string, handler: any) => handlers.set(`event:${name}`, handler) }; const api = extension(pi); return { root, tools, handlers, api }; };

describe("swarm-websearch extension", () => {
  it("does not make a request or register tools without config", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch"); const h = setup();
    await h.handlers.get("event:session_start")();
    expect(fetchSpy).not.toHaveBeenCalled(); expect(h.tools).toHaveLength(0); expect(await h.api.discover()).toEqual({ state: "unconfigured", config: join(h.root, ".pi", "config", "swarm-websearch.json") });
  });

  it("discovers configured tools and keeps header values out of status", async () => {
    process.env.TEST_MCP_TOKEN = "secret-token";
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init: any) => {
      const body = JSON.parse(init.body);
      expect(init.headers.authorization).toBe("secret-token");
      if (body.method === "initialize") return new Response(JSON.stringify({ result: {} }));
      return new Response(JSON.stringify({ result: { tools: [{ name: "search", description: "Search", inputSchema: { type: "object" } }] } }));
    });
    const h = setup({ server: { id: "search", type: "http", url: "https://example.test/mcp", environment: ["TEST_MCP_TOKEN"], headers: { authorization: "TEST_MCP_TOKEN" }, tools: ["search"] } });
    const result: any = await h.api.discover();
    expect(result).toEqual({ state: "ready", server: "search", tools: ["search"] });
    expect(h.tools.map((tool) => tool.name)).toEqual(["mcp__search__search"]);
    expect(JSON.stringify(result)).not.toContain("secret-token");
  });

  it("fails closed for invalid JSON", async () => {
    const h = setup(); writeFileSync(join(h.root, ".pi", "config", "swarm-websearch.json"), "nope");
    expect(await h.api.discover()).toEqual({ state: "error", error: "configuration is not valid JSON" }); expect(h.tools).toHaveLength(0);
  });
});
