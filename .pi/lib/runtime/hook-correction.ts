/** Correction is a normal denied tool result in every mode. Never abort
 * model generation to speculate about arguments or restart a settled run.
 *
 * INVARIANT: a hook block never ends the agent run. Pi's agent loop stops the
 * run when every blocked result in a tool batch carries `terminate: true`
 * (pi-agent-core agent-loop.js shouldTerminateToolBatch), so a block result
 * must never set it, no matter how many times the same session was blocked.
 * Repeated blocks only change the guidance text. */
type CorrectionState = { attempts: number; seen: Set<string> };
const KEY = Symbol.for("pi-swarm-hook-correction-v2");
const state: Map<string, CorrectionState> = ((globalThis as any)[KEY] ??= new Map());
const idOf = (ctx: any) => ctx?.sessionManager?.getSessionId?.();
const guidance = "Correct the SAME logical step using the hook feedback: choose the appropriate tool or corrected arguments. Do not blindly replay the rejected call or skip the step. All permissions and hooks still apply. If no authorized correction is possible, report the blocker and ask the user.";
const repeatedGuidance = "Repeated hook blocks: do not replay the rejected call. Satisfy the hook's precondition (for the task gate: TaskManage create, then update status=\"in_progress\" with active=true) or take another authorized path, then continue the same run. Ask the user only if no authorized path exists.";
const owners = new WeakSet<object>();
export function installHookCorrection(pi: any): void {
  if (owners.has(pi)) return;
  owners.add(pi);
  pi.on("session_start", (_e: any, ctx: any) => {
    const id = idOf(ctx); if (id && !state.has(id)) state.set(id, { attempts: 0, seen: new Set() });
  });
  pi.on("input", (e: any, ctx: any) => {
    if (e.source !== "interactive" && e.source !== "rpc") return;
    const s = state.get(idOf(ctx)); if (s) { s.attempts = 0; s.seen.clear(); }
  });
  pi.on("session_shutdown", (_e: any, ctx: any) => { state.delete(idOf(ctx)); });
}

export function correctionBlock(pi: any, event: any, ctx: any, reason: string) {
  const s = state.get(idOf(ctx));
  if (s && !s.seen.has(event.toolCallId)) { s.seen.add(event.toolCallId); s.attempts++; }
  const repeated = (s?.attempts ?? 0) >= 3;
  pi.appendEntry?.("pi-swarm-hook-correction", { phase: "blocked", callId: event.toolCallId, tool: event.toolName, attempt: s?.attempts });
  if (s && s.seen.size > 256) s.seen.delete(s.seen.values().next().value!);
  return { block: true as const, reason: `${reason || "Blocked by hook"}\n\n${repeated ? repeatedGuidance : guidance}` };
}
