import { expect, it, vi } from "vitest";
import { dispatchRegisteredHook, noteHookTurn, registerHook, HOOK_WARMUP_TURNS } from "../../lib/runtime/hook-state.ts";
function host(id: string) {
  // Hooks are dormant for the first HOOK_WARMUP_TURNS turns of a session, so a
  // session that is meant to dispatch has to be past warm-up.
  for (let turn = 0; turn < HOOK_WARMUP_TURNS + 1; turn++) noteHookTurn(id);
  const handlers = new Map<string, Function[]>();
  const pi = { on: (name: string, fn: Function) => handlers.set(name, [...handlers.get(name) ?? [], fn]), appendEntry: vi.fn() };
  const ctx = { sessionManager: { getSessionId: () => id } };
  return { pi, ctx, emit: async (name: string) => { for (const fn of handlers.get(name) ?? []) await fn({}, ctx); } };
}
it("preserves same-group handlers and isolates sessions/shutdown", async () => {
  const a = host("hook-a"), b = host("hook-b"); const first = vi.fn(), second = vi.fn(), other = vi.fn();
  registerHook(a.pi, "taskmanage", "tool_call", first);
  registerHook(a.pi, "taskmanage", "tool_call", second);
  registerHook(b.pi, "taskmanage", "tool_call", other);
  try {
    await a.emit("session_start"); await b.emit("session_start");
    await dispatchRegisteredHook("tool_call", { toolName: "Read", toolCallId: "one" }, a.ctx);
    expect(first).toHaveBeenCalledTimes(1); expect(second).toHaveBeenCalledTimes(1); expect(other).not.toHaveBeenCalled();
    await a.emit("session_shutdown");
    await dispatchRegisteredHook("tool_call", { toolName: "Read", toolCallId: "two" }, a.ctx);
    expect(first).toHaveBeenCalledTimes(1); expect(second).toHaveBeenCalledTimes(1);
    await dispatchRegisteredHook("tool_call", { toolName: "Read", toolCallId: "three" }, b.ctx);
    expect(other).toHaveBeenCalledTimes(1);
  } finally { await a.emit("session_shutdown"); await b.emit("session_shutdown"); }
});
it("rejects fallback dispatch without session identity", async () => {
  await expect(dispatchRegisteredHook("tool_call", {}, {})).rejects.toThrow("session identity");
});
