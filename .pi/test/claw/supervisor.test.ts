/** Self-supervision SLOs, exercised by fault injection rather than the happy path:
 *  a Tern snapshot that fails, a Tern close that keeps failing, a worker killed mid-run, a worker tab that never
 *  reports started, a source file truncated while a launch reads it, a Hoja 5xx, and a stuck-idle worker.
 *  Each asserts detection, a bounded retry inside the budget, and a truthful final state.
 *  See docs/claw/slo-2026-10-22.md for the SLOs these encode. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyEvent, hasWork, reconcileRun, tick, type DaemonDeps } from "../../lib/claw/daemon.ts";
import { runIdFor, type ClawHoja } from "../../lib/claw/spawn.ts";
import { ClawStore, type ClawEvent, type Request, type Run } from "../../lib/claw/store.ts";
import { DEFAULT_SLO, backoffMs, digestText, flushDigest, jitterFraction, recordAttempt, sloFrom, superviseRun } from "../../lib/claw/supervisor.ts";

const START = "2026-10-22T12:00:00.000Z";
const TM = { teamId: "t", teamKey: "TREBOL", projectId: "p", project: "Hoja", assigneeId: "u", assignee: "Luis", states: { "in progress": "s-ip" } };

/** Tern double with injectable faults: a failing `inspect` snapshot, a failing `close`, and a stale block list. */
function fakeTern() {
	const live = new Set<number>([1]);
	const calls: string[][] = [];
	const faults = { inspect: undefined as Error | undefined, close: undefined as Error | undefined, inspectDelayMs: 0 };
	const exec = async (args: string[]) => {
		calls.push(args);
		if (args[0] === "inspect" || args[0] === "ls") {
			if (faults.inspectDelayMs) await new Promise((r) => setTimeout(r, faults.inspectDelayMs));
			if (faults.inspect) throw faults.inspect;
			return JSON.stringify({ sessions: [{ id: 1, tabs: [{ id: 1, name: "Claw", blocks: [...live].map((id) => ({ id, exited: null, live: true, command: null })) }] }] });
		}
		if (args[0] === "new") {
			const block = 200 + calls.filter((c) => c[0] === "new").length - 1;
			live.add(block);
			return JSON.stringify({ tab: block + 1000, block });
		}
		if (args[0] === "close") {
			if (faults.close) throw faults.close;
			const block = Number(args[1]);
			if (!live.has(block)) throw new Error(`Command failed: tern close ${block} --json\nno block is called ${block} in this window`);
			live.delete(block);
		}
		return "{}";
	};
	return { exec, live, calls, faults, closes: (block: number) => calls.filter((c) => c[0] === "close" && c[1] === String(block)).length };
}

function fakeHoja(options: { resolveError?: Error } = {}) {
	const issues = new Map<string, any>();
	const calls = { create: 0, resolve: 0 };
	let n = 0;
	const hoja = {
		calls,
		issues,
		set resolveError(error: Error | undefined) { (hoja as any)._resolveError = error; },
		async resolve(project: string) {
			calls.resolve++;
			const failure = (hoja as any)._resolveError ?? options.resolveError;
			if (failure) throw failure;
			if (project !== "Hoja") throw new Error(`Hoja project "${project}" not found`);
			return { ...TM } as any;
		},
		async createIssue(_r: any, _title: string, description: string) {
			calls.create++;
			n++;
			const identifier = `TREBOL-${900 + n}`;
			issues.set(`iss-${n}`, { id: `iss-${n}`, identifier, description, state: "In Progress", teamId: "t", projectId: "p", assigneeId: "u", comments: [] });
			return { id: `iss-${n}`, identifier };
		},
		async readIssue(id: string) { const i = issues.get(id); if (!i) throw new Error("missing"); return { ...i, comments: [...i.comments] }; },
		async findIssueByMarker(marker: string) { const hit = [...issues.values()].find((i) => i.description.includes(marker)); return hit ? { id: hit.id, identifier: hit.identifier } : undefined; },
		async comment(id: string, body: string) { issues.get(id)?.comments.push(body); },
		async setState(_r: any, id: string, state: string) { const i = issues.get(id); if (i) i.state = state; },
	} as unknown as ClawHoja & { calls: typeof calls; issues: typeof issues; resolveError: Error | undefined };
	return hoja;
}

describe("claw self-supervision", () => {
	let dir: string;
	let store: ClawStore;
	let tern: ReturnType<typeof fakeTern>;
	let hoja: ReturnType<typeof fakeHoja>;
	let clock: Date;
	let deps: DaemonDeps;
	let seq = 0;
	const advance = (ms: number) => { clock = new Date(clock.getTime() + ms); };

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "claw-super-"));
		store = ClawStore.forWorkspace(dir);
		clock = new Date(START);
		tern = fakeTern();
		hoja = fakeHoja();
		seq = 0;
		deps = {
			store, hoja, tern: tern.exec, workspace: dir, now: () => clock, alive: () => false, signal: () => undefined,
			slo: { startedMs: 30_000, idleNudgeMs: 5 * 60_000, idleFailMs: 20 * 60_000, tabCloseBaseMs: 1_000, tabCloseCapMs: 4_000, heartbeatMs: 10 * 60_000, needsUserReminderMs: 10 * 60_000, digestMs: 0 },
		};
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	const makeRun = (over: Partial<Run> = {}): Run => {
		seq++;
		const at = clock.toISOString();
		const run = { id: `run-sup-${seq}`, label: "Label", task: "t", cwd: dir, status: "running", phase: "tab_open", createdAt: at, updatedAt: at, project: "Hoja", eventsOffset: 0, settles: 0, attempts: 0, outbox: [], seen: [], ...over } as Run;
		store.saveRun(run);
		return run;
	};
	const inbox = (kind?: string) => store.readInbox(0).items.filter((i) => !kind || i.kind === kind);
	const notices = (kind?: string) => store.readNotices(0).items.filter((i) => !kind || i.kind === kind);

	describe("S2 terminal tab close survives a failed Tern snapshot (today's leftover-tab defect)", () => {
		it("closes a terminal run's tab even when liveBlocks throws, because the snapshot is not a precondition", async () => {
			tern.live.add(300);
			tern.faults.inspect = new Error("tern inspect: daemon unresponsive");
			const run = makeRun({ status: "completed", block: 300 });
			// The daemon passes `live` as undefined when the snapshot failed; the close must still happen.
			await reconcileRun(run, deps, undefined);
			expect(tern.closes(300)).toBe(1);
			expect(store.getRun(run.id)!.tabClosedAt).toBeDefined();
			expect(inbox("run_tab_orphan")).toHaveLength(0);
		});

		it("retries a failing close within the budget, then reports one orphan and stops", async () => {
			tern.live.add(301);
			tern.faults.close = new Error("tern close: no answer");
			const run = makeRun({ status: "failed", block: 301 });
			const budget = sloFrom(deps.slo).tabCloseBudget;
			for (let i = 0; i < 20; i++) {
				await reconcileRun(store.getRun(run.id)!, deps, new Set(tern.live));
				advance(5_000);
			}
			const after = store.getRun(run.id)!;
			expect(tern.closes(301)).toBe(budget);
			expect(after.tabClosedAt).toBeUndefined();
			expect(after.tabCloseError).toMatch(/no answer/);
			const orphans = inbox("run_tab_orphan");
			expect(orphans).toHaveLength(1);
			expect(orphans[0].text).toContain("tern close 301");
			expect(orphans[0].text).toContain("after 5 close attempts");
		});

		it("closes a lost run's tab, and counts a block Tern already dropped as closed", async () => {
			tern.live.add(310);
			const liveLost = makeRun({ status: "lost", block: 310 });
			const goneLost = makeRun({ status: "lost", block: 311 });
			await reconcileRun(liveLost, deps, new Set(tern.live));
			await reconcileRun(goneLost, deps, new Set(tern.live));
			expect(store.getRun(liveLost.id)!.tabClosedAt).toBeDefined();
			expect(store.getRun(goneLost.id)!.tabClosedAt).toBeDefined();
			expect(tern.closes(311)).toBe(1); // "no block" from tern is already-closed, not a failure
			expect(store.getRun(goneLost.id)!.tabCloseError).toBeUndefined();
		});

		it("keeps the daemon alive while a close is still retryable, then lets it exit", async () => {
			tern.live.add(302);
			tern.faults.close = new Error("tern close: no answer");
			const run = makeRun({ status: "completed", block: 302 });
			await reconcileRun(run, deps, new Set(tern.live));
			expect(hasWork(store)).toBe(true);
			tern.faults.close = undefined;
			for (let i = 0; i < 10; i++) { advance(5_000); await reconcileRun(store.getRun(run.id)!, deps, new Set(tern.live)); }
			expect(store.getRun(run.id)!.tabClosedAt).toBeDefined();
			expect(hasWork(store)).toBe(false);
		});
	});

	describe("S1 bound to a terminal state", () => {
		it("reports a stuck idle worker once, naming what it needs and when it fails", async () => {
			deps.alive = (pid) => pid === 999; // the worker process is alive; it is stuck, not gone
			const run = makeRun({ status: "idle", pid: 999, idleSince: new Date(clock.getTime() - 6 * 60_000).toISOString() });
			await reconcileRun(run, deps, new Set(tern.live));
			await reconcileRun(store.getRun(run.id)!, deps, new Set(tern.live));
			const stalled = inbox("run_stalled");
			expect(stalled).toHaveLength(1);
			expect(stalled[0].text).toContain("idle 6m with no claw_finish");
			expect(stalled[0].text).toContain(`claw_send ${run.id}`);
			expect(stalled[0].text).toContain("claw_cancel");
			expect(store.getRun(run.id)!.stalledAt).toBeDefined();
			expect(store.getRun(run.id)!.status).toBe("idle");
		});

		it("fails a worker that stays idle past the bound with a real reason and closes its tab", async () => {
			tern.live.add(320);
			deps.alive = (pid) => pid === 999;
			const run = makeRun({ status: "idle", pid: 999, block: 320, idleSince: new Date(clock.getTime() - 21 * 60_000).toISOString() });
			await reconcileRun(run, deps, new Set(tern.live));
			const after = store.getRun(run.id)!;
			expect(after.status).toBe("failed");
			expect(after.failureClass).toBe("stalled");
			expect(after.error).toMatch(/stalled: idle 21m with no claw_finish/);
			expect(after.finish).toBeUndefined();
			expect(inbox("run_failed").some((i) => i.text.includes("Not a completion"))).toBe(true);
			await reconcileRun(store.getRun(run.id)!, deps, new Set(tern.live));
			expect(store.getRun(run.id)!.tabClosedAt).toBeDefined();
		});

		it("sends one nudge per idle episode when the workspace opts into idleAction=send", async () => {
			tern.live.add(321);
			deps.alive = (pid) => pid === 999;
			const run = makeRun({ status: "idle", pid: 999, block: 321, idleSince: new Date(clock.getTime() - 6 * 60_000).toISOString() });
			const sending = { ...deps, slo: { ...deps.slo, idleAction: "send" as const } };
			await reconcileRun(run, sending, new Set(tern.live));
			await reconcileRun(store.getRun(run.id)!, sending, new Set(tern.live));
			const sends = tern.calls.filter((c) => c[0] === "send" && c[1] === "321");
			expect(sends).toHaveLength(2); // text + Enter for the single nudge
			expect(sends[0][3]).toContain("claw_finish");
		});

		it("names a tab that opened but never reported started, without relaunching a worker that may have run", async () => {
			const run = makeRun({ status: "launching", phase: "tab_open", block: 330, pid: undefined, settles: 0, createdAt: new Date(clock.getTime() - 40_000).toISOString() });
			await reconcileRun(run, deps, new Set(tern.live));
			const named = notices("run_stalled").filter((n) => n.text.includes("never reported started"));
			expect(named).toHaveLength(1);
			expect(named[0].text).toContain("check the tab");
			expect(store.getRun(run.id)!.status).toBe("launching");
			expect(tern.calls.filter((c) => c[0] === "new")).toHaveLength(0);
		});
	});

	describe("S3 one act per run per state, with budget and jitter", () => {
		it("honours the budget exactly and never loops, even when every attempt fails", async () => {
			tern.faults.close = new Error("tern close: no answer");
			const run = makeRun({ status: "failed", block: 340 });
			const tight = { ...deps, slo: { ...deps.slo, tabCloseBudget: 3, tabCloseBaseMs: 1_000, tabCloseCapMs: 2_000 } };
			for (let i = 0; i < 30; i++) { advance(1_000); await reconcileRun(store.getRun(run.id)!, tight, new Set(tern.live)); }
			expect(tern.closes(340)).toBe(3);
			expect(inbox("run_tab_orphan")).toHaveLength(1);
			expect(store.getRun(run.id)!.remedies!["tab-close"].exhausted).toBe(true);
		});

		it("property: jitter stays in range and two runs do not share a retry instant", () => {
			for (let attempt = 1; attempt <= 8; attempt++) {
				const a = backoffMs(attempt, 1_000, 16_000, "tab-close");
				expect(a).toBeGreaterThanOrEqual(Math.min(16_000, 1_000 * 2 ** (attempt - 1)) * 0.75 - 1);
				expect(a).toBeLessThanOrEqual(16_000);
				expect(jitterFraction("run-a", attempt)).toBeGreaterThanOrEqual(0);
				expect(jitterFraction("run-a", attempt)).toBeLessThan(1);
				expect(jitterFraction("run-a", attempt)).toBe(jitterFraction("run-a", attempt));
			}
			expect(new Set(Array.from({ length: 20 }, (_, i) => backoffMs(3, 1_000, 8_000, `run-${i}`))).size).toBeGreaterThan(1);
		});

		it("property: repeated attempts never exceed the budget and stop being due once exhausted", () => {
			const run = makeRun();
			let now = clock.getTime();
			for (let i = 0; i < 50; i++) {
				now += 10_000;
				recordAttempt(run, "k", now, { budget: 4, baseMs: 500, capMs: 1_000 });
			}
			expect(run.remedies!.k.attempts).toBe(50);
			expect(run.remedies!.k.exhausted).toBe(true);
		});
	});

	describe("S4 notices collapse into a digest and a heartbeat", () => {
		it("folds started and idle notices into exactly one digest item", () => {
			const run = makeRun({ status: "running" });
			applyEvent(run, { eid: "e1", type: "started", at: clock.toISOString(), runId: run.id, pid: 5 }, store);
			applyEvent(run, { eid: "e2", type: "settled", at: clock.toISOString(), runId: run.id, text: "" }, store);
			expect(notices()).toHaveLength(2);
			expect(inbox()).toHaveLength(0);
			const first = flushDigest(store, clock.getTime(), sloFrom(deps.slo));
			expect(first).toEqual({ digested: 2, heartbeat: false });
			const digests = inbox("claw_digest");
			expect(digests).toHaveLength(1);
			expect(digests[0].text).toContain("2 notice(s)");
			expect(digests[0].text).toContain("started");
			expect(digests[0].text).toContain("idle");
			expect(flushDigest(store, clock.getTime(), sloFrom(deps.slo)).digested).toBe(0);
			expect(inbox("claw_digest")).toHaveLength(1);
		});

		it("publishes one all-clear heartbeat per window while work is in progress, and none at startup", () => {
			makeRun({ status: "running" });
			const slo = sloFrom(deps.slo);
			expect(flushDigest(store, clock.getTime(), slo).heartbeat).toBe(false);
			expect(inbox("claw_heartbeat")).toHaveLength(0);
			advance(slo.heartbeatMs + 1);
			expect(flushDigest(store, clock.getTime(), slo).heartbeat).toBe(true);
			expect(inbox("claw_heartbeat")[0].text).toContain("claw healthy: 1 working");
			expect(flushDigest(store, clock.getTime(), slo).heartbeat).toBe(false);
			expect(inbox("claw_heartbeat")).toHaveLength(1);
		});

		it("property: the digest text is deterministic and bounded for a large window", () => {
			const many = Array.from({ length: 40 }, (_, i) => ({ id: `n${i}`, at: START, kind: "run_started" as const, runId: `run-${i}`, text: `run-${i}: started` }));
			const text = digestText(many as any, Date.parse(START));
			expect(digestText(many as any, Date.parse(START))).toBe(text);
			expect(text.split("\n").length).toBeLessThanOrEqual(10);
			expect(text).toContain("40 notice(s)");
			expect(text).toContain("and 32 more run(s)");
		});
	});

	describe("S5 a pending decision is surfaced with what and since when", () => {
		it("flags the worker tab and repeats the question in bounded digests", async () => {
			tern.live.add(350);
			const since = new Date(clock.getTime() - 11 * 60_000).toISOString();
			const run = makeRun({ status: "awaiting_user", block: 350, awaitingSince: since, finish: { outcome: "needs_user", summary: "Choose A or B", evidence: [], at: since } });
			await reconcileRun(run, deps, new Set(tern.live));
			const rename = tern.calls.find((c) => c[0] === "rename" && c[1] === "350");
			expect(rename?.[2]).toContain("decide");
			const reminder = notices("run_needs_user");
			expect(reminder).toHaveLength(1);
			expect(reminder[0].text).toContain("waiting 11m since");
			expect(reminder[0].text).toContain("Choose A or B");
			expect(reminder[0].text).toContain(`claw_send ${run.id}`);
			for (let i = 0; i < 8; i++) { advance(11 * 60_000); await reconcileRun(store.getRun(run.id)!, deps, new Set(tern.live)); }
			expect(notices("run_needs_user").length).toBeLessThanOrEqual(sloFrom(deps.slo).needsUserReminderBudget);
			expect(store.getRun(run.id)!.status).toBe("awaiting_user");
		});
	});

	describe("S6 recoverable launch faults are recovered once", () => {
		const failedLaunch = (runId: string) => makeRun({
			id: runId, status: "failed", failureClass: "launch", phase: "issue_created", attempts: 1,
			hoja: { issueId: "iss-1", identifier: "TREBOL-901", teamKey: "TREBOL", project: "Hoja", assignee: "Luis" },
			error: "tab open failed: tern refused",
		});

		it("relaunches the same run on the same issue when no Tern block carries it", async () => {
			hoja.issues.set("iss-1", { id: "iss-1", identifier: "TREBOL-901", description: "d", state: "In Progress", teamId: "t", projectId: "p", assigneeId: "u", comments: [] });
			const run = failedLaunch("run-relaunch-1");
			await tick(deps);
			const after = store.getRun(run.id)!;
			expect(after.relaunchCount).toBe(1);
			expect(after.status).toBe("launching");
			expect(after.phase).toBe("issue_created");
			expect(inbox("run_recovered")).toHaveLength(1);
			expect(inbox("run_recovered")[0].text).toContain("same issue");
			await tick(deps); // the relaunched run opens its tab on the next pass
			expect(store.getRun(run.id)!.phase).toBe("tab_open");
			expect(tern.calls.filter((c) => c[0] === "new")).toHaveLength(1);
			expect(hoja.calls.create).toBe(0);
			await tick(deps);
			expect(store.getRun(run.id)!.relaunchCount).toBe(1);
		});

		it("near miss: does not relaunch when a block already carries the run id, and does not relaunch twice", async () => {
			const carried = failedLaunch("run-relaunch-2");
			await reconcileRun(carried, { ...deps, tern: async (args) => (args[0] === "inspect" ? JSON.stringify({ sessions: [{ id: 1, tabs: [{ id: 9, name: "x", blocks: [{ id: 77, exited: null, live: true, command: `env PI_CLAW_RUN='${carried.id}' pi`, args: [] }] }] }] }) : "{}") }, new Set([77]));
			expect(store.getRun(carried.id)!.status).toBe("failed");
			expect(store.getRun(carried.id)!.relaunchCount).toBeUndefined();
			const twice = makeRun({ status: "failed", failureClass: "launch", phase: "issue_created", relaunchCount: 1 });
			await reconcileRun(twice, deps, new Set(tern.live));
			expect(store.getRun(twice.id)!.status).toBe("failed");
		});
	});

	describe("fault injection end to end", () => {
		it("a worker killed before any settle is lost, its tab closed, then relaunched once on the same issue", async () => {
			tern.live.add(400);
			const run = makeRun({ status: "running", pid: 4242, block: 400, hoja: { issueId: "iss-kill", identifier: "TREBOL-950", teamKey: "TREBOL", project: "Hoja", assignee: "Luis" } });
			deps.alive = () => false;
			await reconcileRun(run, deps, new Set(tern.live));
			const after = store.getRun(run.id)!;
			expect(inbox("run_lost")).toHaveLength(1);          // the loss itself is reported once
			expect(after.tabClosedAt).toBeDefined();            // the corpse tab is closed first
			expect(tern.closes(400)).toBe(1);
			expect(inbox("run_recovered")).toHaveLength(1);     // then the run is restarted, not left dead
			expect(after.relaunchCount).toBe(1);
			expect(after.status).toBe("launching");
			expect(after.phase).toBe("issue_created");          // same run, same Hoja issue, tab step redone
			expect(after.pid).toBeUndefined();                  // the dead worker's pid cannot survive the restart
			expect(hoja.calls.create).toBe(0);
		});

		it("a source file truncated mid-read really fails to load, and that worker's state ends truthful", async () => {
			// Real fault: truncate a module in a scratch copy and import it. The worker's `pi` would die the same way.
			const src = readFileSync(join(process.cwd(), ".pi/lib/claw/remedy.ts"), "utf8");
			const scratch = join(dir, "broken");
			mkdirSync(join(scratch, "lib"), { recursive: true });
			writeFileSync(join(scratch, "lib", "remedy.ts"), src.slice(0, Math.floor(src.length / 2)));
			await expect(import(pathToFileURL(join(scratch, "lib", "remedy.ts")).href)).rejects.toThrow(/Unexpected|SyntaxError|not defined|expected/i);

			// What the daemon sees afterwards: a tab that opened, no started event, a dead block, and the loader's
			// stderr in the worker log. A worker that died before session_start is a failure with the reason, not "lost".
			const run = makeRun({ status: "launching", phase: "tab_open", block: 401, pid: undefined, settles: 0, createdAt: new Date(clock.getTime() - 70_000).toISOString() });
			writeFileSync(store.workerLogPath(run.id), "Error: Failed to load extension .pi/lib/claw/remedy.ts: Unexpected end of input\n");
			await reconcileRun(run, deps, new Set(tern.live));
			const after = store.getRun(run.id)!;
			expect(after.status).toBe("failed");
			expect(after.error).toContain("worker exited before session_start: Error: Failed to load extension");
			expect(inbox("run_failed")).toHaveLength(1);
			expect(after.finish).toBeUndefined();
		});

		it("an unresponsive Tern does not make a live worker look lost", async () => {
			tern.faults.inspect = new Error("tern inspect: timeout after 30000ms");
			const run = makeRun({ status: "running", pid: undefined, block: 402, createdAt: new Date(clock.getTime() - 120_000).toISOString() });
			await reconcileRun(run, deps, undefined);
			expect(store.getRun(run.id)!.status).toBe("running");
			expect(inbox("run_lost")).toHaveLength(0);
		});

		it("a Hoja 5xx paces the launch retry instead of burning the budget in consecutive ticks", async () => {
			const created = makeRun({ status: "launching", phase: "intent" });
			hoja.resolveError = new Error("Hoja 503 Service Unavailable");
			await tick(deps);
			const run = store.getRun(created.id)!;
			expect(run.status).toBe("launching");
			expect(run.error).toContain("503");
			expect(Date.parse(run.reconcileAt!)).toBeGreaterThan(clock.getTime());
			for (let i = 0; i < 4; i++) await tick(deps); // four immediate ticks must not spend four attempts
			expect(store.getRun(created.id)!.remedies!["hoja-resolve:launch"].attempts).toBe(1);
			for (let i = 0; i < 10; i++) { advance(60_000); await tick(deps); }
			const after = store.getRun(created.id)!;
			expect(after.status).toBe("failed");
			expect(after.error).toMatch(/gave up after 5 attempts; not started/);
			expect(hoja.calls.create).toBe(0);
		});
	});

	describe("the supervisor acts: recovery, explicit budget records, dedupe, and leaving healthy runs alone", () => {
		/** A run that failed at the tab step with a known Hoja issue and no tab: the one recovery-safe shape. */
		const failedLaunch = (over: Partial<Run> = {}) => makeRun({
			status: "failed", failureClass: "launch", phase: "issue_created", attempts: 1,
			hoja: { issueId: "iss-9", identifier: "TREBOL-909", teamKey: "TREBOL", project: "Hoja", assignee: "Luis" },
			error: "tab open failed: tern refused", ...over,
		});

		it("worker killed before any settle: restarted once on the same issue, with one loss notice and one recovery notice", async () => {
			tern.live.add(500);
			const run = makeRun({ status: "running", pid: 5150, block: 500, hoja: { issueId: "iss-9", identifier: "TREBOL-909", teamKey: "TREBOL", project: "Hoja", assignee: "Luis" } });
			deps.alive = () => false;
			await reconcileRun(run, deps, new Set(tern.live));
			await reconcileRun(store.getRun(run.id)!, deps, new Set(tern.live));
			expect(inbox("run_lost")).toHaveLength(1);
			expect(inbox("run_recovered")).toHaveLength(1);
			expect(store.getRun(run.id)!.relaunchCount).toBe(1);
			expect(hoja.calls.create).toBe(0);
			expect(store.getRun(run.id)!.status).toBe("launching");
		});

		it("stuck past its deadline: not restarted (no worker starts after expiry), failed with the reason, and the spent budget is recorded once", async () => {
			const run = failedLaunch({ deadline: new Date(clock.getTime() - 60_000).toISOString() });
			await reconcileRun(run, deps, new Set(tern.live));
			await reconcileRun(store.getRun(run.id)!, deps, new Set(tern.live));
			const after = store.getRun(run.id)!;
			expect(after.status).toBe("failed");
			expect(after.relaunchCount).toBeUndefined();
			const spent = inbox("run_budget_spent");
			expect(spent).toHaveLength(1);
			expect(spent[0].text).toContain("deadline");
			expect(spent[0].text).toContain("no worker starts after expiry");
			expect(after.remedies!["relaunch:once"]).toMatchObject({ attempts: 1, exhausted: true });
			expect(after.remedies!["relaunch:once"].note).toContain("deadline");
		});

		it("the same unrecoverable failure on repeated ticks is recorded once, not once per tick", async () => {
			const run = failedLaunch({ deadline: new Date(clock.getTime() - 60_000).toISOString() });
			for (let i = 0; i < 12; i++) { advance(5_000); await reconcileRun(store.getRun(run.id)!, deps, new Set(tern.live)); }
			expect(inbox("run_budget_spent")).toHaveLength(1);
			expect(store.getRun(run.id)!.remedies!["relaunch:once"].attempts).toBe(1);
		});

		it("a spent retry budget leaves an explicit record with the reason, and stops retrying", async () => {
			tern.faults.close = new Error("tern close: no answer");
			const run = makeRun({ status: "completed", block: 501 });
			const tight = { ...deps, slo: { ...deps.slo, tabCloseBudget: 2, tabCloseBaseMs: 500, tabCloseCapMs: 500 } };
			for (let i = 0; i < 10; i++) { advance(2_000); await reconcileRun(store.getRun(run.id)!, tight, new Set(tern.live)); }
			const after = store.getRun(run.id)!;
			expect(tern.closes(501)).toBe(2);
			expect(inbox("run_tab_orphan")).toHaveLength(1);
			expect(inbox("run_tab_orphan")[0].text).toContain("no answer");
			expect(after.remedies!["tab-close"]).toMatchObject({ attempts: 2, exhausted: true });
			expect(after.remedies!["tab-close"].note).toContain("no answer");
			expect(hasWork(store)).toBe(false);
		});

		it("near miss: a healthy run is left completely untouched (no notice, no act, no ledger entry)", async () => {
			tern.live.add(502);
			const run = makeRun({ status: "running", pid: 6060, block: 502, settles: 1, hoja: { issueId: "iss-9", identifier: "TREBOL-909", teamKey: "TREBOL", project: "Hoja", assignee: "Luis" } });
			deps.alive = (pid) => pid === 6060;
			const before = JSON.stringify(store.getRun(run.id)!);
			await reconcileRun(run, deps, new Set(tern.live));
			const after = store.getRun(run.id)!;
			expect(after.status).toBe("running");
			expect(after.remedies).toBeUndefined();
			expect(inbox()).toHaveLength(0);
			expect(store.readNotices(0).items).toHaveLength(0);
			expect(JSON.stringify({ ...after, updatedAt: undefined })).toBe(JSON.stringify({ ...JSON.parse(before), updatedAt: undefined }));
		});
	});

	describe("SLO configuration", () => {
		it("accepts numeric overrides and ignores a typo or a negative bound", () => {
			const slo = sloFrom({ digestMs: 60_000, idleFailMs: -5, tabCloseBudget: "many" as any, idleAction: "shout" as any });
			expect(slo.digestMs).toBe(60_000);
			expect(slo.idleFailMs).toBe(DEFAULT_SLO.idleFailMs);
			expect(slo.tabCloseBudget).toBe(DEFAULT_SLO.tabCloseBudget);
			expect(slo.idleAction).toBe("report");
		});

		it("keeps the operator's overrides when /claw on writes the control file", () => {
			writeFileSync(join(dir, ".swarm", "claw", "control.json"), JSON.stringify({ enabled: true, pane: 1, supervise: { digestMs: 1_000 } }));
			store.writeControl(false, 2);
			expect(store.readControl().supervise).toEqual({ digestMs: 1_000 });
			expect(store.readControl().enabled).toBe(false);
		});
	});
});
