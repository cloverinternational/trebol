import { describe, expect, it } from "vitest";
import { projectTaskView, TASK_VIEW_MAX_TEXT } from "../../lib/tern/task-view.ts";

const snapshotEntry = (state: Record<string, unknown>, revision = 1) => ({
	type: "custom",
	customType: "pi-swarm-task-state",
	data: { schemaVersion: 2, revision, savedAt: "2025-01-01T00:00:00.000Z", ...state },
});

const task = (overrides: Record<string, unknown>) => ({
	id: "1", subject: "Build", priority: "medium", status: "pending", active: false,
	dependsOn: [], notes: [], createdAt: "2025-01-01T00:00:00.000Z", updatedAt: "2025-01-01T00:00:00.000Z",
	...overrides,
});

const session = (entries: unknown[]) => ({ getEntries: () => entries });

describe("projectTaskView", () => {
	it("returns empty when there is no session or no journal", () => {
		expect(projectTaskView(undefined)).toEqual({ status: "empty", summary: { open: 0, blocked: 0, completed: 0 } });
		expect(projectTaskView(session([])).status).toBe("empty");
	});

	it("projects focused task, question answered status, summary, and next", () => {
		const view = projectTaskView(session([snapshotEntry({
			nextId: 4,
			keys: {},
			tasks: [
				task({ id: "1", subject: "Focus", status: "in_progress", active: true,
					questions: [{ id: "q1", text: "Tests pass?" }, { id: "q2", text: "Docs?" }],
					answers: [{ question: "q1", answer: "yes", evidence: "tool:bash#1" }] }),
				task({ id: "2", subject: "Next", dependsOn: ["1"] }),
				task({ id: "3", subject: "Ready", status: "pending" }),
				task({ id: "4", subject: "Done", status: "completed" }),
			],
		})]));
		expect(view.status).toBe("ready");
		expect(view.focus).toEqual({
			id: "1", subject: "Focus",
			questions: {
				state: "ok", total: 2, answered: 1, hidden: 0,
				rows: [
					{ id: "q2", text: "Docs?", answered: false },
					{ id: "q1", text: "Tests pass?", answered: true },
				],
			},
		});
		expect(view.summary).toEqual({ open: 3, blocked: 1, completed: 1 });
		expect(view.next).toEqual({ id: "3", subject: "Ready" });
	});

	it("ignores answers without a non-empty answer and evidence", () => {
		const view = projectTaskView(session([snapshotEntry({
			nextId: 2, keys: {},
			tasks: [task({ status: "in_progress", active: true,
				questions: [{ id: "q1", text: "A" }, { id: "q2", text: "B" }],
				answers: [{ question: "q1", answer: "  ", evidence: "x" }, { question: "q2", answer: "ok", evidence: "" }, { question: "zz", answer: "ok", evidence: "x" }] })],
		})]));
		expect(view.focus?.questions.answered).toBe(0);
		expect(view.focus?.questions.rows.every(row => !row.answered)).toBe(true);
	});

	it("bounds question rows and reports hidden count and long text truncation", () => {
		const questions = Array.from({ length: 8 }, (_, i) => ({ id: `q${i}`, text: "x".repeat(200) }));
		const view = projectTaskView(session([snapshotEntry({
			nextId: 2, keys: {}, tasks: [task({ status: "in_progress", active: true, subject: "s".repeat(400), questions })],
		})]), { questionRows: 3 });
		expect(view.focus?.questions.total).toBe(8);
		expect(view.focus?.questions.rows).toHaveLength(3);
		expect(view.focus?.questions.hidden).toBe(5);
		expect(view.focus?.subject.length).toBe(TASK_VIEW_MAX_TEXT);
	});

	it("reports missing and malformed acceptance questions without throwing", () => {
		const missing = projectTaskView(session([snapshotEntry({
			nextId: 2, keys: {}, tasks: [task({ status: "in_progress", active: true })],
		})]));
		expect(missing.focus?.questions.state).toBe("missing");

		const malformed = projectTaskView(session([snapshotEntry({
			nextId: 2, keys: {}, tasks: [task({ status: "in_progress", active: true,
				questions: [{ id: "q1", text: "ok" }, { id: "", text: "bad" }, null, { id: "q1", text: "dup" }] })],
		})]));
		expect(malformed.focus?.questions.state).toBe("malformed");
		expect(malformed.focus?.questions.total).toBe(1);
	});

	it("skips corrupt entries and falls back to earlier valid snapshots", () => {
		const view = projectTaskView(session([
			snapshotEntry({ nextId: 2, keys: {}, tasks: [task({ subject: "Good", status: "pending" })] }, 1),
			{ type: "custom", customType: "pi-swarm-task-state", data: "not-an-object" },
			{ type: "message", data: null },
		]));
		expect(view.status).toBe("ready");
		expect(view.summary.open).toBe(1);
		expect(view.focus).toBeUndefined();
	});

	it("returns malformed when the session cannot be read", () => {
		const broken = { getEntries: () => { throw new Error("boom"); } };
		expect(projectTaskView(broken).status).toBe("malformed");
	});

	it("switching sessions re-projects from the new branch only", () => {
		const a = session([snapshotEntry({ nextId: 2, keys: {}, tasks: [task({ subject: "A", status: "in_progress", active: true })] })]);
		const b = session([]);
		expect(projectTaskView(a).focus?.subject).toBe("A");
		expect(projectTaskView(b).status).toBe("empty");
		expect(projectTaskView(a).focus?.subject).toBe("A");
	});

	it("prefers getBranch over getEntries when available", () => {
		const branch = [snapshotEntry({ nextId: 2, keys: {}, tasks: [task({ subject: "Branch", status: "pending" })] })];
		const view = projectTaskView({ getBranch: () => branch, getEntries: () => [] });
		expect(view.summary.open).toBe(1);
	});
});
