import { expect, it, vi } from "vitest";
import { HOOK_WARMUP_TURNS, noteHookTurn, registerHook } from "../../lib/runtime/hook-state.ts";

// Hook warm-up is a per-turn notion: `registerHook` keeps hooks dormant for the
// first HOOK_WARMUP_TURNS turns, counted from Pi's turn_start. A session
// boundary happens once, and session_start happens while the count is still 0,
// so gating it would make it unreachable rather than dormant — a disk hook's
// SessionStart command would never run.
it("runs a session boundary hook before the first turn while per-turn hooks stay dormant", async () => {
  const id = "fresh-boundary-session";
  const handlers = new Map<string, Function[]>();
  const pi = { on: (name: string, fn: Function) => handlers.set(name, [...handlers.get(name) ?? [], fn]), appendEntry: vi.fn() };
  const boundary = vi.fn(), perTurn = vi.fn();
  registerHook(pi, "disk-hooks", "session_start", boundary);
  registerHook(pi, "taskmanage", "tool_call", perTurn);
  const ctx = { sessionManager: { getSessionId: () => id } };
  for (const fn of handlers.get("session_start") ?? []) await fn({}, ctx);
  expect(boundary).toHaveBeenCalledTimes(1);
  for (let call = 0; call < HOOK_WARMUP_TURNS; call++) {
    for (const fn of handlers.get("tool_call") ?? []) await fn({ toolName: "write" }, ctx);
  }
  expect(perTurn).not.toHaveBeenCalled();
  // The gate opens once more than HOOK_WARMUP_TURNS turns have elapsed.
  for (let turn = 0; turn < HOOK_WARMUP_TURNS + 1; turn++) noteHookTurn(id);
  for (const fn of handlers.get("tool_call") ?? []) await fn({ toolName: "write" }, ctx);
  expect(perTurn).toHaveBeenCalledTimes(1);
});
