import { describe, expect, it } from "vitest";
import { AutoSkillManager, registerAutoSkills } from "../src/index.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = () => mkdtempSync(join(tmpdir(), "autogen-compaction-"));

function harness() {
  const entries: any[] = [];
  const handlers = new Map<string, any[]>();
  const pi = {
    appendEntry(type: string, data: unknown) { entries.push({ type: "custom", customType: type, data }); },
    on(name: string, handler: any) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
    registerTool() {},
  };
  const manager = registerAutoSkills(pi, { mode: "auto", dir: dir(), toolCallBudget: 3 });
  return { entries, manager, emit: (name: string, event: any, ctx: any = {}) => handlers.get(name)?.[0]?.(event, ctx) };
}

describe("autogen budget state across Pi session lifecycle", () => {
  it("persists counts after session_compact and does not reset them", () => {
    const h = harness();
    h.manager.observeTool(true, "TaskManage", { status: "in_progress", active: true });
    h.manager.observeToolAttempt("bash", {}, "before-compact");
    expect(h.manager.budgetStatus().used).toBe(1);
    h.emit("session_compact", { compactionEntry: { type: "compaction" } });
    const restored = new AutoSkillManager({ mode: "auto", dir: dir() });
    restored.rehydrate(h.entries);
    expect(restored.budgetStatus().used).toBe(1);
    expect(restored.snapshot().focusedTask).toBe(true);
  });

  it("deduplicates a late pre-compaction attempt but counts the same id in a new session", () => {
    const h = harness();
    h.manager.observeTool(true, "TaskManage", { status: "in_progress", active: true });
    h.manager.observeToolAttempt("bash", {}, "same-id");
    h.emit("session_compact", { compactionEntry: { type: "compaction" } });
    h.manager.observeToolAttempt("bash", {}, "same-id");
    expect(h.manager.budgetStatus().used).toBe(1);

    const branch = h.entries.slice();
    h.emit("session_start", {}, { sessionManager: { getBranch: () => branch } });
    h.manager.observeToolAttempt("bash", {}, "same-id");
    expect(h.manager.budgetStatus().used).toBe(2);
  });

  it("keeps a failed invocation charged once and does not make it skilled", () => {
    const h = harness();
    h.manager.observeTool(true, "TaskManage", { status: "in_progress", active: true });
    h.emit("tool_call", { toolName: "bash", toolCallId: "failed", input: {} });
    h.emit("tool_result", { toolName: "bash", toolCallId: "failed", input: {}, isError: true, content: [] });
    h.emit("tool_result", { toolName: "bash", toolCallId: "failed", input: {}, isError: true, content: [] });
    expect(h.manager.budgetStatus()).toMatchObject({ used: 1, skilled: false });
    expect(h.manager.snapshot().errors).toBe(2);
  });
});
