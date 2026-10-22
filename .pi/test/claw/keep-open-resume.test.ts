/** Keeping a finished run reachable instead of losing it: a run can be kept open (its worker tab survives a terminal
 *  state, a daemon restart and every tick) and any run can be resumed into the same session file, so the agent keeps its
 *  history. Each refusal is explicit, and the resume retry budget ends in one recorded reason rather than a loop.
 *
 *  The resume assertions are on what is handed to pi (`--session <recorded file>`) and on the run record (same run, same
 *  Hoja issue, changed pid), never on model output: a resumed conversation is proven by the session file pi reopens. */
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleRequest, hasWork, reconcileRun, tick, type DaemonDeps } from "../../lib/claw/daemon.ts";
import { goalSourceFor, goalSpecOf, startGoal } from "../../lib/claw/goal.ts";
import { runListing, statusSummary } from "../../lib/claw/orchestrator.ts";
import { RESUME_BUDGET, RESUME_KEY } from "../../lib/claw/resume.ts";
import { startRun, type ClawHoja } from "../../lib/claw/spawn.ts";
import { ClawStore, type Request, type Run } from "../../lib/claw/store.ts";

const START = "2026-10-22T12:00:00.000Z";
const TEAM = { teamId: "t", teamKey: "TREBOL", projectId: "p", project: "Hoja", assigneeId: "u", assignee: "Luis", states: { "in progress": "s-ip", "in review": "s-ir" } };

/** Tern double: real block bookkeeping, a recorded launch command, and injectable close/new faults. */
function fakeTern() {
	const live = new Set<number>([1]);
	const calls: string[][] = [];
	const faults = { newTab: undefined as Error | undefined, inspect: undefined as Error | undefined };
	let next = 500;
	const exec = async (args: string[]) => {
		calls.push(args);
		if (args[0] === "inspect") {
			if (faults.inspect) throw faults.inspect;
			return JSON.stringify({ sessions: [{ id: 1, tabs: [{ id: 1, name: "Claw", blocks: [...live].map((id) => ({ id, exited: null, live: true, command: null })) }] }] });
		}
		if (args[0] === "new") {
			if (faults.newTab) throw faults.newTab;
			const block = ++next;
			live.add(block);
			return JSON.stringify({ tab: block + 1000, block });
		}
		if (args[0] === "close") { live.delete(Number(args[1])); return "{}"; }
		return "{}";
	};
	return {
		exec, live, calls, faults,
		closes: (block: number) => calls.filter((c) => c[0] === "close" && c[1] === String(block)).length,
		/** The shell line of each `tern new tab` launch, in order. */
		launches: () => calls.filter((c) => c[0] === "new").map((c) => c[c.length - 1]),
	};
}

function fakeHoja() {
	const issues = new Map<string, any>();
	const calls = { create: 0, resolve: 0, read: 0 };
	const hoja = {
		calls, issues,
		async resolve() { calls.resolve++; return { ...TEAM } as any; },
		async createIssue(_r: any, _title: string, description: string) {
			calls.create++;
			const id = `iss-${issues.size + 1}`;
			issues.set(id, { id, identifier: `TREBOL-${900 + issues.size + 1}`, description, state: "In Progress", teamId: "t", projectId: "p", assigneeId: "u", comments: [] });
			return { id, identifier: `TREBOL-${900 + issues.size}` };
		},
		async readIssue(id: string) { calls.read++; const i = issues.get(id); if (!i) throw new Error(`Hoja issue ${id} not found on read-back`); return { ...i, comments: [...i.comments] }; },
		async findIssueByMarker(marker: string) { const hit = [...issues.values()].find((i) => i.description.includes(marker)); return hit ? { id: hit.id, identifier: hit.identifier } : undefined; },
		async comment(id: string, body: string) { issues.get(id)?.comments.push(body); },
		async setState(_r: any, id: string, state: string) { const i = issues.get(id); if (i) i.state = state; },
	} as unknown as ClawHoja & { calls: typeof calls; issues: typeof issues };
	return hoja;
}

describe("claw keep open and resume", () => {
	let dir: string;
	let store: ClawStore;
	let tern: ReturnType<typeof fakeTern>;
	let hoja: ReturnType<typeof fakeHoja>;
	let clock: Date;
	let livePids: Set<number>;
	let deps: DaemonDeps;
	let seq = 0;
	const advance = (ms: number) => { clock = new Date(clock.getTime() + ms); };

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "claw-keep-"));
		store = ClawStore.forWorkspace(dir);
		clock = new Date(START);
		tern = fakeTern();
		hoja = fakeHoja();
		livePids = new Set<number>();
		seq = 0;
		deps = {
			store, hoja, tern: tern.exec, workspace: dir, now: () => clock,
			alive: (pid) => livePids.has(pid), signal: () => undefined,
			// The gate is exercised on its own in launch-resilience.test.ts; here it must pass so the resume path is what is tested.
			preflight: async () => ({ ok: true }),
			planLaunch: () => ({ mode: "discovery" as const }),
			slo: { startedMs: 30_000, tabCloseBaseMs: 1_000, tabCloseCapMs: 4_000, digestMs: 0 },
		} as DaemonDeps;
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	/** A run whose worker already produced a session file, with its issue and (optionally) its tab. */
	const makeRun = (over: Partial<Run> = {}): Run => {
		seq++;
		const at = clock.toISOString();
		const issueId = `iss-keep-${seq}`;
		hoja.issues.set(issueId, { id: issueId, identifier: `TREBOL-7${seq}0`, description: `<!-- claw-run:run-keep-${seq} -->`, state: "In Progress", teamId: "t", projectId: "p", assigneeId: "u", comments: [] });
		const sessionFile = join(dir, `session-${seq}.jsonl`);
		writeFileSync(sessionFile, `${JSON.stringify({ type: "session", id: `sess-${seq}`, cwd: dir })}\n${JSON.stringify({ type: "user", text: "first turn" })}\n`);
		const run = {
			id: `run-keep-${seq}`, label: "Label", task: "Do the thing", cwd: dir, status: "running", phase: "tab_open",
			createdAt: at, updatedAt: at, project: "Hoja", eventsOffset: 0, settles: 1, attempts: 0, outbox: [], seen: [],
			hoja: { issueId, identifier: `TREBOL-7${seq}0`, teamKey: "TREBOL", project: "Hoja", assignee: "Luis" },
			sessionFile, ...over,
		} as Run;
		store.saveRun(run);
		return run;
	};
	const inbox = (kind?: string) => store.readInbox(0).items.filter((i) => !kind || i.kind === kind);
	const request = (body: Omit<Request, "id" | "createdAt">) => handleRequest({ id: `req-${++seq}`, createdAt: clock.toISOString(), ...body } as Request, deps);

	describe("keep open", () => {
		it("a kept run's tab is never closed across ticks and a daemon restart, and it does not hold the daemon alive", async () => {
			tern.live.add(300);
			const run = makeRun({ status: "completed", block: 300, keepOpen: true });
			// First daemon: many ticks must never close it.
			for (let i = 0; i < 12; i++) { await reconcileRun(store.getRun(run.id)!, deps, new Set(tern.live)); advance(5_000); }
			expect(tern.closes(300)).toBe(0);
			// Restart: a fresh store instance and fresh deps read the same directory, exactly as a new daemon would.
			const restarted = ClawStore.forWorkspace(dir);
			expect(restarted.getRun(run.id)!.keepOpen).toBe(true);
			const after = { ...deps, store: restarted };
			for (let i = 0; i < 12; i++) { await reconcileRun(restarted.getRun(run.id)!, after, new Set(tern.live)); advance(5_000); }
			expect(tern.closes(300)).toBe(0);
			expect(restarted.getRun(run.id)!.tabClosedAt).toBeUndefined();
			expect(tern.live.has(300)).toBe(true);
			expect(inbox("run_tab_orphan")).toHaveLength(0);
			// A kept tab is not an obligation: the daemon is allowed to exit while the human keeps using it.
			expect(hasWork(restarted)).toBe(false);
		});

		it("a run without keepOpen still closes its tab on the terminal tick", async () => {
			tern.live.add(301);
			const run = makeRun({ status: "completed", block: 301 });
			await reconcileRun(run, deps, new Set(tern.live));
			expect(tern.closes(301)).toBe(1);
			expect(store.getRun(run.id)!.tabClosedAt).toBeDefined();
		});

		it("claw_close closes a kept run and releases the keep", async () => {
			tern.live.add(302);
			const run = makeRun({ status: "completed", block: 302, keepOpen: true });
			await reconcileRun(store.getRun(run.id)!, deps, new Set(tern.live));
			expect(tern.closes(302)).toBe(0);
			await request({ kind: "close", runId: run.id } as Omit<Request, "id" | "createdAt">);
			const after = store.getRun(run.id)!;
			expect(tern.closes(302)).toBe(1);
			expect(after.tabClosedAt).toBeDefined();
			expect(after.keepOpen).toBe(false);
			expect(inbox("run_tab_closed")).toHaveLength(1);
		});

		it("claw_set_keep false releases a kept run so the next tick closes it", async () => {
			tern.live.add(303);
			const run = makeRun({ status: "failed", block: 303, keepOpen: true, failureClass: "worker" });
			await reconcileRun(store.getRun(run.id)!, deps, new Set(tern.live));
			expect(tern.closes(303)).toBe(0);
			await request({ kind: "keep", runId: run.id, keep: false } as Omit<Request, "id" | "createdAt">);
			await reconcileRun(store.getRun(run.id)!, deps, new Set(tern.live));
			expect(tern.closes(303)).toBe(1);
			expect(store.getRun(run.id)!.tabClosedAt).toBeDefined();
			// ...and keep=true protects a run again, which is what a human asks for after re-reading a failure.
			const kept = makeRun({ status: "failed", block: 304, failureClass: "worker" });
			tern.live.add(304);
			await request({ kind: "keep", runId: kept.id, keep: true } as Omit<Request, "id" | "createdAt">);
			await reconcileRun(store.getRun(kept.id)!, deps, new Set(tern.live));
			expect(tern.closes(304)).toBe(0);
			expect(inbox("run_kept").length).toBeGreaterThanOrEqual(2);
		});

		it("releasing a kept run clears a spent close budget instead of leaving the tab open forever", async () => {
			tern.live.add(305);
			const run = makeRun({ status: "completed", block: 305, keepOpen: true });
			// Pretend the close budget was already spent on this run before it was kept: exhausted remedies never run again.
			run.remedies = { "tab-close": { attempts: 5, lastAt: START, nextAt: START, exhausted: true, note: "tried" } };
			store.saveRun(run);
			await request({ kind: "keep", runId: run.id, keep: false } as Omit<Request, "id" | "createdAt">);
			await reconcileRun(store.getRun(run.id)!, deps, new Set(tern.live));
			expect(tern.closes(305)).toBe(1);
			expect(store.getRun(run.id)!.tabClosedAt).toBeDefined();
		});
	});

	describe("resume", () => {
		it("resumes a closed run on its recorded session file with a new pid and no second issue", async () => {
			tern.live.add(400);
			const run = makeRun({ status: "running", block: 400, pid: 4242 });
			livePids.add(4242);
			const sessionFile = run.sessionFile!;
			// The worker dies and its tab goes away: the daemon declares it lost and closes the tab.
			livePids.delete(4242);
			tern.live.delete(400);
			await tick(deps);
			expect(store.getRun(run.id)!.status).toBe("lost");
			expect(store.getRun(run.id)!.tabClosedAt).toBeDefined();
			// Resume: same run, same issue, same session file, a new tab.
			const summary = await request({ kind: "resume", runId: run.id } as Omit<Request, "id" | "createdAt">) as any;
			const after = store.getRun(run.id)!;
			expect(summary.id).toBe(run.id);
			expect(after.id).toBe(run.id);
			expect(after.resumeCount).toBe(1);
			expect(after.status).toBe("running");
			expect(after.block).not.toBe(400);
			expect(after.tabClosedAt).toBeUndefined();
			expect(after.sessionFile).toBe(sessionFile);
			expect(hoja.calls.create).toBe(0);
			expect(after.hoja).toEqual(run.hoja);
			const line = tern.launches().at(-1)!;
			expect(line).toContain(`--session '${sessionFile}'`);
			// The task prompt is not re-sent: resuming continues the conversation instead of executing the task twice.
			expect(line).not.toContain("Do the thing");
			expect(after.pid).toBeUndefined(); // the dead pid is cleared before the new worker reports itself
			// The new worker reports itself on the same session file with a new pid.
			store.appendEvent({ eid: "evt-new-start", type: "started", at: clock.toISOString(), runId: run.id, pid: 5150, sessionFile });
			await tick(deps);
			expect(store.getRun(run.id)!.pid).toBe(5150);
			expect(store.getRun(run.id)!.sessionFile).toBe(sessionFile);
			// Prior history is still in the file pi was pointed at, which is what "the same conversation" means.
			expect(readFileSync(sessionFile, "utf8")).toContain("first turn");
		});

		it("resumes a run whose worker clearly died, even before the daemon has declared it lost", async () => {
			// Dead pid, tab gone, status still `running`: the record has not been reconciled yet. The snapshot is what
			// proves the worker is gone, and the resume must reach the same verdict the refusal did.
			const run = makeRun({ status: "running", block: 405, pid: 4300 });
			livePids.add(4300);
			livePids.delete(4300); // the process is gone
			expect(tern.live.has(405)).toBe(false);
			await request({ kind: "resume", runId: run.id } as Omit<Request, "id" | "createdAt">);
			expect(store.getRun(run.id)!.resumeCount).toBe(1);
			expect(tern.launches().at(-1)).toContain(`--session '${run.sessionFile}'`);
		});

		it("resumes a completed run and keeps its previous report as history", async () => {
			const run = makeRun({ status: "completed", block: 401, finish: { outcome: "completed", summary: "did it", evidence: ["x"], at: START } });
			await request({ kind: "resume", runId: run.id } as Omit<Request, "id" | "createdAt">);
			const after = store.getRun(run.id)!;
			expect(after.status).toBe("running");
			expect(after.finish).toBeUndefined();
			expect(after.finishHistory?.map((f) => f.summary)).toEqual(["did it"]);
			expect(hoja.calls.create).toBe(0);
		});

		it("resumes a run whose daemon restarted", async () => {
			const run = makeRun({ status: "completed", block: 402, tabClosedAt: START });
			// A new daemon only ever sees the persisted record.
			const restarted = ClawStore.forWorkspace(dir);
			const next = { ...deps, store: restarted };
			const summary = await handleRequest({ id: "req-restart", createdAt: clock.toISOString(), kind: "resume", runId: run.id } as Request, next) as any;
			expect(summary.id).toBe(run.id);
			expect(restarted.getRun(run.id)!.resumeCount).toBe(1);
			expect(restarted.getRun(run.id)!.status).toBe("running");
		});

		it("a resume produces a normal run event so a human sees it", async () => {
			const run = makeRun({ status: "completed", block: 403, tabClosedAt: START });
			await request({ kind: "resume", runId: run.id } as Omit<Request, "id" | "createdAt">);
			// The resume appends a `resumed` run event; the daemon turns it into the usual inbox item on its next pass.
			expect(store.readEvents(run.id, 0).items.map((e) => e.type)).toContain("resumed");
			await tick(deps);
			const resumed = inbox("run_resumed").filter((i) => i.runId === run.id);
			expect(resumed).toHaveLength(1);
			expect(resumed[0].text).toContain("resumed");
		});
	});

	describe("refusals", () => {
		it("refuses a run whose worker is alive and names claw_send instead of shadowing it", async () => {
			const run = makeRun({ status: "running", block: 410, pid: 4400 });
			livePids.add(4400);
			tern.live.add(410);
			await expect(request({ kind: "resume", runId: run.id } as Omit<Request, "id" | "createdAt">))
				.rejects.toThrow(/still running \(pid 4400\).*claw_send/);
			expect(tern.launches()).toHaveLength(0);
			expect(store.getRun(run.id)!.resumeCount).toBeUndefined();
		});

		it("refuses an active run whose worker cannot be proven gone, instead of trusting an unreadable snapshot", async () => {
			// No pid and no Tern answer: the old code read a failed snapshot as "no live blocks" and would have opened a
			// second worker on the same conversation.
			const run = makeRun({ status: "running", block: 416 });
			tern.faults.inspect = new Error("tern inspect: no answer");
			await expect(request({ kind: "resume", runId: run.id } as Omit<Request, "id" | "createdAt">))
				.rejects.toThrow(/cannot be proven gone \(the Tern snapshot is unavailable\).*claw_close/);
			expect(tern.launches()).toHaveLength(0);
			expect(store.getRun(run.id)!.resumeCount).toBeUndefined();
		});

		it("refuses a run whose session file is missing and offers a fresh relaunch", async () => {
			const run = makeRun({ status: "completed", block: 411 });
			rmSync(run.sessionFile!, { force: true });
			await expect(request({ kind: "resume", runId: run.id } as Omit<Request, "id" | "createdAt">))
				.rejects.toThrow(/session file .* is missing.*relaunch it fresh with claw_spawn/s);
			expect(tern.launches()).toHaveLength(0);
		});

		it("refuses a second resume while the first is still in flight", async () => {
			const run = makeRun({ status: "completed", block: 412, resumingAt: clock.toISOString() });
			await expect(request({ kind: "resume", runId: run.id } as Omit<Request, "id" | "createdAt">))
				.rejects.toThrow(/already in flight/);
			// A marker older than the in-flight window is stale (the daemon died mid-resume) and may be retried.
			const stale = makeRun({ status: "completed", block: 413, resumingAt: new Date(clock.getTime() - 10 * 60_000).toISOString() });
			await request({ kind: "resume", runId: stale.id } as Omit<Request, "id" | "createdAt">);
			expect(store.getRun(stale.id)!.resumeCount).toBe(1);
		});

		it("refuses a run whose Hoja issue was deleted", async () => {
			const run = makeRun({ status: "completed", block: 414 });
			hoja.issues.delete(run.hoja!.issueId);
			await expect(request({ kind: "resume", runId: run.id } as Omit<Request, "id" | "createdAt">))
				.rejects.toThrow(/no longer exists.*spawn a new run/s);
			expect(tern.launches()).toHaveLength(0);
		});

		it("stops with one recorded reason when the resume budget is spent", async () => {
			const run = makeRun({ status: "completed", block: 415 });
			tern.faults.newTab = new Error("tern new tab: no answer");
			for (let i = 0; i < RESUME_BUDGET; i++) {
				await expect(request({ kind: "resume", runId: run.id } as Omit<Request, "id" | "createdAt">)).rejects.toThrow(/could not resume/);
				advance(90_000); // past the in-flight window and the jittered backoff
			}
			const after = store.getRun(run.id)!;
			expect(after.remedies?.[RESUME_KEY]?.attempts).toBe(RESUME_BUDGET);
			expect(after.remedies?.[RESUME_KEY]?.exhausted).toBe(true);
			expect(after.status).toBe("completed"); // never left "launching" by a failed resume
			expect(after.resumeError).toMatch(/no answer/);
			expect(inbox("run_budget_spent")).toHaveLength(1);
			expect(inbox("run_budget_spent")[0].text).toContain("stopped after 3 attempt");
			// The budget is the stop: a further attempt is refused without touching Tern again.
			const attempts = tern.launches().length;
			await expect(request({ kind: "resume", runId: run.id } as Omit<Request, "id" | "createdAt">)).rejects.toThrow(/stopped after 3 attempt/);
			expect(tern.launches().length).toBe(attempts);
		});
	});

	describe("always-on goal interaction", () => {
		/** A run spawned with a derived goal, already at a state a terminal transition can act on. */
		const makeGoalRun = (over: Partial<Run> = {}, task = "## Task\n\nShip the feature.\n\n- Run the tests") => {
			const run = makeRun(over);
			run.goal = startGoal(run.id, task, clock.toISOString());
			store.saveRun(run);
			const spec = goalSpecOf(run.id, run.goal)!;
			store.writeGoalSpec(spec);
			return { run, spec };
		};
		const specs = (id: string) => readdirSync(join(dir, ".swarm", "claw", "runs")).filter((f) => f.startsWith(`${id}.goal`));

		it("a kept-open run whose goal ended stays ended: keeping the tab never re-arms or extends the goal", async () => {
			tern.live.add(500);
			const { run } = makeGoalRun({ status: "completed", block: 500, keepOpen: true });
			// The terminal state ends the goal exactly as it does for any run, and withdraws the spec.
			await reconcileRun(store.getRun(run.id)!, deps, new Set(tern.live));
			let after = store.getRun(run.id)!;
			expect(after.goal!.status).toBe("cleared");
			expect(after.goal!.endReason).toBe("terminal");
			expect(after.goal!.generations ?? 1).toBe(1);
			expect(store.readGoalSpec(run.id)).toBeUndefined();
			// Many ticks, then a daemon restart: the tab stays, the goal stays ended, and no judge call is owed.
			for (let i = 0; i < 10; i++) { await reconcileRun(store.getRun(run.id)!, deps, new Set(tern.live)); advance(5_000); }
			const restarted = ClawStore.forWorkspace(dir);
			for (let i = 0; i < 10; i++) { await reconcileRun(restarted.getRun(run.id)!, { ...deps, store: restarted }, new Set(tern.live)); advance(5_000); }
			after = restarted.getRun(run.id)!;
			expect(tern.closes(500)).toBe(0);
			expect(after.goal!.status).toBe("cleared");
			expect(after.goal!.generations ?? 1).toBe(1);
			expect(restarted.readGoalSpec(run.id)).toBeUndefined();
			expect(inbox("run_goal_ended")).toHaveLength(0);
		});

		it("a resume restores the persisted goal exactly once, as the next generation of the same goal", async () => {
			const { run, spec } = makeGoalRun({ status: "completed", block: 501, tabClosedAt: START });
			const condition = run.goal!.condition;
			expect(condition).toContain("Ship the feature");
			await reconcileRun(store.getRun(run.id)!, deps, new Set(tern.live));
			expect(store.getRun(run.id)!.goal!.status).toBe("cleared");
			expect(store.readGoalSpec(run.id)).toBeUndefined();

			await request({ kind: "resume", runId: run.id } as Omit<Request, "id" | "createdAt">);
			const resumed = store.getRun(run.id)!;
			expect(resumed.goal!.generations).toBe(2);
			expect(resumed.goal!.status).toBe("pending");
			expect(resumed.goal!.source).toBe(goalSourceFor(run.id, 2));
			expect(resumed.goal!.condition).toBe(condition);      // the same goal, not a second one
			expect(resumed.goal!.history).toEqual([expect.objectContaining({ source: spec.source, endReason: "terminal" })]);
			// Exactly one spec for the run, carrying the new generation's source.
			expect(store.readGoalSpec(run.id)).toEqual({ ...spec, source: goalSourceFor(run.id, 2) });
			expect(specs(run.id)).toHaveLength(1);

			// Later ticks never arm another generation, and never write a second spec.
			for (let i = 0; i < 10; i++) { await reconcileRun(store.getRun(run.id)!, deps, new Set(tern.live)); advance(5_000); }
			expect(store.getRun(run.id)!.goal!.generations).toBe(2);
			expect(specs(run.id)).toHaveLength(1);

			// The worker's own `established` event arms the loop in its process: one active goal, same generation.
			store.appendEvent({ eid: "evt-goal-established", type: "goal", at: clock.toISOString(), runId: run.id, goal: { state: "established", condition } });
			await tick(deps);
			expect(store.getRun(run.id)!.goal!.status).toBe("active");
			expect(store.getRun(run.id)!.goal!.generations).toBe(2);
			// A duplicate establishment (a replayed event) cannot fork the goal either.
			store.appendEvent({ eid: "evt-goal-established-dup", type: "goal", at: clock.toISOString(), runId: run.id, goal: { state: "established", condition } });
			await tick(deps);
			expect(store.getRun(run.id)!.goal!.generations).toBe(2);

			// Finish again and resume again: each resume adds exactly one generation.
			store.appendEvent({ eid: "evt-goal-finish-2", type: "finish", at: clock.toISOString(), runId: run.id, outcome: "failed", summary: "second pass" });
			await tick(deps);
			expect(store.getRun(run.id)!.status).toBe("failed");
			expect(store.getRun(run.id)!.goal!.status).toBe("cleared");
			await request({ kind: "resume", runId: run.id } as Omit<Request, "id" | "createdAt">);
			expect(store.getRun(run.id)!.goal!.generations).toBe(3);
			expect(store.readGoalSpec(run.id)!.source).toBe(goalSourceFor(run.id, 3));
			expect(store.getRun(run.id)!.goal!.history).toHaveLength(2);
		});

		it("a failed resume leaves the goal as the terminal state left it", async () => {
			const { run } = makeGoalRun({ status: "completed", block: 502, tabClosedAt: START });
			await reconcileRun(store.getRun(run.id)!, deps, new Set(tern.live));
			tern.faults.newTab = new Error("tern new tab: no answer");
			await expect(request({ kind: "resume", runId: run.id } as Omit<Request, "id" | "createdAt">)).rejects.toThrow(/could not resume/);
			const after = store.getRun(run.id)!;
			expect(after.goal!.status).toBe("cleared");
			expect(after.goal!.generations ?? 1).toBe(1);
			expect(after.goal!.history ?? []).toHaveLength(0);
			expect(store.readGoalSpec(run.id)).toBeUndefined();
		});

		it("a resume never invents a goal for a run that had none", async () => {
			const run = makeRun({ status: "completed", block: 503, tabClosedAt: START });
			run.goal = startGoal(run.id, "", clock.toISOString());
			expect(run.goal.status).toBe("unavailable");
			store.saveRun(run);
			await request({ kind: "resume", runId: run.id } as Omit<Request, "id" | "createdAt">);
			expect(store.getRun(run.id)!.goal!.status).toBe("unavailable");
			expect(store.readGoalSpec(run.id)).toBeUndefined();
		});
	});

	describe("visibility", () => {
		it("status and listing expose keepOpen and resumable, and say why a run cannot be resumed", () => {
			const kept = makeRun({ status: "completed", block: 420, keepOpen: true });
			const resumable = makeRun({ status: "failed", block: 421, failureClass: "worker" });
			const gone = makeRun({ status: "completed", block: 422 });
			rmSync(gone.sessionFile!, { force: true });
			const rows = runListing(store.listRuns(), clock.getTime(), { alive: () => false, live: new Set(tern.live) });
			const keptRow = rows.find((r) => r.id === kept.id)!;
			expect(keptRow).toMatchObject({ keepOpen: true, resumable: true });
			expect(keptRow.sessionFile).toBe(kept.sessionFile);
			expect(rows.find((r) => r.id === resumable.id)).toMatchObject({ keepOpen: false, resumable: true });
			const goneRow = rows.find((r) => r.id === gone.id)!;
			expect(goneRow.resumable).toBe(false);
			expect(goneRow.reachability).toMatch(/is missing/);
			const status = statusSummary(store);
			expect(status.keptOpen.map((r) => r.id)).toEqual([kept.id]);
			expect(status.resumable.map((r) => r.id).sort()).toEqual([kept.id, resumable.id].sort());
		});

		it("a run created with keepOpen records the choice on the run record", async () => {
			const run = await startRun({ task: "long job", project: "Hoja", cwd: dir, keepOpen: true }, deps);
			expect(store.getRun(run.id)!.keepOpen).toBe(true);
			expect(store.getRun(run.id)!.launchStartedAt).toBeDefined();
			const plain = await startRun({ task: "short job", project: "Hoja", cwd: dir }, deps);
			// Default unchanged: absent means "close on a terminal state" exactly as before.
			expect(store.getRun(plain.id)!.keepOpen).toBeUndefined();
		});
	});
});
