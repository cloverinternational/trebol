import { it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MEMORY_CEREMONY, memoryGate, memorySystemPrompt } from "../../lib/context/memory-ceremony.ts";
import { writeBootstrapSettings } from "../../../packages/runtime/bootstrap/src/store.ts";

it("persists enforcement and adds the instruction exactly once; off removes it", () => {
  const cwd = mkdtempSync(join(tmpdir(), "mem-ceremony-"));
  try {
    writeBootstrapSettings(cwd, "parallel", "", true);
    const once = memorySystemPrompt("base", cwd);
    expect(once).toContain("Memory enforcement is ON");
    expect(memorySystemPrompt(once, cwd)).toBe(once);
    writeBootstrapSettings(cwd, "parallel", "", false);
    expect(memorySystemPrompt(once, cwd)).toBe("base");
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
it("gates all ordinary tools without blocking recovery, and releases after success", () => {
  for (const name of ["Bash", "Read", "Skill", "codemode", "Subagent"]) expect(memoryGate(true, false, name)?.block).toBe(true);
  for (const name of ["bootstrap", "ask_user_question", "ask_user", "AskUserQuestion", "TaskManage", "memory_history", "exit_plan_mode"]) expect(memoryGate(true, false, name)).toBeUndefined();
  expect(memoryGate(true, true, "Bash")).toBeUndefined();
  expect(memoryGate(false, false, "Bash")).toBeUndefined();
});

it("does not request duplicate task drafting after combined bootstrap", () => {
  expect(MEMORY_CEREMONY).not.toContain("In combined mode, draft initial tasks");
  expect(MEMORY_CEREMONY).toContain("Inspect taskPlan in either mode");
});
