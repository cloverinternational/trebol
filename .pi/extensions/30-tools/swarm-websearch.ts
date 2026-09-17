import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { MCPError, MCPManager, type MCPManifest } from "../../../packages/tools/mcp/src/index.ts";

const CONFIG_ENV = "PI_SWARM_WEBSEARCH_CONFIG";
const DEFAULT_CONFIG = ".pi/config/swarm-websearch.json";
type Pi = { getCwd?: () => string; registerCommand?: (name: string, spec: any) => void; registerTool?: (tool: unknown) => void; on?: (event: string, handler: (...args: any[]) => void) => void };
type WebSearchConfig = { enabled?: boolean; server?: MCPManifest };

function loadConfig(cwd: string) {
  const configured = process.env[CONFIG_ENV]?.trim();
  const path = configured ? (isAbsolute(configured) ? configured : resolve(cwd, configured)) : resolve(cwd, DEFAULT_CONFIG);
  let raw: WebSearchConfig;
  try { raw = JSON.parse(readFileSync(path, "utf8")) as WebSearchConfig; }
  catch (error: any) { return error?.code === "ENOENT" ? { path } : { path, error: "configuration is not valid JSON" }; }
  if (raw.enabled === false) return { path };
  if (!raw.server || typeof raw.server !== "object") return { path, error: "configuration must contain a server manifest" };
  return { path, manifest: { ...raw.server, enabled: raw.server.enabled !== false } };
}

function safeError(error: unknown): string {
  if (error instanceof MCPError) return `${error.kind}: ${error.message}`;
  return error instanceof Error ? error.message : "MCP discovery failed";
}

/** Provider-neutral bridge for one explicitly configured remote MCP server. */
export default function swarmWebsearchExtension(pi: Pi) {
  const cwd = resolve(pi.getCwd?.() ?? process.cwd());
  let manager: MCPManager | undefined;
  let status: Record<string, unknown> = { state: "unconfigured" };

  const discover = async () => {
    const loaded = loadConfig(cwd);
    if (loaded.error) return (status = { state: "error", error: loaded.error });
    if (!loaded.manifest) return (status = { state: "unconfigured", config: loaded.path });
    try {
      await manager?.close();
      manager = new MCPManager([loaded.manifest], { closed: true, registerTool: (tool) => pi.registerTool?.(tool) });
      const tools = await manager.discover(loaded.manifest.id);
      return (status = { state: "ready", server: loaded.manifest.id, tools: tools.map((tool) => tool.name) });
    } catch (error) {
      await manager?.close(); manager = undefined;
      return (status = { state: "error", error: safeError(error) });
    }
  };

  pi.on?.("session_start", () => { void discover(); });
  pi.on?.("session_shutdown", () => { void manager?.close(); manager = undefined; });
  pi.registerCommand?.("swarm-websearch", { description: "Show or discover the configured web-search MCP server", handler: async (args: string) => args.trim() === "discover" ? discover() : status });
  return { discover };
}
