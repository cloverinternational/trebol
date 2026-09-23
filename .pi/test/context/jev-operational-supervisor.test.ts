import {describe,it,test,expect} from "vitest";
import { collectSupervisorState, createSupervisorQuestions, hashTaskSnapshot, parseReviewResult, parseSupervisorFinding, validateTaskProposal, vaultCredentialMetadata } from "../../lib/context/jev-operational-supervisor";

describe("operational supervisor", () => {
  test("sanitizes and bounds state", () => { const s = collectSupervisorState("x\0".repeat(2000), Array(101).fill({ id: "a", title: "t" }), { secret: "no" }, { waiting: true }); expect(s.goal).not.toContain("\0"); expect(s.tasks).toHaveLength(100); });
  test("parses exact distributions", () => { const probabilities = Object.fromEntries(["progressing", "missing_tasks", "stale_ledger", "blocked", "drift", "unclear"].map((x, i) => [x, i === 0 ? 1 : 0])); const reviewProbabilities = Object.fromEntries(["none", "task_review", "skill_review", "memory_review", "mixed"].map((x, i) => [x, i === 0 ? 1 : 0])); expect(parseSupervisorFinding({ workState: "progressing", reviewNeed: "none", probabilities, reviewProbabilities })).toBeTruthy(); });
  test("requires questions for creates and permits explicit legacy repair", () => {
    const question = [{ id: "verify", text: "Was the result verified?" }];
    expect(validateTaskProposal([], [], [{ op: "create", task: { id: "new", title: "Work", status: "pending" } }]).valid).toBe(false);
    const legacy = { id: "legacy", title: "Legacy", status: "pending" };
    const repair = validateTaskProposal([legacy], [legacy], [{ op: "update", targetTaskId: "legacy", snapshotHash: hashTaskSnapshot(legacy), task: { questions: question } }]);
    expect(repair.valid).toBe(true);
  });
  test("rejects stale update and missing review evidence", () => { const t = { id: "a", title: "A", status: "pending" }; expect(validateTaskProposal([t], [t], [{ op: "update", targetTaskId: "a", snapshotHash: "bad", task: { title: "B" } }]).valid).toBe(false); expect(parseReviewResult({ verdict: "confirm", evidenceIds: [] }, ["e1"])).toBeUndefined(); });
  test("limits vault metadata and exposes question contract", () => { expect(vaultCredentialMetadata({ id: "x", purpose: "p", scope: "s", secret: "x" })).toEqual({ id: "x", purpose: "p", scope: "s" }); expect(createSupervisorQuestions().call).toBe("jev"); expect(hashTaskSnapshot({ id: "a" })).toBeTruthy(); });
});
