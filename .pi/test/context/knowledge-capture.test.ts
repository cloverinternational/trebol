import { expect, it } from "vitest";
import { captureEvidence, knowledgeCapturePrompt, parseKnowledgeCandidates } from "../../lib/context/knowledge-capture.ts";

it("captures visible evidence without reasoning, runtime reminders or recursive memory output", () => {
  const entries = [
    { id: "1", message: { role: "assistant", content: [{ type: "thinking", thinking: "private" }, { type: "text", text: "All done" }] } },
    { id: "2", message: { role: "user", content: "<system-reminder>save things</system-reminder>" } },
    { id: "3", message: { role: "toolResult", toolName: "memory_history", content: "saved" } },
    { id: "4", message: { role: "user", content: "Project uses SQLite. api_key=secret-value" } },
  ];
  const captured = captureEvidence(entries);
  expect(captured.evidence).toHaveLength(1);
  expect(captured.evidence[0].text).toContain("api_key=[REDACTED]");
  expect(captured.cursor).toBe("4");
  expect(captureEvidence(entries, "4").evidence).toEqual([]);
  expect(captureEvidence(entries, "missing").status).toBe("cursor-missing");
});

it("preserves errors and truncation, without skipping an entry that exceeds the batch budget", () => {
  expect(() => captureEvidence([], undefined, 0)).toThrow(/budget/);
  const entries = ["a", "b"].map(id => ({ id, message: { role: "toolResult", toolName: "Bash", isError: true, content: "x".repeat(7000) } }));
  const captured = captureEvidence(entries, undefined, 6500);
  expect(captured.cursor).toBe("a");
  expect(captured.evidence[0]).toMatchObject({ truncated: true, failed: true });
  expect(captureEvidence(entries, captured.cursor).evidence[0].id).toBe("b");
});

it("rejects invented citations and global promotion and never trusts a model's verified label", () => {
  const evidence = [{ id: "a", role: "user" as const, text: "Uses SQLite", truncated: false }];
  const candidate = { title: "Storage", text: "Uses SQLite", evidenceIds: ["a"], scope: "repository", status: "verified" };
  expect(parseKnowledgeCandidates(JSON.stringify({ candidates: [candidate, candidate] }), evidence)).toMatchObject([{ status: "candidate" }]);
  expect(() => parseKnowledgeCandidates(JSON.stringify({ candidates: [{ ...candidate, scope: "global" }] }), evidence)).toThrow();
  expect(() => parseKnowledgeCandidates(JSON.stringify({ candidates: [{ ...candidate, evidenceIds: ["invented"] }] }), evidence)).toThrow();
  expect(knowledgeCapturePrompt(evidence)).toContain("do not infer personal traits");
});
