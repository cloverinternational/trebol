import { describe, expect, it } from "vitest";
import { formatBackgroundOutput, parseAgentTimeline, safeWorkText } from "../../lib/tern/background-format.ts";
import { BackgroundPanel } from "../../lib/tern/background-panel.ts";
import type { RunningWorkItem } from "../../lib/ui/running-work-store.ts";

describe("background output presentation", () => {
  it("preserves safe SGR, strips terminal commands and normalizes progress overwrites", () => {
    const result = formatBackgroundOutput('\x1b]52;c;hidden\x07\x1b[31mERROR: broken\x1b[0m\n10%\r90%');
    expect(result.kind).toBe("ansi"); expect(result.text).toContain("\x1b[31m");
    expect(result.text).not.toContain("hidden"); expect(result.text).not.toContain("10%");
    expect(result.text).toContain("90%"); expect(result.diagnostics[0]?.tone).toBe("error");
    expect(safeWorkText("x\x1b[31")).toBe("x");
  });
  it("formats complete JSON, redacts quoted credentials and preserves malformed text", () => {
    const good = formatBackgroundOutput('{"status":"ok","password":"a long secret value"}');
    expect(good.kind).toBe("json"); expect(good.text).toContain("[redacted]"); expect(good.text).not.toContain("long secret");
    const partial = formatBackgroundOutput('{"status":');
    expect(partial.kind).toBe("plain"); expect(partial.note).toContain("Not a complete");
    expect(formatBackgroundOutput("x".repeat(100000)).note).toContain("Earlier output omitted");
  });
  it("projects markdown and tool-call-only messages without hidden reasoning or runtime scaffolding", () => {
    const line = (id: string, role: string, content: unknown) => JSON.stringify({ id, type: "message", message: { role, content } });
    const steps = parseAgentTimeline([
      line("a", "assistant", [{ type: "thinking", thinking: "PRIVATE" }, { type: "text", text: "## Findings\n- useful" }]),
      line("b", "assistant", [{ type: "toolCall", name: "Read", arguments: { secret: "PRIVATE" } }]),
      line("c", "user", [{ type: "text", text: "<system-reminder>hidden" }]),
      '{"type":"message',
    ]);
    expect(steps.map((s) => s.id)).toEqual(["a", "b"]);
    expect(steps[0]?.text).toContain("## Findings"); expect(steps[1]?.text).toBe("Called Read");
    expect(JSON.stringify(steps)).not.toContain("PRIVATE");
  });
});

describe("unified background manager", () => {
  it("freezes viewing without changing execution, resumes and keeps explicit removed state", () => {
    const panel = new BackgroundPanel(); let output = "first";
    const item: RunningWorkItem = { id: "job", kind: "bash", label: "Build", detail: "npm test", status: "running", startedAt: Date.now(), readOutput: () => output };
    panel.select(item.id);
    expect(JSON.stringify(panel.nodes([item], 120))).toContain("first");
    panel.event({ ev: "action", act: "bg.follow" }); output = "second";
    expect(JSON.stringify(panel.nodes([item], 120))).not.toContain("second");
    expect(item.status).toBe("running");
    panel.event({ ev: "action", act: "bg.follow" });
    expect(JSON.stringify(panel.nodes([item], 120))).toContain("second");
    expect(JSON.stringify(panel.nodes([], 60))).toContain("no longer tracked");
  });
  it("filters/searches jobs and does not infer status from output", () => {
    const panel = new BackgroundPanel();
    const item: RunningWorkItem = { id: "a", kind: "subagent", label: "Review", detail: "Review tests", status: "queued", startedAt: Date.now(), output: "SUCCESS done" };
    panel.event({ ev: "select", id: "bg-filter", item: "bash" }); expect(panel.rows([item])).toEqual([]);
    panel.event({ ev: "select", id: "bg-filter", item: "subagent" });
    panel.key({ kind: "text", text: "Review" }, [item]); expect(panel.rows([item])).toHaveLength(1);
    expect(JSON.stringify(panel.nodes([item], 60))).toContain("queued"); expect(item.status).toBe("queued");
  });
});
