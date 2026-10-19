/**
 * Which tools this harness exposes to the model, and under which conditions.
 *
 *  - the always-on tools declared in runtime/tool-contracts.ts
 *  - ask_user_question          only when a QuestionBroker exists (interactive TUI)
 *  - enter_plan_mode/exit_plan_mode only when a PlanBroker exists (interactive TUI)
 *  - Bash + ReadBackgroundCommand instead of bash when a BackgroundProcessManager exists (interactive TUI)
 *
 * Anything Pi registers beyond this list is Pi-only and is hidden from the
 * model surface unless it is required by the active global policy below,
 * explicitly configured, or PI_SWARM_TOOL_SURFACE=all.
 */
import { swarmToolNames } from "./swarm-tool-surface.ts";

export const INTERACTIVE_ONLY_TOOLS = ["ask_user_question", "enter_plan_mode", "exit_plan_mode", "Bash", "ReadBackgroundCommand"] as const;
/**
 * With a BackgroundProcessManager (the interactive TUI)
 * the bgprocess `Bash` + `ReadBackgroundCommand` pair replaces the plain
 * `bash` tool; headless mode has no manager and registers `bash`.
 */
export const HEADLESS_ONLY_TOOLS = ["bash"] as const;
/** Global Pi policy requires this tool before mutations such as apply_patch. */
export const REQUIRED_PI_EXTENSION_TOOLS = ["change_context", "context_index", "context_remember", "context_reindex", "context_search", "context_outline", "context_read", "context_inspect", "context_delete"] as const;

export interface GatingEnvironment {
  interactive: boolean;
  /** A TUI session without bound UI (Tern) that answers ask_user_question through remote-ask events. */
  remoteAsk?: boolean;
  home?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  /** Names positively identified from registered MCP tool definitions. */
  mcpTools?: readonly string[];
}

/** Explicit, narrow escape hatch for registered Pi extension tools. */
export function configuredExtraTools(env: NodeJS.ProcessEnv = process.env): Set<string> {
  return new Set(
    (env.PI_SWARM_EXTRA_TOOLS ?? "")
      .split(",")
      .map(name => name.trim())
      .filter(Boolean),
  );
}

/** The set of tool names Swarm would register in this environment. */
export function swarmSurfaceFor(environment: GatingEnvironment): Set<string> {
  const names = new Set<string>(swarmToolNames());
  // Pi's native CodeMode tool is a built-in surface, not a Swarm-owned tool;
  // keep it visible to the model when enabled by Pi settings.
  names.add("codemode");
  // Durable memory is a Pi-Swarm state extension, not part of the upstream
  // Swarm wire fixture, but it is an intentional model-facing capability.
  names.add("memory_history");
  // Project scaffolding is driven by the agent through /init, so the tool must
  // reach the model surface even though upstream Swarm has no equivalent.
  names.add("project_init");
  // Tern browser, pane and tab control is an intentional model-facing capability of the Tern pane.
  names.add("tern");
  for (const name of ["CronCreate", "CronList", "CronDelete", "ScheduleWakeup"]) names.delete(name);
  names.add("scheduler");
  if (environment.interactive) {
    for (const name of INTERACTIVE_ONLY_TOOLS) names.add(name);
    for (const name of HEADLESS_ONLY_TOOLS) names.delete(name);
  }
  if (environment.remoteAsk) names.add("ask_user_question");
  for (const name of REQUIRED_PI_EXTENSION_TOOLS) names.add(name);
  for (const name of configuredExtraTools(environment.env)) names.add(name);
  return names;
}

/**
 * Filter Pi's active tool names down to the Swarm surface. Returns undefined
 * when nothing would change. Tools Swarm has but Pi lacks are simply absent —
 * they are reported separately by the parity probe.
 */
export function gateActiveTools(
  active: readonly string[],
  environment: GatingEnvironment,
  env = process.env,
  available: readonly string[] = active,
): string[] | undefined {
  const candidates = [...active];
  for (const name of REQUIRED_PI_EXTENSION_TOOLS) {
    if (available.includes(name) && !candidates.includes(name)) candidates.push(name);
  }
  const next = (env.PI_SWARM_TOOL_SURFACE ?? "").toLowerCase() === "all"
    ? candidates
    : candidates.filter((name) => (swarmSurfaceFor(environment).has(name) || environment.mcpTools?.includes(name)));
  return next.length === active.length && next.every((name, index) => name === active[index])
    ? undefined
    : next;
}
