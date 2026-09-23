import { afterEach, expect, it } from "vitest";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureTaskCandidates, type TaskCandidateInput } from "../../lib/state/task-candidate-capture.ts";
import { openKnowledgeStore } from "../../lib/state/knowledge-store.ts";
import { recallKnowledge } from "../../lib/context/knowledge-recall.ts";
import extension from "../../extensions/40-state/task-candidate-capture.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function setup() {
  const cwd = mkdtempSync(join(tmpdir(), "task-memory-capture-")); roots.push(cwd);
  const root = join(cwd, "memory"), session = join(cwd, "session.jsonl");
  const store = openKnowledgeStore({ cwd, root, scope: "worktree" });
  const task: TaskCandidateInput = { id: "7", subject: "Choose database", status: "in_progress", questions: [
    { id: "storage", text: "What database is selected?" }, { id: "reason", text: "Why was it selected?" },
  ], answers: [{ question: "storage", answer: "PostgreSQL", evidence: "docs/architecture.md#Storage" }] };
  return { cwd, root, session, store, task };
}
it("captures all tasks, questions, unanswered items, and answer evidence as candidates", () => {
  const h = setup(); const second: TaskCandidateInput = { id: "8", subject: "Ship API", status: "pending", questions: [{ id: "test", text: "What test proves it works?" }] };
  const result = captureTaskCandidates({ cwd: h.cwd, root: h.root, session: h.session, tasks: [h.task, second] });
  expect(result.failed).toEqual([]); expect(result.saved).toHaveLength(2);
  const record = h.store.read(result.saved[0].id)!; const data = JSON.parse(record.text);
  expect(record).toMatchObject({ status: "candidate", scope: "worktree", kind: "context", evidence: [{ ref: "docs/architecture.md#Storage" }] });
  expect(data.questions).toEqual([
    { id: "storage", question: "What database is selected?", answer: "PostgreSQL", evidence: "docs/architecture.md#Storage" },
    { id: "reason", question: "Why was it selected?", answer: null, evidence: null },
  ]);
  expect(JSON.parse(result.saved[1].text).questions[0].answer).toBeNull();
  expect(recallKnowledge(h.cwd, "PostgreSQL", { root: h.root }).memories.some(m => m.id.includes(record.id))).toBe(false);
});
it("replay is idempotent and answer revisions remain in the event log", () => {
  const h = setup(); const first = captureTaskCandidates({ cwd: h.cwd, root: h.root, session: h.session, tasks: [h.task] }).saved[0];
  const repeated = captureTaskCandidates({ cwd: h.cwd, root: h.root, session: h.session, tasks: [h.task] });
  expect(repeated.saved).toEqual([]); expect(repeated.unchanged).toEqual([first.id]);
  h.task.answers!.push({ question: "reason", answer: "Transactional integrity", evidence: "docs/architecture.md#Transactions" });
  const revised = captureTaskCandidates({ cwd: h.cwd, root: h.root, session: h.session, tasks: [h.task] }).saved[0];
  expect(revised.id).toBe(first.id); expect(revised.revision).not.toBe(first.revision);
  expect(JSON.parse(revised.text).questions[1].answer).toBe("Transactional integrity");
  expect(readdirSync(h.store.directory).filter(name => name.endsWith(`-${first.id}.json`))).toHaveLength(2);
  expect(h.store.snapshot()).toHaveLength(1); expect(revised.status).toBe("candidate");
  expect(captureTaskCandidates({ cwd: h.cwd, root: h.root, session: h.session, tasks: [h.task] }).saved).toEqual([]);
});
it("isolates malformed tasks and retries them without dropping good task writes", () => {
  const h = setup(); const broken = { id: "bad", subject: "Broken", status: "pending", questions: [{ id: "", text: "?" }] };
  const result = captureTaskCandidates({ cwd: h.cwd, root: h.root, session: h.session, tasks: [broken, h.task] });
  expect(result.failed).toHaveLength(1); expect(result.saved).toHaveLength(1);
  broken.questions[0].id = "fixed";
  const retry = captureTaskCandidates({ cwd: h.cwd, root: h.root, session: h.session, tasks: [broken, h.task] });
  expect(retry.failed).toEqual([]); expect(retry.saved).toHaveLength(1); expect(retry.unchanged).toEqual([result.saved[0].id]);
});
it("reconciles the authoritative TaskManage snapshot on partial-error tool results", () => {
  const h = setup(); const hooks = new Map<string, any>();
  const pi = { on: (name: string, handler: any) => hooks.set(name, handler) };
  extension(pi); extension(pi);
  const symbol = Symbol.for("pi-swarm-task-manager"); const previous = (globalThis as any)[symbol];
  const previousDir = process.env.PI_SWARM_MEMORY_DIR;
  process.env.PI_SWARM_MEMORY_DIR = h.root;
  (globalThis as any)[symbol] = { snapshot: () => ({ tasks: [h.task] }) };
  try {
    const ctx = { cwd: h.cwd, sessionManager: { getSessionFile: () => h.session } };
    hooks.get("tool_result")({ toolName: "TaskManage", isError: true }, ctx);
    expect(h.store.snapshot()).toHaveLength(1);
    hooks.get("tool_result")({ toolName: "TaskManage", isError: true }, ctx);
    expect(h.store.snapshot()).toHaveLength(1);
  } finally {
    (globalThis as any)[symbol] = previous;
    if (previousDir === undefined) delete process.env.PI_SWARM_MEMORY_DIR; else process.env.PI_SWARM_MEMORY_DIR = previousDir;
  }
});
it("retains legacy questionless tasks as candidates rather than dropping them", () => {
  const h = setup(); const result = captureTaskCandidates({ cwd: h.cwd, root: h.root, session: h.session,
    tasks: [{ id: "legacy", subject: "Old task", status: "pending" }] });
  expect(result.failed).toEqual([]);
  expect(JSON.parse(result.saved[0].text).questions).toEqual([]);
  expect(result.saved[0].status).toBe("candidate");
});
