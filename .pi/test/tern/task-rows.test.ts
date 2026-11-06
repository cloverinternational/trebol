import { describe, expect, it } from "vitest";
import { projectTaskView } from "../../lib/tern/task-view.ts";
import { buildTaskRows, TASK_ROW_QUESTIONS, TASK_ROW_TARGET_CHARS, TASK_ROWS_MAX } from "../../lib/tern/task-rows.ts";

const snapshotEntry = (state: Record<string, unknown>) => ({
	type: "custom",
	customType: "pi-swarm-task-state",
	data: { schemaVersion: 2, revision: 1, savedAt: "2025-01-01T00:00:00.000Z", ...state },
});

const task = (overrides: Record<string, unknown>) => ({
	id: "1", subject: "Build", priority: "medium", status: "pending", active: false,
	dependsOn: [], notes: [], createdAt: "2025-01-01T00:00:00.000Z", updatedAt: "2025-01-01T00:00:00.000Z",
	...overrides,
});

const session = (entries: unknown[]) => ({ getEntries: () => entries });
const view = (tasks: unknown[]) => projectTaskView(session([snapshotEntry({ nextId: tasks.length + 1, keys: {}, tasks })]));

describe("buildTaskRows", () => {
	it("emits nothing unless the projection is ready", () => {
		expect(buildTaskRows({ status: "empty", summary: { open: 0, blocked: 0, completed: 0 } })).toEqual({ rows: [], hidden: 0 });
		expect(buildTaskRows({ status: "malformed", summary: { open: 0, blocked: 0, completed: 0 } })).toEqual({ rows: [], hidden: 0 });
	});

	it("makes one inline row per task, active work first", () => {
		const { rows: cards } = buildTaskRows(view([
			task({ id: "1", subject: "Done", status: "completed" }),
			task({ id: "2", subject: "Later" }),
			task({ id: "3", subject: "Focused", status: "in_progress", active: true }),
		]));
		expect(cards.map(c => c.taskId)).toEqual(["3", "2", "1"]);
		expect(cards[0]).toMatchObject({ title: "Task", status: "running", target: "Focused" });
		expect(cards[1]).toMatchObject({ title: "Task", status: "pending" });
		expect(cards[2]).toMatchObject({ title: "Task", status: "done" });
	});

	it("lists the questions unanswered first, with the evidence of an answered one as its note", () => {
		const { rows: cards } = buildTaskRows(view([task({
			id: "1", subject: "Focused", status: "in_progress", active: true,
			questions: [{ id: "q1", text: "Tests pass?" }, { id: "q2", text: "Docs updated?" }],
			answers: [{ question: "q1", answer: "yes", evidence: "src/a.ts#L1-L2; tool:Bash#3" }],
		})]));
		expect(cards[0]!.meta).toEqual(["Q 1/2"]);
		expect(cards[0]!.questions).toEqual([
			{ id: "q2", mark: "?", text: "Docs updated?", status: "pending" },
			{ id: "q1", mark: "✓", text: "Tests pass?", status: "done", evidence: "src/a.ts#L1-L2; tool:Bash#3" },
		]);
	});

	it("marks a blocked task with a warning badge and names what it waits on", () => {
		const { rows: cards } = buildTaskRows(view([
			task({ id: "1", subject: "First", status: "in_progress", active: true }),
			task({ id: "2", subject: "Second", dependsOn: ["1"] }),
		]));
		const blocked = cards.find(c => c.taskId === "2")!;
		expect(blocked).toMatchObject({ title: "Blocked", status: "pending", badges: [{ text: "blocked", tone: "warning" }], note: "waits on #1" });
	});

	it("does not call a task blocked once what it waited on is done", () => {
		const { rows: cards } = buildTaskRows(view([
			task({ id: "1", subject: "First", status: "completed" }),
			task({ id: "2", subject: "Second", dependsOn: ["1"] }),
		]));
		const second = cards.find(c => c.taskId === "2")!;
		expect(second).toMatchObject({ title: "Task", badges: [], note: "waits on #1" });
	});

	it("bounds the cards, the questions and the subject text", () => {
		const many = Array.from({ length: TASK_ROWS_MAX + 2 }, (_, i) => task({ id: String(i + 1), subject: "S".repeat(TASK_ROW_TARGET_CHARS + 10) }));
		const { rows: cards, hidden } = buildTaskRows(view(many));
		expect(cards).toHaveLength(TASK_ROWS_MAX);
		expect(hidden).toBe(2);
		expect(Array.from(cards[0]!.target)).toHaveLength(TASK_ROW_TARGET_CHARS);
		expect(cards[0]!.target.endsWith("…")).toBe(true);

		const questions = Array.from({ length: TASK_ROW_QUESTIONS + 3 }, (_, i) => ({ id: `q${i}`, text: `question ${i}` }));
		const bounded = buildTaskRows(view([task({ id: "1", subject: "One", questions })]));
		expect(bounded.rows[0]!.questions).toHaveLength(TASK_ROW_QUESTIONS);
		expect(bounded.rows[0]!.hiddenQuestions).toBe(3);
		expect(bounded.rows[0]!.meta).toEqual([`Q 0/${TASK_ROW_QUESTIONS + 3}`]);
	});

	it("gives every card a stable id Tern can key its fold state on", () => {
		const { rows: cards } = buildTaskRows(view([task({ id: "7", subject: "A" }), task({ id: "8", subject: "B" })]));
		expect(cards.map(c => c.id)).toEqual(["task-row-7", "task-row-8"]);
	});
});
