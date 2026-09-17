import { describe, expect, it, vi } from "vitest";
import { boundSkillDelivery, MAX_BOOTSTRAP_SKILL_DELIVERY_CHARS, runBootstrap, readBootstrapSettings, settingsPath, writeBootstrapSettings } from "../../../packages/runtime/bootstrap/src/index.ts";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("bootstrap runtime", () => {
  it.each([11999, 12000, 12001])("preserves boundary payload of %i code units", size => {
    const text = "x".repeat(size - 2) + "\n\n";
    const result = boundSkillDelivery("boundary", { content: [{ type: "text", text }] });
    expect(result.content[0].text.length).toBeLessThanOrEqual(12000);
    expect(result.truncated).toBe(size > 12000);
    expect(result.spillPath ? readFileSync(result.spillPath, "utf8") : result.content[0].text).toBe(text);
  });
  it("preserves unicode spills with distinct paths and intact preview code points", () => {
    const text = "🌍".repeat(10000) + "  \n";
    const load = () => boundSkillDelivery("unicode", { content: [{ type: "text", text }] });
    const a = load(), b = load();
    expect(a.spillPath).not.toBe(b.spillPath);
    expect(readFileSync(a.spillPath!)).toEqual(Buffer.from(text));
    expect(a.content[0].text.length).toBeLessThanOrEqual(12000);
    expect(Buffer.from(a.content[0].text).toString()).toBe(a.content[0].text);
  });
  it("bounds large skill content and provides an honest retrieval pointer", () => {
    const result = boundSkillDelivery("large", { content: [{ type: "text", text: "x".repeat(MAX_BOOTSTRAP_SKILL_DELIVERY_CHARS + 1000) }], details: { path: "/skills/large/SKILL.md" } });
    const text = result.content[0].text;
    expect(result.truncated).toBe(true);
    expect(text.length).toBeLessThanOrEqual(MAX_BOOTSTRAP_SKILL_DELIVERY_CHARS);
    expect(text).toContain("Full invoked instructions spilled to");
    expect(readFileSync(result.spillPath!, "utf8")).toBe("x".repeat(MAX_BOOTSTRAP_SKILL_DELIVERY_CHARS + 1000));
    expect(text).not.toContain("entire");
  });
  it.each([
    [{ isError: true, content: [{ type: "text", text: "denied" }] }, "failed to load"],
    [{ content: [] }, "returned no instructions"],
    [{ content: [{ type: "json", value: {} }] }, "returned no instructions"],
  ])("rejects unsuccessful or missing skill results", (result, message) => {
    expect(() => boundSkillDelivery("broken", result)).toThrow(message);
  });
  it("preserves normal skill content and supplies a fallback retrieval mechanism", () => {
    const result = boundSkillDelivery("normal", { content: [{ type: "text", text: "Use the repository contract." }] });
    expect(result.truncated).toBe(false);
    expect(result.content[0].text).toBe("Use the repository contract.");
    expect(result.instructionsPath).toBe('SkillManage(action="view", name="normal", offset=0, limit=12000)');
  });
  it.each(["combined", "parallel"] as const)("caps distinct skills before loading and drafting in %s mode", async mode => {
    const events: string[] = [];
    const picked = { memories: [], evidence: [], skills: ["one", "one", "two", "three"].map(name => ({ name, body: "" })) };
    const selector = async () => picked;
    const result = await runBootstrap(mode, "task", mode === "parallel" ? { memory: selector, skills: selector } : selector,
      async (_task, selection) => {
        events.push("draft");
        expect(selection.skills.map(s => s.name)).toEqual(["one", "two"]);
        expect(selection.skills.every(s => s.body === "loaded instructions")).toBe(true);
        return [];
      }, undefined, "session", async selection => {
        events.push("load");
        expect(selection.skills).toHaveLength(2);
        for (const skill of selection.skills) skill.body = "loaded instructions";
      });
    expect(result.status).toBe("ready");
    expect(events).toEqual(["load", "draft"]);
    expect(result.selection?.skills).toHaveLength(2);
  });
  it("does not draft when skill loading fails", async () => {
    const draft = vi.fn();
    const result = await runBootstrap("combined", "task", async () => ({ memories: [], skills: [{ name: "one", body: "" }], evidence: [] }), draft, undefined, "session", async () => { throw new Error("Skill blocked"); });
    expect(result.status).toBe("degraded");
    expect(draft).not.toHaveBeenCalled();
  });
  const selection = async (kind: string) => ({ memories: kind === "memory" ? [{ text: "remembered" }] : [], skills: kind === "skills" ? [{ name: "loop", body: "instructions" }] : [], evidence: [kind] });
  it("runs parallel selectors concurrently and drafts once", async () => {
    const draft = vi.fn(async (_task, picked) => [{ id: "T1", subject: "task", description: picked.evidence.join(","), dependsOn: [] }]);
    const result = await runBootstrap("parallel", "build", { memory: () => selection("memory"), skills: () => selection("skills") }, draft);
    expect(result.status).toBe("ready"); expect(result.selection?.memories).toHaveLength(1); expect(result.selection?.skills).toHaveLength(1); expect(result.tasks).toHaveLength(1); expect(draft).toHaveBeenCalledTimes(1);
  });
  it("handles cancellation and selector failure without pretending ready", async () => {
    const controller = new AbortController(); controller.abort();
    expect((await runBootstrap("combined", "x", selection, undefined, controller.signal)).status).toBe("cancelled");
    expect((await runBootstrap("combined", "x", async () => { throw new Error("no recall"); }, undefined)).status).toBe("degraded");
  });
  it("persists settings atomically and reloads", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-bootstrap-")); writeBootstrapSettings(cwd, "combined");
    expect(readBootstrapSettings(cwd).mode).toBe("combined"); expect(readFileSync(settingsPath(cwd), "utf8")).toContain('"mode":"combined"');
  });
  it("preserves a model override across mode changes and can restore inheritance", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-bootstrap-model-"));
    expect(readBootstrapSettings(cwd).model).toBeUndefined();
    writeBootstrapSettings(cwd, "parallel", "provider/chosen");
    writeBootstrapSettings(cwd, "combined");
    expect(readBootstrapSettings(cwd).model).toBe("provider/chosen");
    writeBootstrapSettings(cwd, "combined", "");
    expect(readBootstrapSettings(cwd).model).toBeUndefined();
  });
});

it("bootstrap handoff describes completed skill loads rather than requesting duplicate invocation", () => {
  const source = readFileSync(new URL("../../extensions/00-runtime/bootstrap.ts", import.meta.url), "utf8");
  expect(source).not.toContain("Afterwards invoke recommended skills");
  expect(source).not.toContain("invokeSkills:");
  expect(source).toContain("loadedSkillNames: loadedSkills.map(s => s.name)");
  expect(source).toContain("Follow loadedSkills instructions already returned here");
  expect(source).toContain("Verify repository facts before implementing");
});


it("bootstrap carries compact questions through proposal and commit boundaries", () => {
  const source = readFileSync(new URL("../../extensions/00-runtime/bootstrap.ts", import.meta.url), "utf8");
  expect(source).toContain("questions: candidate.questions");
  expect(source).toContain("{ questions: item.questions }");
  expect(source).toContain("Invalid task questions");
  expect(source).toContain("same TaskManage completion call");
});
