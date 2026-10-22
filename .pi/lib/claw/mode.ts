/** Claw routing mode for one Pi process. While /claw is on in this session, the single `Agent` tool routes to
 *  Claw spawn, and alternate spawners are hidden from the model and blocked at tool_call. State is process-local:
 *  a session transition restores the tools captured at /claw on. The store control (triggers, daemon) is separate. */
export const CLAW_MODE = Symbol.for("pi-swarm-claw-mode");
export const CLAW_AGENT_ROUTE = Symbol.for("pi-swarm-claw-agent-route");

/** Spawners hidden from the model and refused at runtime while Claw is on. `Agent` is not listed: it is the one
 *  Claw-backed tool and its legacy implementation is never reached (see packages/tools/agents). */
export const CLAW_EXCLUDED_TOOLS: readonly string[] = [
	"Subagent", "BackgroundTask", "Delegate", "DelegateOutput", "SubagentOutput", "TaskOutput", "AgentControl",
	"wait_for_agent", "multi_agent_wait",
];

/** Orchestrator-only tools. Pi activates registered tools by default, so these are removed from the active set while
 *  Claw is off, and are never captured as the prior set. */
export const CLAW_ORCHESTRATOR_TOOLS: readonly string[] = ["claw_spawn", "claw_list", "claw_read", "claw_send", "claw_cancel", "claw_trigger"];

export type ClawModeState = { on: boolean; savedTools?: string[] };
export type ClawAgentRoute = (input: Record<string, unknown>, ctx: unknown) => Promise<unknown>;

const state = (): ClawModeState => ((globalThis as any)[CLAW_MODE] ??= { on: false }) as ClawModeState;
export const clawModeOn = (): boolean => state().on;
export function setClawMode(on: boolean, savedTools?: string[]): void {
	const s = state();
	s.on = on;
	s.savedTools = on ? savedTools : undefined;
}
export const savedClawTools = (): string[] | undefined => state().savedTools;

/** Installed by the orchestrator extension; the Agent tool calls it only while Claw is on. */
export function setClawAgentRoute(route: ClawAgentRoute | undefined): void { (globalThis as any)[CLAW_AGENT_ROUTE] = route; }
export const clawAgentRoute = (): ClawAgentRoute | undefined => (globalThis as any)[CLAW_AGENT_ROUTE];

/** Active tool names for the Claw surface. Off: unchanged. On: alternate spawners removed, the registered Agent kept
 *  (Agent is not in the Swarm contract surface, so gating alone would leave it inactive), and the orchestrator tools added. */
export function clawRoutedTools(names: readonly string[], available: readonly string[] = names): string[] {
	if (!clawModeOn()) return [...names];
	const kept = names.filter((name) => !CLAW_EXCLUDED_TOOLS.includes(name));
	for (const name of ["Agent", ...CLAW_ORCHESTRATOR_TOOLS]) if (available.includes(name) && !kept.includes(name)) kept.push(name);
	return kept;
}
export const withoutOrchestratorTools = (names: readonly string[]): string[] => names.filter((name) => !CLAW_ORCHESTRATOR_TOOLS.includes(name));
