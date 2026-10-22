/** Worker-local clarification: a Claw worker asks in its own tab, the answer resumes the same run, and a cancelled or
 *  unanswered modal never turns into a silent wait or a duplicate run. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ASK_STALE_MS, applyEvent, isActive, tick, type DaemonDeps } from "../../lib/claw/daemon.ts";
import { ClawStore, TERMINAL, type Request, type Run } from "../../lib/claw/store.ts";
import { askFromCompleted, askFromStarted, recordAsk, recordFinish, recordResumed, recordSettled, validateFinish } from "../../lib/claw/child.ts";
import { taskFile, runMarker, type ClawHoja } from "../../lib/claw/spawn.ts";
import { statusSummary } from "../../lib/claw/orchestrator.ts";
import type { IssueView } from "../../lib/claw/hoja.ts";
import clawExtension, { PI_ASK_COMPLETED_EVENT, PI_ASK_STARTED_EVENT } from "../../../extensions/claw/extension.ts";

type FakeIssue = { id: string; identifier: string; description: string; state: string; comments: string[] };

const TEAM = { teamId: "team-trebol", teamKey: "TREBOL", projectId: "proj-hoja", project: "Hoja", assigneeId: "user-luis", assignee: "Luis" };

function fakeHoja() {
	const issues = new Map<string, FakeIssue>();
	const calls = { create: 0, states: [] as string[] };
	let n = 0;
	const hoja: ClawHoja = {
		async resolve(project: string) {
			if (project !== TEAM.project) throw new Error(`Hoja project "${project}" not found`);
			return { ...TEAM, states: { "in progress": "s-ip", "in review": "s-ir", done: "s-done" } };
		},
		async createIssue(_r: any, _title: string, description: string, state = "In Progress") {
			calls.create++;
			const issue: FakeIssue = { id: `iss-${++n}`, identifier: `TREBOL-${900 + n}`, description, state, comments: [] };
			issues.set(issue.id, issue);
			return { id: issue.id, identifier: issue.identifier };
		},
		async readIssue(id: string): Promise<IssueView> {
			const i = issues.get(id);
			if (!i) throw new Error(`Hoja issue ${id} not found on read-back`);
			return { id: i.id, identifier: i.identifier, title: "", description: i.description, state: i.state, teamId: TEAM.teamId, projectId: TEAM.projectId, assigneeId: TEAM.assigneeId, comments: [...i.comments] };
		},
		async findIssueByMarker(marker: string) {
			const hit = [...issues.values()].find((i) => i.description.includes(marker));
			return hit ? { id: hit.id, identifier: hit.identifier } : undefined;
		},
		async comment(id: string, body: string) { issues.get(id)!.comments.push(body); },
		async setState(_r: any, id: string, state: string) { calls.states.push(state); issues.get(id)!.state = state; },
	};
	return { hoja, issues, calls };
}

function fakeTern() {
	const live = new Set<number>([1]);
	const calls: string[][] = [];
	let nextBlock = 100;
	const exec = async (args: string[]) => {
		calls.push(args);
		if (args[0] === "inspect") return JSON.stringify({ sessions: [{ id: 1, tabs: [{ id: 1, name: "Claw", blocks: [...live].map((id) => ({ id, exited: null, live: true })) }] }] });
		if (args[0] === "new") { const block = ++nextBlock; live.add(block); return JSON.stringify({ tab: block + 1000, block }); }
		if (args[0] === "close") { live.delete(Number(args[1])); return "{}"; }
		return "{}";
	};
	return { exec, live, calls, opened: () => calls.filter((c) => c[0] === "new").length };
}

describe("claw worker-local clarification", () => {
	let dir: string;
	let store: ClawStore;
	let fh: ReturnType<typeof fakeHoja>;
	let tern: ReturnType<typeof fakeTern>;
	let deps: DaemonDeps;
	let clock: Date;
	let pids: Set<number>;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "claw-ask-"));
		store = ClawStore.forWorkspace(dir);
		fh = fakeHoja();
		tern = fakeTern();
		clock = new Date("2026-10-22T10:00:00.000Z");
		pids = new Set([4242]);
		deps = { store, hoja: fh.hoja, tern: tern.exec, workspace: dir, now: () => clock, alive: (p) => pids.has(p), signal: (p) => { pids.delete(p); } };
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	const request = (r: Omit<Request, "createdAt">) => store.writeRequest({ ...r, createdAt: clock.toISOString() } as Request);
	const spawnOnce = async () => {
		request({ id: "req-ask1", kind: "spawn", expiresAt: new Date(clock.getTime() + 60_000).toISOString(), input: { task: "Pick a branch", project: "Hoja" } } as Request);
		await tick(deps);
		const [run] = store.listRuns();
		expect(run.phase).toBe("tab_open");
		store.appendEvent({ eid: "started-1", type: "started", at: clock.toISOString(), runId: run.id, pid: 4242 });
		await tick(deps);
		return store.getRun(run.id)!;
	};
	const ask = (run: Run, state: "opened" | "answered" | "cancelled", eid = `ask-${state}`, flowId = "flow-1") =>
		store.appendEvent({ eid, type: "ask", at: clock.toISOString(), runId: run.id, ask: { flowId, title: "Branch", questionIds: ["branch"], state } });
	const finish = (run: Run, outcome: "completed" | "failed" | "needs_user", summary: string, evidence: string[] = [], eid = `finish-${outcome}`) =>
		store.appendEvent({ eid, type: "finish", at: clock.toISOString(), runId: run.id, outcome, summary, evidence });
	const kinds = () => store.readInbox(0).items.map((i) => i.kind);

	it("an open worker question is awaiting_decision, distinct from the terminal needs_user outcome", async () => {
		const run0 = await spawnOnce();
		ask(run0, "opened");
		await tick(deps);
		const run = store.getRun(run0.id)!;
		expect(run.status).toBe("awaiting_decision");
		expect(run.status).not.toBe("awaiting_user");
		expect(run.ask).toMatchObject({ flowId: "flow-1", state: "open", questionIds: ["branch"] });
		expect(isActive(run)).toBe(true);
		expect(TERMINAL).not.toContain(run.status);
		expect(kinds()).toContain("run_awaiting_input");
		const text = store.readInbox(0).items.find((i) => i.kind === "run_awaiting_input")!.text;
		expect(text).toContain(`tab ${run.tab}`);
		expect(text).toContain("same run continues");
		const status = statusSummary(store);
		expect(status.awaitingDecision).toHaveLength(1);
		expect(status.awaitingUser).toHaveLength(0);
	});

	it("an answered question resumes the same run and completes once, with one issue and one tab", async () => {
		const run0 = await spawnOnce();
		ask(run0, "opened");
		await tick(deps);
		ask(run0, "answered");
		await tick(deps);
		let run = store.getRun(run0.id)!;
		expect(run.status).toBe("running");
		expect(run.ask).toMatchObject({ state: "answered" });
		expect(kinds()).toContain("run_input_answered");

		store.appendEvent({ eid: "settled-1", type: "settled", at: clock.toISOString(), runId: run.id, text: "Used branch b." });
		finish(run, "completed", "Branch b is ready", ["npm test: 12 passed"]);
		await tick(deps);
		run = store.getRun(run0.id)!;
		expect(run.status).toBe("completed");
		expect(fh.calls.states).toEqual(["In Review"]);
		expect(fh.calls.create).toBe(1);
		expect(tern.opened()).toBe(1);
		expect(store.listRuns()).toHaveLength(1);
		expect(fh.issues.get(run.hoja!.issueId)!.comments.filter((c) => c.includes("reported **completed**"))).toHaveLength(1);
	});

	it("a cancelled question never leaves the run waiting: the worker still reports needs_user with its summary", async () => {
		const run0 = await spawnOnce();
		ask(run0, "opened");
		await tick(deps);
		ask(run0, "cancelled");
		await tick(deps);
		let run = store.getRun(run0.id)!;
		expect(run.status).toBe("running");
		expect(run.ask?.state).toBe("cancelled");

		finish(run, "needs_user", "Question cancelled: pick branch a or b? a keeps the current schema, b migrates it.");
		await tick(deps);
		run = store.getRun(run0.id)!;
		expect(run.status).toBe("awaiting_user");
		expect(run.finish?.summary).toContain("pick branch a or b?");
		expect(kinds()).toContain("run_needs_user");
		expect(kinds()).toContain("run_awaiting_input");
	});

	it("a finish with no closing ask event marks the question unresolved instead of still waiting", async () => {
		const run0 = await spawnOnce();
		ask(run0, "opened");
		await tick(deps);
		finish(store.getRun(run0.id)!, "needs_user", "Unclear which branch; the modal closed without an event.");
		await tick(deps);
		const run = store.getRun(run0.id)!;
		expect(run.ask?.state).toBe("unresolved");
		expect(run.status).toBe("awaiting_user");
	});

	it("a cancelled question followed by a silent turn ends idle with an actionable note, not a wait", async () => {
		const run0 = await spawnOnce();
		ask(run0, "opened");
		await tick(deps);
		ask(run0, "cancelled");
		await tick(deps);
		store.appendEvent({ eid: "settled-quiet", type: "settled", at: clock.toISOString(), runId: run0.id, text: "I could not ask." });
		await tick(deps);
		const run = store.getRun(run0.id)!;
		expect(run.status).toBe("idle");
		expect(run.status).not.toBe("awaiting_decision");
		const idle = store.readInbox(0).items.find((i) => i.kind === "run_idle")!;
		expect(idle.kind).toBe("run_idle");
		expect(idle.text).toContain("cancelled its own question");
		expect(idle.text).toContain("not a completion");
	});

	it("a turn that settles without a closing ask event stops showing the question as open", async () => {
		const run0 = await spawnOnce();
		ask(run0, "opened");
		await tick(deps);
		store.appendEvent({ eid: "settled-lost-close", type: "settled", at: clock.toISOString(), runId: run0.id, text: "The modal vanished." });
		await tick(deps);
		const run = store.getRun(run0.id)!;
		expect(run.status).toBe("idle");
		expect(run.ask?.state).toBe("unresolved");
		expect(statusSummary(store).awaitingDecision).toHaveLength(0);
	});

	it("a legacy needs_user run returns to running when the same tab resumes after the report", async () => {
		const run0 = await spawnOnce();
		finish(run0, "needs_user", "Which branch?");
		await tick(deps);
		expect(store.getRun(run0.id)!.status).toBe("awaiting_user");
		store.appendEvent({ eid: "resumed-1", type: "resumed", at: clock.toISOString(), runId: run0.id });
		await tick(deps);
		const run = store.getRun(run0.id)!;
		expect(run.status).toBe("running");
		expect(kinds()).toContain("run_resumed");
		expect(run.ask).toBeUndefined();
		expect(fh.calls.create).toBe(1);
		expect(tern.opened()).toBe(1);
	});

	it("an unanswered question is reminded once after the stale window and stays active, not idle", async () => {
		const run0 = await spawnOnce();
		ask(run0, "opened");
		await tick(deps);
		clock = new Date(Date.parse(run0.createdAt) + ASK_STALE_MS + 60_000);
		await tick(deps);
		await tick(deps);
		const run = store.getRun(run0.id)!;
		expect(run.status).toBe("awaiting_decision");
		expect(run.ask?.state).toBe("open");
		const stale = store.readInbox(0).items.filter((i) => i.key === `ask-stale:${run.id}:flow-1`);
		expect(stale).toHaveLength(1);
		expect(stale[0].text).toMatch(/cancels? the question is no longer wanted|claw_cancel/);
	});

	it("a worker that dies with a question open is lost, not awaiting a decision forever", async () => {
		const run0 = await spawnOnce();
		ask(run0, "opened");
		await tick(deps);
		pids.clear();
		await tick(deps);
		const run = store.getRun(run0.id)!;
		expect(run.status).toBe("lost");
		expect(run.error).toContain("question modal was still open");
		expect(run.ask?.state).toBe("unresolved");
		expect(kinds()).toContain("run_lost");
	});

	it("claw_send is refused while a question is open so nothing types into the modal", async () => {
		const run0 = await spawnOnce();
		ask(run0, "opened");
		await tick(deps);
		request({ id: "req-send1", kind: "send", runId: run0.id, text: "b" });
		await tick(deps);
		const res = store.readResponse("req-send1");
		expect(res?.ok).toBe(false);
		expect(res?.error).toContain("question open");
		expect(tern.calls.filter((c) => c[0] === "send")).toHaveLength(0);
	});

	it("the worker records its own ask lifecycle and a resumed turn, and never stores an answer", async () => {
		const dir2 = mkdtempSync(join(tmpdir(), "claw-ask-worker-"));
		try {
			const workerStore = ClawStore.forWorkspace(dir2);
			const run: Run = { id: "run-wk9", label: "w", task: "t", cwd: dir2, status: "running", phase: "tab_open", createdAt: "", updatedAt: "", project: "Hoja", eventsOffset: 0, settles: 0, attempts: 0, outbox: [], seen: [] };
			workerStore.saveRun(run);
			const handlers: Record<string, (...a: any[]) => any> = {};
			const listeners: Record<string, (event: any) => void> = {};
			const tools: Record<string, any> = {};
			const pi = {
				on: (name: string, h: any) => { handlers[name] = h; },
				events: { on: (name: string, h: any) => { listeners[name] = h; } },
				registerTool: (t: any) => { tools[t.name] = t; },
			};
			const prev = { run: process.env.PI_CLAW_RUN, dir: process.env.PI_CLAW_DIR };
			process.env.PI_CLAW_RUN = run.id; process.env.PI_CLAW_DIR = workerStore.dir;
			try { clawExtension(pi); } finally { process.env.PI_CLAW_RUN = prev.run; process.env.PI_CLAW_DIR = prev.dir; }

			listeners[PI_ASK_STARTED_EVENT]({ version: 1, flowId: "tool:c1", source: "tool", title: "Branch", questions: [{ id: "branch", prompt: "Which branch?" }], createdAt: 1 });
			listeners[PI_ASK_COMPLETED_EVENT]({ version: 1, flowId: "tool:c1", source: "tool", result: { cancelled: false, mode: "submit", answers: { branch: { values: ["b"] } }, questions: [{ id: "branch" }] }, completedAt: 2 });
			listeners[PI_ASK_STARTED_EVENT]({ version: 1, flowId: "tool:c2", source: "tool", questions: [{ id: "scope" }], createdAt: 3 });
			listeners[PI_ASK_COMPLETED_EVENT]({ version: 1, flowId: "tool:c2", source: "tool", result: { cancelled: true, mode: "submit", answers: {}, questions: [{ id: "scope" }] }, completedAt: 4 });
			listeners[PI_ASK_STARTED_EVENT]({ flowId: "" } as any);
			expect(listeners[PI_ASK_STARTED_EVENT]).toBeTypeOf("function");

			await tools.claw_finish.execute("c3", { outcome: "needs_user", summary: "Which branch?" });
			handlers.before_agent_start({}, {});
			handlers.before_agent_start({}, {});

			const events = workerStore.readEvents(run.id, 0).items;
			// No goal spec exists for this hand-built run and no goal extension is loaded, so the worker reports that
			// once (TREBOL-325) instead of silently pretending the completion loop is running.
			expect(events.map((e) => e.type)).toEqual(["ask", "ask", "ask", "ask", "finish", "goal", "resumed"]);
			expect(events.find((e) => e.type === "goal")!.goal).toMatchObject({ state: "unavailable" });
			expect(events.filter((e) => e.type === "ask").map((e) => e.ask!.state)).toEqual(["opened", "answered", "opened", "cancelled"]);
			// Lifecycle only: no answer values are written into the run store.
			expect(JSON.stringify(events)).not.toContain('"b"');
		} finally { rmSync(dir2, { recursive: true, force: true }); }
	});

	it("event parsing ignores malformed asks and never infers cancellation from an answer", () => {
		expect(askFromStarted(undefined)).toBeUndefined();
		expect(askFromStarted({ questions: [] })).toBeUndefined();
		expect(askFromStarted({ flowId: "f", questions: [{ id: "q" }, { prompt: "no id" }] })).toMatchObject({ flowId: "f", questionIds: ["q"], state: "opened" });
		expect(askFromCompleted({ flowId: "f", result: { cancelled: false, questions: [] } })).toMatchObject({ flowId: "f", state: "answered" });
		expect(askFromCompleted({ result: { cancelled: true } })).toBeUndefined();
	});

	it("the worker task file asks in its own tab first and documents the legacy needs_user fallback", () => {
		const run: Run = { id: "run-task1", label: "w", task: "Do it", cwd: "/tmp", status: "running", phase: "tab_open", createdAt: "", updatedAt: "", project: "Hoja", eventsOffset: 0, settles: 0, attempts: 0, outbox: [], seen: [] };
		const file = taskFile(run);
		expect(file).toContain("ask_user_question");
		expect(file).toContain("Before ending a turn that needs a decision");
		expect(file).toContain('outcome "needs_user"');
		expect(file).toContain("run continues here");
		expect(file).toContain(run.id);
	});

	it("applyEvent ignores ask events for a terminal run and dedupes them by event id", () => {
		const run: Run = { id: "run-x", label: "x", task: "t", cwd: "/tmp", status: "completed", phase: "tab_open", createdAt: "", updatedAt: "", project: "Hoja", eventsOffset: 0, settles: 0, attempts: 0, outbox: [], seen: [] };
		applyEvent(run, { eid: "a1", type: "ask", at: clock.toISOString(), runId: run.id, ask: { flowId: "f", questionIds: [], state: "opened" } }, store);
		expect(run.status).toBe("completed");
		expect(run.ask).toBeUndefined();

		const live: Run = { ...run, id: "run-y", status: "running", seen: [] };
		recordAsk(store, live.id, { flowId: "f", questionIds: ["q"], state: "opened" });
		const ev = store.readEvents(live.id, 0).items[0];
		applyEvent(live, ev, store);
		applyEvent(live, ev, store);
		expect(store.readInbox(0).items.filter((i) => i.kind === "run_awaiting_input")).toHaveLength(1);
	});

	it("finish validation is unchanged for the fallback path", () => {
		expect(validateFinish({ outcome: "needs_user", summary: "Which branch?" }).outcome).toBe("needs_user");
		expect(() => validateFinish({ outcome: "completed", summary: "x", evidence: [] })).toThrow("completed requires evidence");
	});

	it("helpers keep appending worker events only to the worker's own run file", () => {
		const run: Run = { id: "run-own", label: "o", task: "t", cwd: "/tmp", status: "running", phase: "tab_open", createdAt: "", updatedAt: "", project: "Hoja", eventsOffset: 0, settles: 0, attempts: 0, outbox: [], seen: [] };
		recordResumed(store, run.id);
		recordSettled(store, run.id, [{ role: "assistant", content: "done" }]);
		recordFinish(store, run.id, { outcome: "failed", summary: "no", evidence: [] });
		expect(store.readEvents(run.id, 0).items.map((e) => e.type)).toEqual(["resumed", "settled", "finish"]);
		expect(runMarker(run.id)).toContain(run.id);
	});
});
