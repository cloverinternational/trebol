// Pure model for the task popover's rows view: one inline work row per task, in the same language the
// transcript uses for a step ("Bash Check lockfile header, workspaces, version assertions"), with its
// acceptance questions as further rows underneath and their evidence indented below those.
//
// Measured on 293 persisted tasks: questions are never empty, answers are long (p50 391 chars) and
// only 3 tasks carry any dependsOn, so a row is verb + subject + counter, the questions are its body,
// and a dependency is a row note rather than an edge.
import type { TaskView, TaskViewRow } from "./task-view.ts";

export const TASK_ROWS_MAX = 10;
export const TASK_ROW_QUESTIONS = 8;
export const TASK_ROW_TARGET_CHARS = 72;

export type TaskRowStatus = "pending" | "running" | "done";
export type TaskRowQuestionStatus = "pending" | "done";

export interface TaskRowQuestion {
	id: string;
	/** The row's verb slot: "?" while open, "✓" once answered. */
	mark: string;
	text: string;
	status: TaskRowQuestionStatus;
	/** Evidence refs behind an answered question, joined; absent while unanswered. */
	evidence?: string;
}

export interface TaskRow {
	/** Stable across renders: Tern keys the row by it. */
	id: string;
	taskId: string;
	/** The row's verb slot. */
	title: string;
	status: TaskRowStatus;
	/** The row's target: what the work is. */
	target: string;
	/** Row facts, e.g. "Q 1/3". */
	meta: string[];
	badges: { text: string; tone?: string }[];
	/** Row note, e.g. "waits on #1". */
	note?: string;
	questions: TaskRowQuestion[];
	hiddenQuestions: number;
}

const clip = (value: string, max: number): string => {
	const runes = Array.from(value.trim());
	return runes.length <= max ? runes.join("") : `${runes.slice(0, Math.max(1, max - 1)).join("")}…`;
};

const RANK: Record<string, number> = { in_progress: 0, pending: 1, completed: 2 };
const rank = (row: TaskViewRow): number => (row.active ? -1 : RANK[row.status] ?? 3);

/** The verb slot states the work's condition only when it is not plain "Task": blocked is worth a word. */
function verbOf(row: TaskViewRow): { title: string; status: TaskRowStatus } {
	if (row.status === "completed") return { title: "Task", status: "done" };
	if (row.blocked) return { title: "Blocked", status: "pending" };
	if (row.active) return { title: "Task", status: "running" };
	return { title: "Task", status: "pending" };
}

function questionsOf(row: TaskViewRow, max: number): { questions: TaskRowQuestion[]; hidden: number } {
	const evidence = new Map((row.evidence ?? []).map(entry => [entry.question, entry.refs.join("; ")]));
	// Unanswered first: they are what the task still needs, exactly as a work list puts the open step first.
	const ordered = [...row.questions.rows].sort((a, b) => Number(a.answered) - Number(b.answered));
	const questions = ordered.slice(0, max).map((question): TaskRowQuestion => {
		const refs = evidence.get(question.id);
		return {
			id: question.id,
			mark: question.answered ? "✓" : "?",
			text: clip(question.text, 120),
			status: question.answered ? "done" : "pending",
			...(question.answered && refs ? { evidence: clip(refs, 120) } : {}),
		};
	});
	return { questions, hidden: Math.max(0, row.questions.total - questions.length) };
}

/** Rows for the popover, active work first: one inline row per task, its questions underneath. */
export function buildTaskRows(view: TaskView, options: { maxRows?: number; maxQuestions?: number } = {}): { rows: TaskRow[]; hidden: number } {
	if (view.status !== "ready") return { rows: [], hidden: 0 };
	const maxRows = Math.max(1, options.maxRows ?? TASK_ROWS_MAX);
	const maxQuestions = Math.max(1, options.maxQuestions ?? TASK_ROW_QUESTIONS);
	const ordered = [...(view.tasks ?? [])].sort((a, b) => rank(a) - rank(b) || Number(a.id) - Number(b.id) || a.id.localeCompare(b.id));
	const rows = ordered.slice(0, maxRows).map((row): TaskRow => {
		const verb = verbOf(row);
		const waits = row.dependsOn ?? [];
		const { questions, hidden } = questionsOf(row, maxQuestions);
		return {
			id: `task-row-${row.id}`,
			taskId: row.id,
			title: verb.title,
			status: verb.status,
			target: clip(row.subject, TASK_ROW_TARGET_CHARS),
			meta: [row.questions.total > 0 ? `Q ${row.questions.answered}/${row.questions.total}` : "no questions"],
			badges: row.blocked ? [{ text: "blocked", tone: "warning" }] : [],
			...(waits.length ? { note: `waits on ${waits.map(id => `#${id}`).join(", ")}` } : {}),
			questions,
			hiddenQuestions: hidden,
		};
	});
	return { rows, hidden: Math.max(0, ordered.length - rows.length) };
}
