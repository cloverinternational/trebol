// Pure, session-backed TaskManage projection for the Tern surface.
// Rehydrates a canonical TaskManager from the session branch (no persistence,
// no evidence resolution, no UI binding) and returns bounded rows only.
// It never mutates tasks and exposes no actions or consent prompts.
// The interactive Node runner uses --experimental-strip-types (Node 22 on
// this host). Canonical source has TS parameter properties unsupported there;
// load the compiled package artifact, not a second ad-hoc task parser.
import { TaskManager, taskFocusSummary, MAX_TASK_QUESTIONS } from "../../../packages/tools/taskmanage/dist/task-manage.js";
import type { JournalEntry, Task } from "../../../packages/tools/taskmanage/src/task-manage.ts";

export const TASK_VIEW_MAX_TEXT = 240;
export const TASK_VIEW_DEFAULT_QUESTION_ROWS = 3;
export const TASK_VIEW_MAX_TASKS = 100;

export interface TaskViewSessionManager {
	getEntries(): readonly unknown[];
	getBranch?(): readonly unknown[];
}

export interface TaskViewQuestionRow {
	id: string;
	text: string;
	answered: boolean;
}

export interface TaskViewFocus {
	id: string;
	subject: string;
	questions: {
		state: "ok" | "missing" | "malformed";
		total: number;
		answered: number;
		/** Unresolved questions first, then answered; bounded by the requested limit. */
		rows: TaskViewQuestionRow[];
		hidden: number;
	};
}

export interface TaskView {
	status: "empty" | "ready" | "malformed";
	focus?: TaskViewFocus;
	summary: { open: number; blocked: number; completed: number };
	next?: { id: string; subject: string };
	/** Every live task for the task menu: open first (focus, in progress, pending), then completed. Bounded. */
	tasks?: TaskViewRow[];
}

export interface TaskViewRow {
	id: string;
	subject: string;
	status: "pending" | "in_progress" | "completed";
	active: boolean;
	blocked: boolean;
	questions: TaskViewFocus["questions"];
}

const bounded = (value: string): string => Array.from(value.trim()).slice(0, TASK_VIEW_MAX_TEXT).join("");
const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

function questionView(task: Task, limit: number): TaskViewFocus["questions"] {
	const raw: unknown = task.questions;
	if (raw === undefined || (Array.isArray(raw) && raw.length === 0)) return { state: "missing", total: 0, answered: 0, rows: [], hidden: 0 };
	if (!Array.isArray(raw)) return { state: "malformed", total: 0, answered: 0, rows: [], hidden: 0 };

	const seen = new Set<string>();
	const valid: { id: string; text: string }[] = [];
	let malformed = false;
	for (const question of raw.slice(0, MAX_TASK_QUESTIONS)) {
		const q = question as { id?: unknown; text?: unknown } | null;
		if (!q || !nonEmpty(q.id) || !nonEmpty(q.text) || seen.has(q.id)) { malformed = true; continue; }
		seen.add(q.id);
		valid.push({ id: q.id, text: bounded(q.text) });
	}
	if (raw.length > MAX_TASK_QUESTIONS) malformed = true;

	const answeredIds = new Set<string>();
	const answers: unknown[] = Array.isArray(task.answers) ? task.answers : [];
	for (const answer of answers) {
		const a = answer as { question?: unknown; answer?: unknown; evidence?: unknown } | null;
		if (a && typeof a.question === "string" && seen.has(a.question) && nonEmpty(a.answer) && nonEmpty(a.evidence)) answeredIds.add(a.question);
	}

	const rows: TaskViewQuestionRow[] = [
		...valid.filter(q => !answeredIds.has(q.id)).map(q => ({ ...q, answered: false })),
		...valid.filter(q => answeredIds.has(q.id)).map(q => ({ ...q, answered: true })),
	];
	const shown = rows.slice(0, Math.max(0, limit));
	return {
		state: malformed ? "malformed" : "ok",
		total: valid.length,
		answered: answeredIds.size,
		rows: shown,
		hidden: rows.length - shown.length,
	};
}

/** Project the TSP-facing TaskManage view from a session branch. Pure: no UI, no actions. */
export function projectTaskView(session: TaskViewSessionManager | undefined, options: { questionRows?: number } = {}): TaskView {
	const limit = options.questionRows ?? TASK_VIEW_DEFAULT_QUESTION_ROWS;
	if (!session) return { status: "empty", summary: { open: 0, blocked: 0, completed: 0 } };
	let tasks: Task[];
	try {
		const entries = (session.getBranch?.() ?? session.getEntries()) as JournalEntry[];
		if (!Array.isArray(entries) || !(entries as unknown[]).some(entry => {
			const value = entry as { type?: unknown; customType?: unknown } | null;
			return value && typeof value === "object" && (value.type === "pi-swarm-task-state" || (value.type === "custom" && value.customType === "pi-swarm-task-state"));
		})) {
			return { status: "empty", summary: { open: 0, blocked: 0, completed: 0 } };
		}
		const manager = new TaskManager();
		manager.rehydrate(entries);
		tasks = manager.snapshot().tasks;
	} catch {
		return { status: "malformed", summary: { open: 0, blocked: 0, completed: 0 } };
	}
	const summary = taskFocusSummary(tasks);
	const counts = { open: summary.open, blocked: summary.blocked, completed: summary.completed };
	const next = summary.next ? { id: summary.next.id, subject: bounded(summary.next.subject) } : undefined;
	const rows = taskRows(tasks);
	if (!summary.focus) return { status: tasks.length ? "ready" : "empty", summary: counts, next, tasks: rows };
	const focus = summary.focus;
	return {
		status: "ready",
		focus: { id: focus.id, subject: bounded(focus.subject), questions: questionView(focus, limit) },
		summary: counts,
		next,
		tasks: rows,
	};
}

const STATUS_RANK: Record<string, number> = { in_progress: 1, pending: 2, completed: 3 };

function taskRows(tasks: Task[]): TaskViewRow[] {
	const live = tasks.filter(t => t.status === "pending" || t.status === "in_progress" || t.status === "completed");
	const byId = new Map(live.map(t => [t.id, t]));
	const rank = (t: Task) => (t.active && t.status === "in_progress" ? 0 : STATUS_RANK[t.status]);
	return live
		.sort((a, b) => rank(a) - rank(b) || Number(a.id) - Number(b.id) || a.id.localeCompare(b.id))
		.slice(0, TASK_VIEW_MAX_TASKS)
		.map(t => ({
			id: t.id,
			subject: bounded(t.subject),
			status: t.status as TaskViewRow["status"],
			active: t.active === true && t.status === "in_progress",
			blocked: t.status !== "completed" && (t.dependsOn ?? []).some(id => byId.get(id)?.status !== "completed"),
			questions: questionView(t, MAX_TASK_QUESTIONS),
		}));
}
