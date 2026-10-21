// Structural host/test adapters intentionally accept heterogeneous event and tool payloads; runtime guards narrow the fields used here.
import { resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { MCPManager } from "../../packages/tools/mcp/src/index.ts";
import { withDefaultToolRenderer } from "../../packages/runtime/core/src/tool-renderer.ts";
import { pushStartupNotice } from "../../.pi/lib/ui/startup-notices.ts";
import { clearMcpStatus, publishMcpStatus } from "../../.pi/lib/tools/mcp-status.ts";
type Pi = any;
function safeMcpError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/(authorization|api[-_]?key|token|secret|password)\s*[:=]\s*[^\s,;)}]+/gi, "$1=<redacted>");
}

function loadMcpManifests(pi: Pi, cwd: string): any[] {
  if (Array.isArray(pi.mcpManifests)) return pi.mcpManifests;
  const candidates = [resolve(cwd, ".pi/mcp.json"), resolve(cwd, ".mcp.json")];
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    try {
      const raw = JSON.parse(readFileSync(file, "utf8"));
      const servers = raw?.mcpServers ?? raw?.servers ?? raw;
      if (!servers || typeof servers !== "object" || Array.isArray(servers)) throw new Error("invalid manifest shape");
      return Object.entries(servers).map(([id, value]: [string, any]) => ({ id, enabled: value?.enabled !== false, ...value, type: value?.type ?? (value?.command ? "stdio" : "http") }));
    } catch { throw new Error("MCP configuration is invalid or unreadable"); }
  }
  return [];
}

export function registerMcpFallback(pi: Pi, options: { cwd?: string; closed?: boolean } = {}) {
  const cwd = resolve(options.cwd ?? pi.getCwd?.() ?? process.cwd());
  const state: { mcp?: MCPManager } = {};
  let manifests: any[] = [];
  let sessionId: string | undefined;
  let generation = 0;
  const discoverMcp = async () => {
    const gen = ++generation;
    try {
      manifests = loadMcpManifests(pi, cwd).filter(m => m.enabled !== false);
      await state.mcp?.close();
      if (gen !== generation) return;
      // Only the manager that is still current may publish; a closed predecessor must not overwrite the status.
      const manager: MCPManager = new MCPManager(manifests, { closed: options.closed ?? true, registerTool: tool => pi.registerTool(withDefaultToolRenderer(tool as any)), onConnectionChange: () => { if (gen === generation && state.mcp === manager) publishMcpStatus(state, manager.connectedServers(), sessionId); } });
      state.mcp = manager;
      publishMcpStatus(state, [], sessionId);
      for (const manifest of manifests) { if (gen !== generation) return; if (manifest.lazy !== true) await manager.discover(manifest.id); }
      pi.setActiveTools?.(Array.from(new Set([...(pi.getActiveTools?.() ?? []), ...(pi.getAllTools?.() ?? []).map((t: any) => t.name).filter((n: string) => n.startsWith("mcp__"))])));
    } catch (error) {
      if (gen !== generation) return;
      await state.mcp?.close();
      state.mcp = undefined;
      clearMcpStatus(state);
      pushStartupNotice(`MCP startup failed: ${safeMcpError(error)}`, "error");
    }
  };
  // Register synchronously during extension loading. Discovery is asynchronous,
  // but the slash command must exist before session_start or Pi treats /mcp as
  // ordinary model input.
  pi.registerCommand?.("swarm-mcp", { description: "Discover and inspect MCP servers", handler: async (args: string, ctx: any) => {
    if (!manifests.length) manifests = loadMcpManifests(pi, cwd).filter(m => m.enabled !== false);
    const requested = args.trim();
    if (requested === "discover" || requested.startsWith("discover ")) {
      const id = requested.slice("discover".length).trim();
      if (!id) return ctx.ui?.notify?.("Usage: /swarm-mcp discover <server>", "warning");
      try { const tools = await state.mcp?.discover(id); ctx.ui?.notify?.(`${id}: ${tools?.map((t: any) => t.name).join(", ") || "no tools"}`, "info"); }
      catch (error) { ctx.ui?.notify?.(error instanceof Error ? error.message : String(error), "error"); }
      return;
    }
    if (!state.mcp) await discoverMcp();
    if (!manifests.length) return ctx.ui?.notify?.("No MCP servers configured.", "info");
    const choice = await ctx.ui?.select?.("MCP servers", manifests.map(m => m.id));
    if (!choice) return;
    try {
      const tools = await state.mcp?.discover(choice);
      ctx.ui?.notify?.(`${choice}: ${tools?.map((t: any) => t.name).join(", ") || "no tools"}`, "info");
    } catch (error) { ctx.ui?.notify?.(error instanceof Error ? error.message : String(error), "error"); }
  }});
  pi.on?.("session_start", async (_event: unknown, ctx: any) => {
    sessionId = ctx?.sessionManager?.getSessionId?.();
    // The installed adapter owns /mcp, resources, prompts and authentication.
    // Do not open a second connection using a different config dialect.
    if ((pi.getCommands?.() ?? []).some((command: any) => command.name === "pi-mcp")) return;
    await discoverMcp();
  });
  pi.on?.("session_switch", (_event: unknown, ctx: any) => {
    clearMcpStatus(state);
    sessionId = ctx?.sessionManager?.getSessionId?.();
    if (state.mcp) publishMcpStatus(state, state.mcp.connectedServers(), sessionId);
  });
  pi.on?.("session_shutdown", () => { generation++; const old = state.mcp; state.mcp = undefined; clearMcpStatus(state); void old?.close(); });
  pi.registerCommand?.("swarm-runtime", { description: "Inspect MCP fallback (legacy command name)", handler: async (_args: string, ctx: any) => ctx.ui?.notify?.(`MCP fallback active at ${cwd}; mcp=${manifests.length}`, "info") });
  return state;
}

export default function mcpFallback(pi: Pi) { return registerMcpFallback(pi); }
