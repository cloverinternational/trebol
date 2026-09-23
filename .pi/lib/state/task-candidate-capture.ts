import { createHash } from "node:crypto";
import { openKnowledgeStore, redactKnowledge, type EvidenceRef, type KnowledgeRecord } from "./knowledge-store.ts";

export interface TaskCandidateInput {
  id: string; subject: string; description?: string; status: string;
  questions?: { id: string; text: string }[];
  answers?: { question: string; answer: string; evidence: string }[];
  parentTaskId?: string; dependsOn?: string[]; notes?: string[];
  category?: string; priority?: string;
}

const safe = (value: string) => redactKnowledge(value).trim();
const taskKey = (session: string, id: string) => createHash("sha256").update(`taskmanage:v1\n${session}\n${id}`).digest("hex").slice(0, 32);
const stable = (value: unknown) => JSON.stringify(value);

/** Project task state is a lead, not verified knowledge. Preserve one revisioned
 * candidate per task, including all unanswered questions and cited answers.
 * Each task is committed independently so a failed write can be retried safely.
 */
export function captureTaskCandidates(input: {
  cwd: string; session: string; tasks: readonly TaskCandidateInput[]; root?: string;
}): { saved: KnowledgeRecord[]; unchanged: string[]; failed: string[] } {
  const saved: KnowledgeRecord[] = [], unchanged: string[] = [], failed: string[] = [];
  if (!input.cwd || !input.session || !Array.isArray(input.tasks)) throw new Error("Task candidate capture requires a complete task snapshot and session identity");
  if (input.tasks.length > 10_000) throw new Error("Task candidate snapshot exceeds bound");
  const store = openKnowledgeStore({ cwd: input.cwd, scope: "worktree", root: input.root });
  const current = new Map(store.snapshot().map(record => [record.id, record]));
  for (const task of input.tasks) {
    const id = typeof task?.id === "string" && task.id.trim() ? taskKey(input.session, task.id) : "invalid";
    try {
      if (!task || typeof task.id !== "string" || !task.id.trim() || typeof task.subject !== "string" || !task.subject.trim() || !["pending", "in_progress", "completed", "deleted"].includes(task.status) ||
        (task.questions !== undefined && !Array.isArray(task.questions)) || (task.questions ?? []).some(q => !q || typeof q.id !== "string" || !q.id.trim() || typeof q.text !== "string" || !q.text.trim()) ||
        (task.questions ?? []).length > 12 || (task.answers ?? []).length > 12 ||
        new Set((task.questions ?? []).map(q => q.id)).size !== (task.questions ?? []).length || (task.answers !== undefined && !Array.isArray(task.answers))) throw new Error("Incomplete task candidate");
      const answers = task.answers ?? [];
      if (answers.some(a => !a || typeof a.question !== "string" || typeof a.answer !== "string" || !a.answer.trim() || typeof a.evidence !== "string" || !a.evidence.trim() || !(task.questions ?? []).some(q => q.id === a.question)) ||
        new Set(answers.map(a => a.question)).size !== answers.length) throw new Error("Malformed task answers");
      const byQuestion = new Map(answers.map(a => [a.question, a]));
      const questions = (task.questions ?? []).map(q => ({ id: safe(q.id), question: safe(q.text),
        answer: byQuestion.has(q.id) ? safe(byQuestion.get(q.id)!.answer) : null,
        evidence: byQuestion.has(q.id) ? byQuestion.get(q.id)!.evidence.trim() : null }));
      if (questions.some(q => !q.id || !q.question || (q.answer !== null && (!q.answer || !q.evidence)))) throw new Error("Redacted task content is incomplete");
      const content = {
        source: "TaskManage", taskId: safe(task.id), subject: safe(task.subject),
        description: safe(task.description ?? ""), status: safe(task.status),
        parentTaskId: safe(task.parentTaskId ?? ""), dependsOn: (task.dependsOn ?? []).map(safe),
        category: safe(task.category ?? ""), priority: safe(task.priority ?? ""),
        notes: (task.notes ?? []).map(safe),
        questions,
      };
      const text = stable(content);
      // TaskManage has already checked that each evidence reference resolves.
      // Generic credential redaction misidentifies filename segments like
      // task-candidate-capture.ts as a token; keep those references intact.
      const evidence: EvidenceRef[] = answers.slice(0, 32).map(a => ({ ref: a.evidence.trim().slice(0, 2000) }));
      const previous = current.get(id);
      if (previous?.status === "verified") { unchanged.push(id); continue; }
      if (previous && previous.text === text && stable(previous.evidence) === stable(evidence)) { unchanged.push(id); continue; }
      const record = store.put({ id, ...(previous ? { expectedRevision: previous.revision } : {}),
        text, evidence, status: "candidate", kind: "context", source: `taskmanage:${input.session}:${task.id}`,
        tags: ["taskmanage", safe(task.subject).slice(0, 200)] });
      current.set(id, record); saved.push(record);
    } catch { failed.push(id); }
  }
  return { saved, unchanged, failed };
}
