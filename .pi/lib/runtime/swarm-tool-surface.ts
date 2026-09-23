import { taskManageSchema } from "../../../packages/tools/taskmanage/src/task-manage.ts";
/**
 * Canonical model-facing tool surface, owned locally in `tool-contracts.ts`.
 * Each tool's advertised description and JSON Schema live there; runtime input
 * validation stays inside each tool implementation.
 *
 * Wrap the extension API once at registration time:
 *   registerFoo(withSwarmToolSurface(pi))
 */
import { withDefaultToolRenderer } from "../../../packages/runtime/core/src/tool-renderer.ts";
import { TOOL_CONTRACTS } from "./tool-contracts.ts";

export interface CanonicalTool { name: string; description: string; parameters: unknown }

/** Tools that are only registered in the interactive TUI. */
const INTERACTIVE_TOOLS = new Set(["Bash", "ReadBackgroundCommand", "ask_user_question", "enter_plan_mode", "exit_plan_mode"]);
/** Tools gated behind xAI credentials. */
const CONDITIONAL_TOOLS = new Set(["x_search", "xai_web_search"]);
let conditionalCache: Map<string, CanonicalTool> | undefined;
let cache: Map<string, CanonicalTool> | undefined;

const contractsFor = (names: (name: string) => boolean) =>
  new Map(Object.entries(TOOL_CONTRACTS).filter(([name]) => names(name)).map(([name, contract]) => [name, { name, ...contract }]));

/** The always-on tool surface: everything not interactive-only or credential-gated. */
export function loadSwarmToolSurface(): Map<string, CanonicalTool> {
  if (!cache) cache = contractsFor((name) => !INTERACTIVE_TOOLS.has(name) && !CONDITIONAL_TOOLS.has(name));
  return cache;
}
/** Always-on plus environment-gated definitions, for description/schema overlay by name. */
export function loadSwarmCanonicalTools(): Map<string, CanonicalTool> {
  if (!conditionalCache) conditionalCache = contractsFor(() => true);
  // TaskManage's schema is owned by the tool module itself.
  const task = conditionalCache.get("TaskManage");
  if (task) conditionalCache.set("TaskManage", {...task, parameters:taskManageSchema,
    description:"Manage ordered tasks. Every new task requires 1–12 task-specific questions {id,text}. Complete with answers [{question,answer,evidence}] covering every question in the same update; evidence must be workspace file#Heading or file#Lx-Ly. Repair questionless legacy tasks before activation/completion. Parent completion requires finished children. Use parentTaskId for hierarchy and addBlockedBy for dependencies. Atomic batches roll back on failure. Read errors and change invalid input before retrying; never fabricate answers."});
  return conditionalCache;
}

export function swarmToolNames(): string[] { return [...loadSwarmToolSurface().keys()]; }

/**
 * Tool arguments are validated by each tool implementation, which reports its
 * own error prose, rather than by Pi's generic schema validator. Pi would
 * otherwise validate against `tool.parameters` before any hook runs
 * (pi-agent-core prepareToolCall) and report `Validation failed for tool
 * "X": …`, pre-empting the tool's own message. Tools therefore register with
 * this permissive validator schema, and the real schema is overlaid on the
 * wire by `overlaySwarmToolSchemas` (before_provider_request) so the model
 * still sees the full contract.
 */
export const PERMISSIVE_PARAMETERS = { type: "object" } as const;

/**
 * Tools that validate their own arguments and report better errors than the
 * generic validator, which would otherwise pre-empt them (it runs in
 * prepareToolCall, before any hook or the tool body).
 *
 * Everything else advertises and is checked against its real schema, so a
 * malformed call is rejected instead of reaching the tool and failing late.
 * Keep this list short: an entry is a promise that the tool checks its input.
 */
export const VALIDATES_OWN_ARGUMENTS: ReadonlySet<string> = new Set([
  // Reports per-operation, per-index errors naming the field and its bound.
  "TaskManage",
  // "query is required", handle-count limits, and mutual-exclusion errors.
  "x_search",
  "xai_web_search",
  // Accepts file_path, file, path, and filename; the schema names only the
  // first, so enforcing it would reject calls that work today.
  "Read",
  // Argument errors name the offending field and the accepted values.
  "Paseo",
  "monitor_agent",
  // Reports "agent_ids must be an array", "task cannot be empty", etc.
  "BackgroundTask",
  "Subagent",
  "SubagentOutput",
  "TaskOutput",
  "Delegate",
  "DelegateOutput",
  "multi_agent_wait",
  "wait_for_agent",
  // Reports regex, scope, field, ordering, and workspace errors in prose.
  "HistorySearch",
  "HistoryGet",
  // Report "command is required" and name the valid actions and task_id rules;
  // `background` is an execution parameter the manager interprets itself.
  "bash",
  "Bash",
  "ReadBackgroundCommand",
]);

/** Overlay Swarm's canonical description onto a Pi tool definition by name and relax its validator. */
export function applySwarmSurface<T extends { name: string; description?: string; parameters?: unknown }>(tool: T): T {
  const canonical = loadSwarmCanonicalTools().get(tool.name);
  const surfaced = canonical
    ? {
        ...tool,
        description: canonical.description,
        // Tools listed in VALIDATES_OWN_ARGUMENTS report richer prose than the
        // generic validator, so they keep a permissive schema and check their
        // own input; everything else is enforced against its real schema.
        parameters: VALIDATES_OWN_ARGUMENTS.has(tool.name) ? { ...PERMISSIVE_PARAMETERS } : canonical.parameters,
      }
    : tool;
  return withDefaultToolRenderer(surfaced) as T;
}

/**
 * Replace `tools[].function.parameters` (and description) with the canonical
 * Swarm schema for every tool Swarm knows. Returns undefined when nothing
 * changed. Anthropic-shaped payloads (`input_schema`) are handled too.
 */
export function overlaySwarmToolSchemas<T extends { tools?: unknown }>(payload: T): T | undefined {
  const tools = payload?.tools;
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  const surface = loadSwarmCanonicalTools();
  let changed = false;
  const next = tools.map((tool: any) => {
    const fn = tool?.function;
    if (fn && typeof fn === "object") {
      const canonical = surface.get(fn.name);
      if (!canonical) return tool;
      if (fn.description === canonical.description && JSON.stringify(fn.parameters) === JSON.stringify(canonical.parameters)) return tool;
      changed = true;
      return { ...tool, function: { ...fn, description: canonical.description, parameters: structuredClone(canonical.parameters) } };
    }
    if (typeof tool?.name === "string" && "input_schema" in tool) {
      const canonical = surface.get(tool.name);
      if (!canonical) return tool;
      if (tool.description === canonical.description && JSON.stringify(tool.input_schema) === JSON.stringify(canonical.parameters)) return tool;
      changed = true;
      return { ...tool, description: canonical.description, input_schema: structuredClone(canonical.parameters) };
    }
    return tool;
  });
  return changed ? { ...payload, tools: next } : undefined;
}

/** Unwraps a `withSwarmToolSurface` proxy so registries keyed by the Pi instance stay stable. */
export const RAW_PI = Symbol.for("pi-swarm-raw-pi");
export const rawPi = <P extends object>(pi: P): P => ((pi as any)[RAW_PI] as P | undefined) ?? pi;
/** Return a `pi` facade whose registerTool applies the Swarm surface overlay. */
export function withSwarmToolSurface<P extends { registerTool?: (tool: any) => void }>(pi: P): P {
  if (!pi.registerTool) return pi;
  const original = pi.registerTool.bind(pi);
  return new Proxy(pi, {
    get(target, prop, receiver) {
      if (prop === RAW_PI) return rawPi(target);
      if (prop === "registerTool") return (tool: any) => {
        const surfaced = applySwarmSurface(tool);
        const wrap = (globalThis as any)[Symbol.for("pi-swarm-wrap-tool-for-hook-rows")];
        original(typeof wrap === "function" ? wrap(surfaced) : surfaced);
      };
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
