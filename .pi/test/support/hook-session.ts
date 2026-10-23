import { HOOK_WARMUP_TURNS, noteHookTurn } from "../../lib/runtime/hook-state.ts";

let sessions = 0;

/**
 * A Pi hook context for a session that is already past hook warm-up.
 *
 * `registerHook` keeps every hook dormant for the first `HOOK_WARMUP_TURNS`
 * turns of a session and counts turns from Pi's `turn_start` events, keyed by
 * the context's `sessionManager.getSessionId()` (see
 * `.pi/lib/runtime/hook-state.ts`). A test that asserts a per-turn hook —
 * a tool gate, a result rewrite, a nudge — has to model that history, otherwise
 * the gate is closed and the hook never runs. Each call gets its own session
 * id, so one test's turns never leak into another's.
 */
export function establishedHookContext<T extends Record<string, unknown> = Record<string, never>>(
  extra: T = {} as T,
  options: { id?: string; turns?: number } = {},
) {
  const id = options.id ?? `hook-session-${++sessions}`;
  for (let turn = 0; turn < (options.turns ?? HOOK_WARMUP_TURNS + 1); turn++) noteHookTurn(id);
  return { ...extra, sessionManager: { getSessionId: () => id } };
}

/** Records one more turn for an existing context created by `establishedHookContext`. */
export function recordTurn(ctx: { sessionManager: { getSessionId(): string } }): void {
  noteHookTurn(ctx.sessionManager.getSessionId());
}
