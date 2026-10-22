import { describe, expect, it } from "vitest";
import { createSwarmBuiltinPipeline, type HookTask } from "../../lib/runtime/swarm-builtin-hooks.ts";

const pipeline = (tasks: HookTask[], session: string) =>
  createSwarmBuiltinPipeline({ session, tasks: () => tasks, enforcementMode: "block", completion: { enabled: false } });

describe("claw_finish after completed task evidence", () => {
  it("allows claw_finish when the only task is completed and no task is focused", () => {
    const tasks: HookTask[] = [{ id: "1", subject: "TREBOL-302 verification", status: "completed", active: false }];
    const block = pipeline(tasks, "claw-finish-allow").preTool({ toolName: "claw_finish", params: { outcome: "completed" } }).block;
    expect(block).toBeUndefined();
  });

  it("still blocks unrelated tools in the same completed-task state", () => {
    const tasks: HookTask[] = [{ id: "1", subject: "TREBOL-302 verification", status: "completed", active: false }];
    const block = pipeline(tasks, "claw-finish-near-miss").preTool({ toolName: "apply_patch", params: {} }).block;
    expect(block).toContain("YOU CANNOT EXECUTE ANY TOOL WITHOUT A TASK");
  });

  it("still blocks claw_finish when no task has completed (unfinished work)", () => {
    const tasks: HookTask[] = [{ id: "1", subject: "unfinished", status: "in_progress", active: false }];
    const block = pipeline(tasks, "claw-finish-unfinished").preTool({ toolName: "claw_finish", params: { outcome: "completed" } }).block;
    expect(block).toContain("YOU CANNOT EXECUTE ANY TOOL WITHOUT A TASK");
  });
});
