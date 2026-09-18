import { describe, expect, it } from "vitest";
import { createBootstrapToolRenderer, formatBootstrapTool, type BootstrapToolDetails } from "../../lib/ui/bootstrap-tool-renderer.ts";

const running: BootstrapToolDetails = { stage: "skills", status: "running", elapsedMs: 42, skillsSelected: 3, skillsLoaded: 1 };

describe("bootstrap tool renderer", () => {
  it("does not leak state between executions or hide terminal errors", () => {
    const renderer = createBootstrapToolRenderer();
    renderer.renderResult({ details: { stage: "complete", status: "complete", scope: "private-repo" } });
    expect(renderer.renderResult({}).render(200).join("\n")).not.toContain("private-repo");
    expect(renderer.renderResult({ isError: true }).render(200)[0]).toContain("Completion is unknown");
    expect(formatBootstrapTool({ stage: "skills", status: "failed" }, { isPartial: true })).toContain("✗");
  });
  it("formats stages and distinguishes selected from loaded skills and committed tasks", () => {
    const text = formatBootstrapTool({ stage: "tasks", status: "running", skillsSelected: 4, skillsLoaded: 2, tasksDrafted: 3, tasksCommitted: 1, memory: { done: 2 }, selectors: { done: 1, total: 2 } });
    expect(text).toContain("authoritative task commit");
    expect(text).toContain("skills selected 4, loaded 2");
    expect(text).toContain("tasks drafted 3, committed 1");
    expect(text).toContain("memory 2/?");
  });

  it("does not claim completion from an incomplete or unknown-total update", () => {
    const text = formatBootstrapTool({ ...running, selectors: { done: 1 } });
    expect(text.startsWith("⠋")).toBe(true);
    expect(text).not.toContain("✓");
    expect(text).toContain("1/?");
  });

  it("renders failures, cancellation, degradation, and optional citations", () => {
    expect(formatBootstrapTool({ stage: "skills", status: "degraded", failures: [{ summary: "registry unavailable" }], citations: [{ label: "skill.md", source: "local" }] })).toContain("registry unavailable");
    expect(formatBootstrapTool({ stage: "tasks", status: "cancelled" })).toContain("−");
    expect(formatBootstrapTool({ stage: "complete", status: "complete", citations: [{ label: "memory-1" }] }, { expanded: true })).toContain("↳ memory-1");
  });

  it("keeps partial and final output distinct and clips narrow output", () => {
    const renderer = createBootstrapToolRenderer();
    expect(renderer.renderResult({ details: running }, { isPartial: true }).render(200)[0]).toContain("⠋");
    const final = renderer.renderResult({ details: { stage: "complete", status: "complete" } }, { isPartial: false });
    expect(final.render(200)[0]).toContain("✓");
    expect(final.render(12)[0].length).toBe(12);
  });
});

it("never renders undefined for empty partial or final details",()=>{
 expect(formatBootstrapTool({} as any,{isPartial:true})).not.toContain("undefined");
 expect(formatBootstrapTool({} as any,{})).toContain("result unavailable");
});

it("shows the verbose brief without expansion and wraps without losing text",()=>{
 const brief="GOAL\nabcdefghijklmnopqrstuvwxyz\nTASKS & INSTRUCTIONS\nVerify the result.";
 const renderer=createBootstrapToolRenderer();
 const result={details:{stage:"complete",status:"complete",brief} as BootstrapToolDetails};
 expect(renderer.renderResult(result,{expanded:false}).render(200).join("\n")).toContain(brief);
 expect(renderer.renderResult(result).render(10).join("")).toContain("abcdefghijklmnopqrstuvwxyz");
});

it("surfaces actual error content when middleware drops details",()=>{
 const r=createBootstrapToolRenderer().renderResult({details:{} as any,isError:true,content:[{type:"text",text:"Selector failed: api_key=secret-value"}]}).render(200).join("\n");
 expect(r).toContain("Selector failed");expect(r).not.toContain("secret-value");expect(r).not.toContain("result unavailable");
});
