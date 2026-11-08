import { describe, expect, it, vi } from "vitest";
import { filterWork, workCounts, workInspectorNodes } from "../../lib/tern/work-inspector.ts";
import { PiTernBridge, TranscriptProjector } from "../../lib/tern/bridge.ts";
import { parseTspMessages } from "../../lib/tern/tsp.ts";

const steps = [
  { id: "t-a", role: "tool", name: "Bash", args: { command: "npm test --token=SECRET", description: "Verify parser" }, status: "ok" as const, output: "passed" },
  { id: "t-b", role: "tool", name: "Read", args: { path: "src/example.ts" }, status: "running" as const },
  { id: "t-c", role: "tool", name: "Bash", status: "error" as const, timedOut: true, output: "timeout" },
  { id: "t-d", role: "tool", name: "Bash", status: "error" as const, cancelled: true },
];
const start = (p: TranscriptProjector, id: string) => p.apply({ type: "tool_execution_start", toolCallId: id, toolName: "Bash", args: { description: `Check ${id}`, command: "echo example" } });
const end = (p: TranscriptProjector, id: string, error = false) => p.apply({ type: "tool_execution_end", toolCallId: id, toolName: "Bash", isError: error, result: { content: [{ type: "text", text: error ? "failed" : "ok" }] } });
describe("progressive work", () => {
  it("distinguishes active, failed, timed out, cancelled and completed counts", () => {
    expect(workCounts(steps)).toEqual({ total: 4, active: 1, failed: 1, done: 1, cancelled: 1 });
    expect(filterWork(steps, "failed").map((s) => s.id)).toEqual(["t-c"]);
    expect(filterWork(steps, "active").map((s) => s.id)).toEqual(["t-b"]);
    expect(filterWork(steps, "all", "parser").map((s) => s.id)).toEqual(["t-a"]);
    expect(filterWork(steps, "all", "SECRET")).toEqual([]);
  });
  it("renders safe targets, explicit truncation and responsive details", () => {
    const fixture = [{ ...steps[0]!, output: "head" + "x".repeat(50000) + "tail" }];
    const rendered = JSON.stringify(workInspectorNodes("g-a", fixture, "t-a", "", 0, "all", 60));
    expect(rendered).toContain('"id":"work-inspector-body","k":"col"');
    expect(rendered).toContain("middle omitted"); expect(rendered).toContain("tail");
    expect(rendered).not.toContain("SECRET"); expect(rendered.length).toBeLessThan(30000);
    expect(JSON.stringify(workInspectorNodes("g", [], undefined, "", 0, "all", 120))).toContain("No matching steps");
  });
  it("keeps the fold and every step through streaming and settlement", () => {
    const p = new TranscriptProjector();
    p.apply({ type: "agent_start" }); start(p, "a"); end(p, "a", true); start(p, "b");
    p.setGroupCollapsed("g-t-a", true);
    const before = p.nodes(false).find((n) => n.id === "g-t-a")!;
    expect(before.p?.collapsed).toBe(true);
    expect(p.groupItems("g-t-a").map((n) => n.id)).toEqual(["t-a", "t-b"]);
    end(p, "b"); p.apply({ type: "agent_end", messages: [] });
    const after = p.nodes(false).find((n) => n.id === "g-t-a")!;
    expect(after.p?.collapsed).toBe(true);
    expect(p.groupItems("g-t-a").length).toBe(2);
  });
  it("owns keyboard/native paste without changing the draft and closes on session replacement", async () => {
    let listener: any;
    let id = "one";
    const prompt = vi.fn(async () => {});
    const session: any = { sessionManager: { getSessionId: () => id, getCwd: () => process.cwd(), getEntries: () => [], getBranch: () => [] }, subscribe: (fn: any) => { listener = fn; return () => {}; }, prompt, abort: async () => {}, dispose() {} };
    const writes: string[] = [];
    const bridge = new PiTernBridge(session, { write: (s) => writes.push(s), credits: 10000 });
    try {
      bridge.start(); bridge.setDraft("keep my draft");
      listener({ type: "agent_start" });
      listener({ type: "tool_execution_start", toolCallId: "a", toolName: "Read", args: { path: "file.ts" } });
      await bridge.handle({ verb: "e", body: { ev: "action", act: "work.inspect", value: "g-t-a" } });
      expect(writes.join("")).toContain("work-inspector");
      bridge.applyWorkKey({ kind: "text", text: "Read" }); bridge.pasteText("file");
      await bridge.submitDraft();
      await bridge.handle({ verb: "e", body: { ev: "edit", id: "composer", from: 0, to: 13, len: 13, cursor: 0, text: "" } });
      expect(bridge.draft).toBe("keep my draft"); expect(prompt).not.toHaveBeenCalled();
      bridge.escape(); expect(bridge.applyWorkKey({ kind: "text", text: "x" })).toBe(false);
      await bridge.handle({ verb: "e", body: { ev: "action", act: "work.inspect", value: "g-t-a" } });
      id = "two"; bridge.rebind(session);
      expect(bridge.applyWorkKey({ kind: "text", text: "x" })).toBe(false);
      expect(writes.flatMap(parseTspMessages).some((m) => JSON.stringify(m.body).includes('"del","work-inspector"'))).toBe(true);
    } finally { bridge.close(); }
  });
});
