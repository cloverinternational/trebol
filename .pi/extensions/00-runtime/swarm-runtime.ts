import { resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { Policy } from "../../../packages/policy/policy/src/index.ts";
import { AgentManager, createPiRunner, registerAgents } from "../../../packages/tools/agents/src/index.ts";
import { MCPManager } from "../../../packages/tools/mcp/src/index.ts";
import { registerSwarmPrompt } from "../10-context/swarm-prompt.ts";
import { DaemonRpcClient, createDaemonControlTask } from "../../../packages/runtime/runtime-contracts/src/daemon-rpc.ts";
import { registerControlTaskTools } from "../30-tools/control-task-tools.ts";
import { withDefaultToolRenderer } from "../../../packages/runtime/core/src/tool-renderer.ts";
import { pushStartupNotice } from "../../lib/ui/startup-notices.ts";

type RuntimeState = { initialized: boolean; cwd: string; agents?: AgentManager; policy?: Policy; mcp?: MCPManager; daemon?: DaemonRpcClient; daemonStatus: "configured" | "unavailable"; };
const runtimeByPi = new WeakMap<object, RuntimeState>();

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
      if (!servers || typeof servers !== "object" || Array.isArray(servers)) continue;
      return Object.entries(servers).map(([id, value]: [string, any]) => ({ id, enabled: value?.enabled !== false, ...value, type: value?.type ?? (value?.command ? "stdio" : "http") }));
    } catch { return []; }
  }
  return [];
}

/** Single integration boundary for the Pi-Swarm extensions. */
export function registerSwarmRuntime(pi: Pi, options: { cwd?: string; closed?: boolean; allowedTools?: string[]; allowedSkills?: string[]; allowMutation?: boolean; allowNetwork?: boolean; daemonSocket?: string; daemonToken?: string; daemonTimeoutMs?: number } = {}): RuntimeState {
  const cwd = resolve(options.cwd ?? pi.getCwd?.() ?? process.cwd());
  const existing = runtimeByPi.get(pi as object);
  if (existing?.initialized && existing.cwd === cwd) return existing;
  const socketPath = options.daemonSocket ?? process.env.PI_SWARM_DAEMON_SOCKET;
  const token = options.daemonToken ?? process.env.PI_SWARM_DAEMON_TOKEN;
  const configured = Boolean(socketPath && token);
  const state: RuntimeState = { initialized: true, cwd, daemonStatus: configured ? "configured" : "unavailable" };
  // Construction is inert; DaemonRpcClient opens a socket only when a call is made.
  const unavailable = (name: string) => new Proxy({}, { get: () => async () => { throw new Error("Pi-Swarm daemon unavailable: configure PI_SWARM_DAEMON_SOCKET and PI_SWARM_DAEMON_TOKEN (" + name + ")"); } }) as any;
  const daemon = configured ? new DaemonRpcClient({ socketPath: socketPath!, token: token!, timeoutMs: options.daemonTimeoutMs }) : undefined;
  state.daemon = daemon;
  // Session-local /goal and /loop belong to swarm-goal, not the daemon UI.
  registerControlTaskTools(pi, daemon ? createDaemonControlTask(daemon) : unavailable("goal/task/run"));
  pi.registerTool?.(withDefaultToolRenderer({ name: "daemon_status", label: "daemon status", description: "Show production daemon configuration status.", parameters: { type: "object", properties: {} }, execute: async () => ({ content: [{ type: "text", text: JSON.stringify({ status: state.daemonStatus, configured }) }], details: { status: state.daemonStatus, configured } }) }));
  runtimeByPi.set(pi as object, state);

  // Establish prompt and resource policy before feature registration.
  registerSwarmPrompt(pi);
  state.policy = new Policy({ workspace: cwd, allowedTools: options.allowedTools, allowMutation: options.allowMutation, allowNetwork: options.allowNetwork });

  // Dedicated extensions own tool registration; the umbrella only owns shared
  // policy/identity and must never register duplicate tools.

  state.agents = registerAgents({ ...pi, registerTool: (tool: any) => pi.registerTool(withDefaultToolRenderer(tool)) }, new AgentManager({ cwd, concurrency: 4, runner: createPiRunner(pi) }));
  let manifests: any[] = [];
  const discoverMcp = async () => {
    try {
      manifests = loadMcpManifests(pi, cwd).filter(m => m.enabled !== false);
      await state.mcp?.close();
      state.mcp = new MCPManager(manifests, { closed: options.closed ?? true, registerTool: tool => pi.registerTool(withDefaultToolRenderer(tool as any)) });
      for (const manifest of manifests) if (manifest.lazy !== true) await state.mcp.discover(manifest.id);
      pi.setActiveTools?.(Array.from(new Set([...(pi.getActiveTools?.() ?? []), ...(pi.getAllTools?.() ?? []).map((t: any) => t.name).filter((n: string) => n.startsWith("mcp__"))])));
    } catch (error) {
      state.mcp = undefined;
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
      if (!id) return ctx.ui?.notify?.("Usage: /mcp discover <server>", "warning");
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
    // The installed adapter owns /mcp, resources, prompts and authentication.
    // Do not open a second connection using a different config dialect.
    if ((pi.getCommands?.() ?? []).some((command: any) => command.name === "pi-mcp")) return;
    await discoverMcp();
  });
  pi.on?.("session_shutdown", () => { void state.mcp?.close(); state.mcp = undefined; state.daemon?.close(); });
  pi.registerCommand?.("swarm-runtime", { description: "Inspect integrated Pi-Swarm runtime", handler: async (_args: string, ctx: any) => ctx.ui?.notify?.(`Pi-Swarm runtime active at ${cwd}; mcp=${manifests.length}`, "info") });
  return state;
}

export default function swarmRuntimeExtension(pi: Pi) { return registerSwarmRuntime(pi); }
