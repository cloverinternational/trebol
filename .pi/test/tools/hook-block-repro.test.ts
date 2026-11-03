import { describe, expect, it } from "vitest";
import { registerTaskManageExtension } from "../../../extensions/taskmanage/extension.ts";
import { establishedHookContext } from "../support/hook-session.ts";

// Minimal reproduction of the task-enforcement block class (GitHub #293, #352, #264, #217, #219).
// Drives the real default TaskManage adapter through its tool_call handlers.
function harness() {
  const handlers = new Map<string, Function[]>();
  const pi = {
    on: (n: string, f: Function) => handlers.set(n, [...(handlers.get(n) ?? []), f]),
    appendEntry() {},
    registerTool() {},
  };
  const { manager } = registerTaskManageExtension(pi as any);
  const ctx = establishedHookContext({ hasUI: true });
  async function gate(toolName: string, input: any = {}) {
    const results: any[] = [];
    for (const f of handlers.get("tool_call") ?? []) results.push(await f({ toolName, input, toolCallId: Math.random().toString() }, ctx));
    return results.find(r => r?.block);
  }
  return { manager, gate };
}

describe("task-enforcement block repro", () => {
  it("#293 gate: a focused (in_progress + active) task unlocks acting tools", async () => {
    const { manager, gate } = harness();
    // `echo` is a read-only Bash call and is exempt by design, so use a mutating command.
    expect(await gate("Bash", { command: "npm test" })).toMatchObject({ block: true });
    manager.execute({ operations: [{ key: "t", op: "create", subject: "Work", questions: [{ id: "q", text: "Done?" }], status: "in_progress", active: true }] });
    expect(await gate("Bash", { command: "npm test" })).toBeUndefined();
  });

  it("#293 gate: in_progress but explicitly not focused (active:false) still blocks", async () => {
    const { manager, gate } = harness();
    // create() coerces in_progress to active:true (task-manage.ts:889), so build the unfocused state via update.
    manager.execute({ operations: [{ key: "t", op: "create", subject: "Work", questions: [{ id: "q", text: "Done?" }] }] });
    manager.execute({ operations: [{ key: "s", op: "update", taskId: "1", status: "in_progress", active: false }] });
    expect(await gate("apply_patch", { input: "p" })).toMatchObject({ block: true });
  });

  it("#352 repro: read-only claw_read is blocked with no focused task (expected: allowed)", async () => {
    const { gate } = harness();
    // Current behaviour: claw_read is absent from READ_ONLY_DOMAIN_TOOLS (swarm-toolclass.ts:65-72).
    expect(await gate("claw_read", { run_id: "x" })).toMatchObject({ block: true });
  });

  it("#264 regression guard: memory_history search is exempt, memory_history remember is not", async () => {
    const { gate } = harness();
    expect(await gate("memory_history", { operation: "search" })).toBeUndefined();
    expect(await gate("memory_history", { operation: "remember" })).toMatchObject({ block: true });
  });

  it("#219/#217 shape: TaskManage itself is never blocked, so a task can always be created", async () => {
    const { gate } = harness();
    expect(await gate("TaskManage", { operations: [] })).toBeUndefined();
  });
});

describe("warm-up boundary (hook-state.ts HOOK_WARMUP_TURNS)", () => {
  it("a cold session (no counted turns) is not gated, so the first turns fail open", async () => {
    const handlers = new Map<string, Function[]>();
    const pi = { on: (n: string, f: Function) => handlers.set(n, [...(handlers.get(n) ?? []), f]), appendEntry() {}, registerTool() {} };
    registerTaskManageExtension(pi as any);
    const cold = { sessionManager: { getSessionId: () => "cold-session-repro" }, hasUI: true };
    const results: any[] = [];
    for (const f of handlers.get("tool_call") ?? []) results.push(await f({ toolName: "apply_patch", input: { input: "p" }, toolCallId: "c1" }, cold));
    expect(results.find(r => r?.block)).toBeUndefined();
  });
});
