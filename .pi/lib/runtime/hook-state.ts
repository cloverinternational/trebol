import { addHookObservation } from "./hook-observations.ts";
import { installHookCorrection, correctionBlock } from "./hook-correction.ts";

export type HookGroup = "taskmanage" | "autogenskills" | "swarm-prompt" | "disk-hooks" | "annoyance" | "structure-guard";
export type HookOutcome = "executed" | "blocked" | "failed" | "skipped";
export interface HookRecord { id: string; group: HookGroup; event: string; at: string; enabled: boolean; outcome: HookOutcome; tool?: string; toolCallId?: string; reason?: string; output?: string; }
interface State { enabled: Record<string, boolean>; visible: boolean; recent: HookRecord[]; counts: { registered: number; executed: number; blocked: number; failed: number; skipped: number }; }

const KEY = Symbol.for("pi-swarm-hook-state");
type Shared = { state: State; pi?: any; present?: (data: any) => void };
const root = globalThis as typeof globalThis & { [KEY]?: Shared };
const shared: Shared = root[KEY] ?? (root[KEY] = { state: { enabled: {}, visible: false, recent: [], counts: { registered: 0, executed: 0, blocked: 0, failed: 0, skipped: 0 } } });
type RegisteredHandler = { session?: string; event: string; handler: (payload: any, ctx: any) => Promise<any> };
const registeredHandlers: RegisteredHandler[] = ((globalThis as any)[Symbol.for("pi-swarm-session-hook-handlers-v2")] ??= []);
const hookOwners = new WeakMap<object, { session?: string; entries: RegisteredHandler[] }>();
function registerSessionHandler(pi: any, entry: RegisteredHandler): void {
  let owner = hookOwners.get(pi);
  if (!owner) {
    owner = { entries: [] }; hookOwners.set(pi, owner);
    const owned = owner;
    const release = () => {
      for (const item of owned.entries) {
        const index = registeredHandlers.indexOf(item);
        if (index >= 0) registeredHandlers.splice(index, 1);
        item.session = undefined;
      }
      owned.session = undefined;
    };
    pi.on("session_start", (_event: any, ctx: any) => {
      release();
      const id = ctx?.sessionManager?.getSessionId?.();
      if (typeof id !== "string" || !id) return;
      owned.session = id;
      for (const item of owned.entries) { item.session = id; registeredHandlers.push(item); }
    });
    pi.on("session_shutdown", release);
  }
  owner.entries.push(entry);
  if (owner.session) { entry.session = owner.session; registeredHandlers.push(entry); }
}
// Pi /reload can retain Symbol.for state from an older extension module. Normalize
// it before any handler registration so upgrades never fail on missing fields.
function normalizeState() {
  if (!shared.state || typeof shared.state !== "object") shared.state = { enabled: {}, visible: false, recent: [], counts: { registered: 0, executed: 0, blocked: 0, failed: 0, skipped: 0 } };
  const state = shared.state as Partial<State>;
  state.enabled = state.enabled && typeof state.enabled === "object" ? state.enabled : {};
  state.visible = typeof state.visible === "boolean" ? state.visible : false;
  state.recent = Array.isArray(state.recent) ? state.recent.slice(-200) : [];
  state.counts = { registered: 0, executed: 0, blocked: 0, failed: 0, skipped: 0, ...(state.counts ?? {}) };
  shared.state = state as State;
}
normalizeState();

export function hookState() { normalizeState(); return shared.state; }
export function setHookPi(pi: any) { shared.pi = pi; }
export function setHookPresenter(present?: (data: any) => void) { shared.present = present; }
// Swarm `--no-hooks` / `--clean-agent` disable every builtin and custom hook
// (swarm-tui/cmd/swarmos/main.go). Pi has no such flag; PI_SWARM_NO_HOOKS=1
// is the headless equivalent so hook-driven model context (task nudges,
// annoyance reminders, skill-budget blocks) is absent exactly when Swarm's is.
export const hooksDisabledByEnv = (env: NodeJS.ProcessEnv = process.env) => /^(1|true|yes)$/i.test((env.PI_SWARM_NO_HOOKS ?? "").trim());
// "swarm-prompt" is prompt assembly (skills catalog + context injection), which
// Swarm keeps even under --no-hooks; only the real hook groups are gated.
const SWARM_HOOK_GROUPS = new Set(["taskmanage", "autogenskills", "disk-hooks", "annoyance", "structure-guard"]);
// Groups listed here start disabled until explicitly enabled with /hooks <group> on.
const DEFAULT_OFF_GROUPS = new Set(["autogenskills"]);
export function isHookEnabled(group: string) { normalizeState(); if (SWARM_HOOK_GROUPS.has(group) && hooksDisabledByEnv()) return false; return shared.state.enabled[group] ?? !DEFAULT_OFF_GROUPS.has(group); }
export function toggleHook(group: string, enabled?: boolean) { shared.state.enabled[group] = enabled ?? !isHookEnabled(group); return isHookEnabled(group); }
export function setHookVisibility(visible?: boolean) { shared.state.visible = visible ?? !shared.state.visible; return shared.state.visible; }
export function hookRowsVisible() { return shared.state.visible; }
// Terminal events are delivered once per hook group. Deduplicate the two Pi
// terminal notifications without suppressing the post row for later groups.
function eventInfo(payload: any) { return { tool: payload?.toolName ?? payload?.tool_name, toolCallId: payload?.toolCallId ?? payload?.tool_call_id }; }
// Pi's hook rows name the hook, not the host adapter or tool. These are the
// stable names used by the Swarm TUI; adapters may provide hookName explicitly.
function displayHookName(group: HookGroup, event: string, payload: any): string {
  if (typeof payload?.hookName === "string" && payload.hookName.trim()) return payload.hookName.trim();
  if (group === "autogenskills") return "autogenskills-budget-enforcement";
  if (group === "taskmanage") return payload?.hookName ?? (event === "tool_call" ? "task-enforcement-hook" : "task-maintenance-reminder-hook");
  if (group === "swarm-prompt") return "swarm-prompt";
  if (group === "annoyance") return "annoyance-nudge";
  if (group === "structure-guard") return "project-structure-guard";
  return group;
}
export function recordHook(group: HookGroup, event: string, payload?: any, outcome: HookOutcome = "executed", reason?: string, output?: string) {
  const info = eventInfo(payload), record: HookRecord = { id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, group, event, at: new Date().toISOString(), enabled: isHookEnabled(group), outcome, ...info, ...(reason ? { reason } : {}), ...(output ? { output } : {}) };
  shared.state.recent.push(record); shared.state.recent = shared.state.recent.slice(-200);
  shared.state.counts[outcome]++;
  // Successful hook observations are internal telemetry in Swarm. Only show
  // actionable outcomes in the normal Pi transcript; retain every record in
  // durable state for /hooks and diagnostics. This prevents routine lines such
  // as "read · allowed" and "bash · completed" from becoming chat noise.
  // Keep tool pre/post observations visible when requested; lifecycle and
  // prompt hooks remain telemetry-only unless they block or fail.
  // Publish tool-bound observations to the renderer data plane. This is
  // independent of visibility because the native tool renderer owns display.
  const callId = info.toolCallId;
  const toolName = info.tool;
  const isPost = event === "tool_result";
  if (callId && toolName && (event === "tool_call" || isPost)) {
    addHookObservation({ hookName: displayHookName(group, event, payload), phase: isPost ? "after" : "before", outcome, toolCallId: String(callId), toolName: String(toolName), output, reason, at: record.at });
  }
  // Rendering is owned by the per-tool renderer bridge. Never emit a queued
  // message here: queued messages cannot occupy the tool's visual slot.
  return record;
}

(globalThis as any).__piSwarmRegisterHook = registerHook;

// Hooks stay dormant for the first HOOK_WARMUP_TURNS turns of each session.
// Turns are counted from Pi's turn_start lifecycle event, so a turn is one
// assistant run (not a tool call or user message). Counts live on globalThis
// so /reload keeps them, and are keyed by session id so a new session restarts.
const HOOK_WARMUP_TURNS = 5;
const TURN_COUNTS = Symbol.for("pi-swarm-hook-turn-counts");
const TURN_LISTENER = Symbol.for("pi-swarm-hook-turn-listener");
const turnCounts: Map<string, number> = ((globalThis as any)[TURN_COUNTS] ??= new Map<string, number>());
const turnSessionKey = (ctx: any) => { const id = ctx?.sessionManager?.getSessionId?.(); return typeof id === "string" && id ? id : "session"; };
// Installed once per process: every registerHook caller passes its own pi
// object, and a per-object listener would count each turn several times.
function installTurnCounter(pi: any) {
  if ((globalThis as any)[TURN_LISTENER]) return;
  (globalThis as any)[TURN_LISTENER] = true;
  pi.on("turn_start", (_event: any, ctx: any) => { const key = turnSessionKey(ctx); turnCounts.set(key, (turnCounts.get(key) ?? 0) + 1); });
}
export function hookTurnGateOpen(ctx: any): boolean { return (turnCounts.get(turnSessionKey(ctx)) ?? 0) > HOOK_WARMUP_TURNS; }

/** `warmup: false` is for composition hooks (the base system prompt), not
 * gates: Pi emits before_agent_start once per user prompt, so a dormant prompt
 * hook leaves the whole first request on Pi's base prompt. */
export function registerHook(pi: any, group: HookGroup, event: string, handler: any, options: { warmup?: boolean } = {}) {
  installTurnCounter(pi);
  installHookCorrection(pi);
  normalizeState();
  shared.state.counts.registered++;
  const callback = async (payload: any, ctx: any) => {
    if (options.warmup !== false && !hookTurnGateOpen(ctx)) return;
    if (!isHookEnabled(group)) { recordHook(group, event, payload, "skipped", "hook group disabled"); persistHookState(pi); return; }
    try {
      const result = await handler(payload, ctx);
      const hookPayload = result?.hookName ? { ...payload, hookName: result.hookName } : payload;
      recordHook(
        group,
        event,
        hookPayload,
        result?.block === true ? "blocked" : "executed",
        result?.block === true ? result.reason ?? "blocked by hook" : undefined,
        result?.hookOutput,
      );
      persistHookState(pi);
      // Hook messages are not transcript messages. Pi treats a returned
      // `message` as model-visible context, which produced prose such as
      // "hook completed successfully" after every successful hook. Only
      // return actual middleware data (prompt changes) or a hard block.
      if (result?.block === true) return event === "tool_call"
        ? correctionBlock(pi, payload, ctx, result.reason ?? result.message)
        : { block: true, reason: result.reason };
      // Pi's native event contracts are the boundary: only return a valid
      // middleware patch for the event that requested it. In particular, a
      // hook's diagnostic `message` is never returned from tool_call, where it
      // would become a synthetic model message.
      if (event === "before_agent_start") {
        if (result?.systemPrompt === undefined && result?.message === undefined) return undefined;
        // Pi requires before_agent_start.message to be a CustomMessage, not a
        // plain string. Convert coordinator guidance at this adapter boundary;
        // keeping the coordinator host-agnostic preserves its unit-test API.
        const message = typeof result?.message === "string"
          ? { customType: "swarm-task-hook", content: result.message, display: false }
          : result?.message;
        return { ...(result?.systemPrompt !== undefined ? { systemPrompt: result.systemPrompt } : {}), ...(message !== undefined ? { message } : {}) };
      }
      if (event === "tool_result" && result && (result.content !== undefined || result.details !== undefined || result.isError !== undefined)) {
        return { ...(result.content !== undefined ? { content: result.content } : {}), ...(result.details !== undefined ? { details: result.details } : {}), ...(result.isError !== undefined ? { isError: result.isError } : {}) };
      }
      // Pi discards return values from ordinary lifecycle events such as
      // turn_end. ContinueWithMessage-style nudges are intentional model
      // context, so queue them explicitly as hidden custom messages.
      if (event === "turn_end" && typeof result?.message === "string" && result.message.trim()) {
        pi.sendMessage?.({ customType: "swarm-hook-nudge", content: result.message, display: false }, { triggerTurn: false });
      }
      return undefined;
    } catch (error) {
      recordHook(group, event, payload, "failed", error instanceof Error ? error.message : String(error)); persistHookState(pi); throw error;
    }
  };
  // Each native registration remains distinct, even within the same group.
  // Only live registrations for the caller's session participate in fallback
  // dispatch. A reload/disabling an extension must not retain its closures.
  registerSessionHandler(pi, { event, handler: callback });
  pi.on(event, callback);
}

/** Compatibility-only supervisor dispatch for contexts without executeTool.
 * Native nested tools use Pi's executor instead. This registry contains only
 * Trebol hooks, never an assertion that all third-party host hooks are covered.
 */
export async function dispatchRegisteredHook(event: string, payload: any, ctx: any = {}): Promise<any> {
  const session = ctx?.sessionManager?.getSessionId?.();
  if (typeof session !== "string" || !session) throw new Error("Hook dispatch requires an active session identity");
  let merged: any;
  for (const entry of [...registeredHandlers]) {
    if (entry.event !== event || entry.session !== session) continue;
    const result = await entry.handler(payload, ctx);
    if (result?.block === true) return result;
    if (result && typeof result === "object") merged = { ...(merged ?? {}), ...result };
  }
  return merged;
}
export function hookGroups() {
  return ["taskmanage", "autogenskills", "swarm-prompt", "disk-hooks", "annoyance", "structure-guard"] as const;
}
export function renderHookLines() {
  const s = shared.state;
  const rows = hookGroups().map(g => `${isHookEnabled(g) ? "●" : "○"} ${g}`);
  const recent = s.recent.slice(-8).map(r => `  ${r.outcome.toUpperCase()} ${r.event} → ${r.group}${r.tool ? ` · ${r.tool}` : ""}`);
  return ["Swarm hooks (Ctrl+H toggles visibility)", ...rows, `Registered ${s.counts.registered} · Executed ${s.counts.executed} · Blocked ${s.counts.blocked} · Failed ${s.counts.failed} · Skipped ${s.counts.skipped}`, "", "Recent:", ...recent];
}
export function persistHookState(pi: any) { pi.appendEntry?.("pi-swarm-hook-state", { enabled: shared.state.enabled, visible: shared.state.visible, recent: shared.state.recent, counts: shared.state.counts }); }
export function hookTelemetry() { return { counts: { ...shared.state.counts }, recent: shared.state.recent.slice(-200) }; }
export function restoreHookState(entries: readonly any[]) {
  // Extensions register before session_start; do not erase this session's
  // registration count while restoring persisted telemetry.
  const registered = shared.state.counts?.registered ?? 0;
  shared.state.enabled = {};
  shared.state.visible = false;
  shared.state.recent = [];
  shared.state.counts = { registered, executed: 0, blocked: 0, failed: 0, skipped: 0 };
  const e = [...entries].reverse().find(x => x?.type === "pi-swarm-hook-state" || x?.type === "custom" && x?.customType === "pi-swarm-hook-state")?.data;
  if (e) { shared.state.enabled = { ...(e.enabled ?? {}) }; if (typeof e.visible === "boolean") shared.state.visible = e.visible; if (Array.isArray(e.recent)) shared.state.recent = e.recent.slice(-200); if (e.counts && typeof e.counts === "object") shared.state.counts = { ...shared.state.counts, ...e.counts, registered: Math.max(registered, Number(e.counts.registered) || 0) }; }
}
