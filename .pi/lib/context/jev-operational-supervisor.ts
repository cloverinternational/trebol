import { createHash } from "node:crypto";
import { redactContext } from "./page-index-memory.ts";
/** Pure, side-effect-free contract for the first operational supervisor slice. */

export const WORK_STATES = ["progressing", "missing_tasks", "stale_ledger", "blocked", "drift", "unclear"] as const;
export const REVIEW_NEEDS = ["none", "task_review", "skill_review", "memory_review", "mixed"] as const;
export type WorkState = typeof WORK_STATES[number];
export type ReviewNeed = typeof REVIEW_NEEDS[number];

export interface SupervisorQuestion { id: string; text: string }
export interface SupervisorTask { id: string; title?: string; status?: string; owner?: string; dependsOn?: string[]; questions?: SupervisorQuestion[]; [key: string]: unknown }
export interface SupervisorState {
  goal: string;
  tasks: SupervisorTask[];
  budget: unknown;
  waiting: unknown;
}
export interface ProbabilityDistribution<T extends string> { probabilities: Record<T, number>; }
export interface SupervisorFinding extends ProbabilityDistribution<WorkState> {
  workState: WorkState;
  reviewNeed: ReviewNeed;
  reviewProbabilities: Record<ReviewNeed, number>;
  rationale?: string;
}
export interface SupervisorQuestions {
  call: "jev";
  question: string;
  evidenceQuestions: string[];
  workStates: readonly WorkState[];
  reviewNeeds: readonly ReviewNeed[];
}

const MAX_GOAL = 2000, MAX_TASKS = 100, MAX_TEXT = 240;
const MAX_QUESTIONS = 8, MAX_QUESTION_ID = 80, MAX_QUESTION_TEXT = 240;
const own = (v: unknown): Record<string, unknown> => v !== null && typeof v === "object" ? v as Record<string, unknown> : {};
const text = (v: unknown, max = MAX_TEXT) => typeof v === "string" ? redactContext(v).replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max) : "";
function questions(value: unknown): SupervisorQuestion[] | undefined {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_QUESTIONS) return undefined;
  const ids = new Set<string>(), out: SupervisorQuestion[] = [];
  for (const raw of value) { const q = own(raw), id = text(q.id, MAX_QUESTION_ID), body = text(q.text, MAX_QUESTION_TEXT); if (!id || !body || ids.has(id) || Object.keys(q).some(k => k !== "id" && k !== "text")) return undefined; ids.add(id); out.push({ id, text: body }); }
  return out;
}
function hasValidQuestions(value: unknown): boolean { return questions(value) !== undefined; }

/** Produces only bounded, display-safe data; it never reads a vault or credential. */
export function collectSupervisorState(goal: unknown, tasks: unknown, budget: unknown, waiting: unknown): SupervisorState {
  const list = Array.isArray(tasks) ? tasks.slice(0, MAX_TASKS) : [];
  return {
    goal: text(goal, MAX_GOAL),
    tasks: list.map((raw, i) => { const t = own(raw); return {
      id: text(t.id, 120) || `task-${i + 1}`,
      title: text(t.title ?? t.subject), status: text(t.status, 40), owner: text(t.owner ?? t.owner_id, 120),
      dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn.filter(x => typeof x === "string").map(x => text(x, 120)).slice(0, 20) : [],
      ...(t.questions !== undefined ? { questions: questions(t.questions) ?? [] } : {}),
    }; }),
    budget: sanitizeValue(budget), waiting: sanitizeValue(waiting),
  };
}

function sanitizeValue(value: unknown, depth = 0): unknown {
  if (depth > 2) return undefined;
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return text(value);
  if (Array.isArray(value)) return value.slice(0, 20).map(v => sanitizeValue(v, depth + 1));
  if (typeof value === "object") { const out: Record<string, unknown> = {}; for (const [k, v] of Object.entries(value as object).slice(0, 30)) if(!/secret|password|token|authorization|api.?key/i.test(k)) out[text(k, 80)] = sanitizeValue(v, depth + 1); return out; }
  return undefined;
}

/** A single Jev request containing the operational question and evidence prompts. */
export function createSupervisorQuestions(): SupervisorQuestions {
  return { call: "jev", workStates: WORK_STATES, reviewNeeds: REVIEW_NEEDS,
    question: "Classify the work state and review need from the supplied snapshot. Return probabilities, not actions.",
    evidenceQuestions: ["Which task IDs support this classification?", "What concrete snapshot evidence is missing or stale?", "Which review (if any) is needed and why?"] };
}

function distribution<T extends string>(value: unknown, keys: readonly T[]): Record<T, number> | undefined {
  const o = own(value), p = own(o.probabilities), out = {} as Record<T, number>; let sum = 0;
  for (const key of keys) { const n = p[key]; if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > 1) return undefined; out[key] = n; sum += n; }
  return Object.keys(p).length === keys.length && Math.abs(sum - 1) <= .03 ? out : undefined;
}
export function parseSupervisorFinding(value: unknown): SupervisorFinding | undefined {
  const o = own(value), workState = o.workState, reviewNeed = o.reviewNeed;
  if (typeof workState !== "string" || !(WORK_STATES as readonly string[]).includes(workState) || typeof reviewNeed !== "string" || !(REVIEW_NEEDS as readonly string[]).includes(reviewNeed)) return undefined;
  const probabilities = distribution(o, WORK_STATES), reviewProbabilities = distribution({ probabilities: o.reviewProbabilities }, REVIEW_NEEDS);
  if (!probabilities || !reviewProbabilities) return undefined;
  return { workState: workState as WorkState, reviewNeed: reviewNeed as ReviewNeed, probabilities, reviewProbabilities, rationale: text(o.rationale, MAX_TEXT) || undefined };
}

export interface TaskProposal { op: "create" | "update"; task: SupervisorTask; targetTaskId?: string; snapshotHash?: string; note?: string; }
export interface ProposalResult { valid: boolean; errors: string[]; operations: TaskProposal[]; }
export function hashTaskSnapshot(task: SupervisorTask): string {
  const canonical = JSON.stringify({ id: task.id, title: text(task.title), status: text(task.status), owner: text(task.owner), dependsOn: (task.dependsOn ?? []).slice().sort(), questions: questions(task.questions) ?? null });
  return createHash("sha256").update(canonical).digest("hex");
}
export function validateTaskProposal(snapshot: unknown, current: unknown, ops: unknown): ProposalResult {
  const errors: string[] = [], base = Array.isArray(snapshot) ? snapshot : [], now = Array.isArray(current) ? current : [], proposals = Array.isArray(ops) ? ops : [];
  if (!Array.isArray(ops)) errors.push("operations must be array");
  if (proposals.length > 5) errors.push("more than 5 operations");
  const byId = new Map(base.map(x => [text(own(x).id), own(x)])); const nowById = new Map(now.map(x => [text(own(x).id), own(x)]));
  const operations: TaskProposal[] = [];
  for (const raw of proposals) { const p = own(raw), op = p.op, task = own(p.task), id = text(p.targetTaskId || task.id); if (op !== "create" && op !== "update") { errors.push("invalid operation"); continue; }
    if (op === "create") {
      if(Object.keys(task).some(k=>!["id","title","status","dependsOn","questions"].includes(k)) || !["pending","in_progress"].includes(String(task.status??"pending"))) { errors.push("invalid create fields/status"); continue; }
      if (!id || byId.has(id) || nowById.has(id)) errors.push("create target already exists or has no id");
      else if (typeof task.title !== "string" || !task.title.trim()) errors.push("created task needs a title");
      else if (!hasValidQuestions(task.questions)) errors.push("created task requires bounded acceptance questions");
      else if (Array.isArray(task.dependsOn) && task.dependsOn.some(x => !byId.has(x))) errors.push("missing dependency");
      else operations.push({ op, task: task as SupervisorTask });
      continue;
    }
    const old = byId.get(id), live = nowById.get(id); if (!old || !live) { errors.push("unrelated or missing target"); continue; }
    if (p.snapshotHash !== hashTaskSnapshot(old as SupervisorTask) || hashTaskSnapshot(old as SupervisorTask) !== hashTaskSnapshot(live as SupervisorTask)) errors.push("stale task snapshot");
    if (["completed", "deleted"].includes(text(old.status)) || ["completed", "deleted"].includes(text(task.status))) errors.push("completed/deleted task cannot be changed");
    const allowed = new Set(["status", "progress", "note", "questions"]);
    if (Object.keys(task).some(k => !allowed.has(k))) errors.push("updates may only change pending/progress/note");
    if (task.status !== undefined && !["pending", "progress", "progressing", "in_progress"].includes(text(task.status))) errors.push("invalid progress status");
    if (task.progress !== undefined && (typeof task.progress !== "number" || !Number.isFinite(task.progress) || task.progress < 0 || task.progress > 1)) errors.push("invalid progress");
    if (task.note !== undefined && typeof task.note !== "string") errors.push("invalid note");
    if (task.questions !== undefined && !hasValidQuestions(task.questions)) errors.push("invalid acceptance questions");
    if (task.questions !== undefined && hasValidQuestions(live.questions)) errors.push("valid existing questions require explicit preservation, not replacement");
    operations.push({ op, targetTaskId: id, snapshotHash: p.snapshotHash as string, task: task as SupervisorTask, note: text(p.note) });
  }
  return { valid: errors.length === 0, errors, operations: errors.length ? [] : operations };
}

export interface CredentialMetadata { id: string; purpose: string; scope: string; }
export function vaultCredentialMetadata(input: unknown): CredentialMetadata | undefined { const o = own(input); if ([o.id, o.purpose, o.scope].some(v => typeof v !== "string" || !v.trim())) return undefined; return { id: text(o.id, 120), purpose: text(o.purpose, MAX_TEXT), scope: text(o.scope, MAX_TEXT) }; }

export interface ReviewResult { verdict: "confirm" | "reject" | "insufficient"; evidenceIds: string[]; }
export function parseReviewResult(value: unknown, providedEvidenceIds: readonly string[]): ReviewResult | undefined { const o = own(value); if (!["confirm", "reject", "insufficient"].includes(String(o.verdict))) return undefined; const allowed = new Set(providedEvidenceIds); if(!Array.isArray(o.evidenceIds)||o.evidenceIds.some(id=>typeof id!=="string"||!allowed.has(id)))return undefined; const ids = Array.isArray(o.evidenceIds) ? o.evidenceIds.filter(x => typeof x === "string" && allowed.has(x)) : []; if (o.verdict !== "insufficient" && ids.length === 0) return undefined; return { verdict: o.verdict as ReviewResult["verdict"], evidenceIds: ids }; }
