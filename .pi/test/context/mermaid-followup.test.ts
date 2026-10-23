import { describe, expect, it } from "vitest";
import register from "../../../extensions/mermaid-response/extension.ts";
import { hasMermaidDiagram, wantsMermaidExplanation } from "../../lib/context/mermaid-followup.ts";

const explanation = "The tool first checks the focused task and then checks the skill budget. If the budget is exhausted, the call is blocked before execution; invoking Skill is how work resumes.";
const final = (text: string, stopReason = "stop") => ({ role: "assistant", stopReason, content: [{ type: "text", text }] });

function harness() {
  const handlers = new Map<string, Array<(e: any, ctx: any) => unknown>>();
  const sent: any[] = [];
  register({ on(event: string, fn: (e: any, ctx: any) => unknown) { handlers.set(event, [...(handlers.get(event) ?? []), fn]); }, sendMessage: (...args: any[]) => sent.push(args) });
  const emit = async (type: string, event: any, ctx: any = {}) => { for (const fn of handlers.get(type) ?? []) await fn(event, ctx); };
  return { emit, sent };
}

describe("missing-Mermaid follow-up", () => {
  it("recognizes explicit diagram and conceptual harness intent, not routine updates", () => {
    expect(wantsMermaidExplanation("Explain how the skill budget hook works")).toBe(true);
    expect(wantsMermaidExplanation("Help me improve the footer in this Pi terminal. Explain how the footer works and what each visible part means.")).toBe(true);
    expect(wantsMermaidExplanation("show me a Mermaid diagram")).toBe(true);
    expect(wantsMermaidExplanation("I reloaded you try to ignorre it and see if it catches you")).toBe(true);
    expect(wantsMermaidExplanation("Ignore this test output and continue")).toBe(false);
    expect(wantsMermaidExplanation("Fix the test and report results")).toBe(false);
    expect(hasMermaidDiagram("```mermaid\nflowchart TD\nA-->B\n```" )).toBe(true);
    expect(hasMermaidDiagram("Here is mermaid in prose")).toBe(false);
  });
  it("requests one agent-generated final explanation while preserving the first message", async () => {
    const h = harness();
    const message = final(explanation);
    await h.emit("input", { source: "interactive", text: "Explain how the skill budget hook works" });
    await h.emit("message_end", { message });
    await h.emit("turn_end", { message });
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0][0]).toMatchObject({ customType: "pi-swarm-mermaid-followup", display: false });
    expect(h.sent[0][0].content).toContain("Do not claim the previous reply was replaced");
    // f35d6a0 (fix(mermaid): keep the follow-up on the original request, #299)
    // names this hook's own source files only when the question is about the
    // hook; otherwise the model walks the Mermaid hook instead of answering.
    expect(h.sent[0][0].content).not.toContain("use available read tools to inspect");
    expect(h.sent[0][0].content).toContain("Do not draw a speculative diagram of unknown implementation");
    expect(h.sent[0][1]).toEqual({ deliverAs: "followUp", triggerTurn: true });
    expect(message.content[0].text).toBe(explanation);
    await h.emit("turn_end", { message: final(explanation + " Still no diagram here.") });
    expect(h.sent).toHaveLength(1);
    await h.emit("input", { source: "interactive", text: "continue" });
    await h.emit("turn_end", { message: final(explanation + " Still no diagram here.") });
    expect(h.sent).toHaveLength(1);
    await h.emit("input", { source: "interactive", text: "Fix the test" });
    await h.emit("turn_end", { message });
    expect(h.sent).toHaveLength(1);
  });
  it("names its own source files only when the question is about this hook", async () => {
    const h = harness();
    await h.emit("input", { source: "interactive", text: "Explain how the Mermaid response hook works" });
    await h.emit("turn_end", { message: final(explanation) });
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0][0].content).toContain("use available read tools to inspect extensions/mermaid-response/extension.ts");
  });
  it("does not request on diagrams, short answers, tool calls, pending work, errors or aborts", async () => {
    const h = harness();
    await h.emit("input", { source: "rpc", text: "Explain how tool hooks work" });
    for (const m of [final(explanation + "\n```mermaid\nflowchart TD\nA-->B\n```"), final("Short."), final(explanation, "aborted"), final(explanation, "error"), { ...final(explanation), content: [{ type: "text", text: explanation }, { type: "toolCall", name: "Read" }] }]) await h.emit("turn_end", { message: m });
    await h.emit("turn_end", { message: final(explanation) }, { signal: { aborted: true } });
    await h.emit("turn_end", { message: final(explanation) }, { hasPendingMessages: () => true });
    expect(h.sent).toEqual([]);
    await h.emit("turn_end", { message: final(explanation) });
    expect(h.sent).toHaveLength(1);
    await h.emit("session_start", {});
    await h.emit("turn_end", { message: final(explanation) });
    expect(h.sent).toHaveLength(1);
    await h.emit("input", { source: "interactive", text: "Explain skill hook flow" });
    await h.emit("session_switch", {});
    await h.emit("turn_end", { message: final(explanation) });
    expect(h.sent).toHaveLength(1);
  });
});
