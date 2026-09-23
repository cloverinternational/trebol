import { describe, expect, it } from "vitest";
import { formatBootstrapTool } from "../.pi/lib/ui/bootstrap-tool-renderer.ts";

const details = {
  stage: "complete" as const, status: "complete" as const, mode: "parallel" as const,
  model: "provider/model", scope: "/workspace/project", memory: { done: 3 }, selectors: { done: 2, total: 2 },
  skillsSelected: 1, skillsLoaded: 1, tasksDrafted: 2, tasksCommitted: 2, elapsedMs: 1234,
  brief: "A detailed handoff with task evidence and implementation guidance.\n\n" + "x".repeat(600),
  citations: [{ label: "renderer contract", source: "docs/design.md" }],
};

describe("bootstrap TUI renderer", () => {
  it("keeps collapsed output scannable and bounded", () => {
    const output = formatBootstrapTool(details);
    expect(output).toContain("✓ bootstrap [████████] complete");
    expect(output).toContain("▸ memory 3/?   selectors 2/2   skills 1/1   tasks 2/2");
    expect(output).toContain("handoff ready (ctrl+o to expand)");
    expect(output).not.toContain("renderer contract");
    expect(output.length).toBeLessThan(1200);
  });
  it("reveals handoff and evidence in full mode", () => {
    const output = formatBootstrapTool(details, { expanded: true });
    expect(output).toContain("── evidence ──");
    expect(output).toContain("renderer contract: docs/design.md");
    expect(output).toContain("── handoff ──");
    expect(output).toContain("x".repeat(500));
  });
  it("renders failure details without throwing on partial metadata", () => {
    const output = formatBootstrapTool({ stage: "selectors", status: "failed", failures: [{ summary: "selector failed" }] });
    expect(output).toContain("✗ bootstrap");
    expect(output).toContain("✗ selector failed");
  });
});
