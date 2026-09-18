import { describe, expect, it } from "vitest";
import worker, { WORKER_TOOLS } from "../../lib/state/memory-maintenance-worker.ts";

describe("memory maintenance worker contract", () => {
  it("exports only the two isolated tools", () => expect(WORKER_TOOLS).toEqual(["memory_evidence", "memory_history", "supervisor_review", "supervisor_task_proposal"]));
  it("requires worker mode and snapshot", () => { const pi: any = { on() {}, registerTool() {} }; expect(() => worker(pi)).toThrow(/worker mode/); });
});
