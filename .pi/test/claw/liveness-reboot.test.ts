/** TREBOL-388: after a host reboot, `claw_list` reported every run resumable and `claw_resume` refused each one as
 *  "still running (pid N)". Liveness was decided by PID existence, so a worker that died in the reboot could look
 *  alive (a reused number, or a Tern block the restart restored), and the two tools used different facts.
 *
 *  These tests pin the contract the issue asks for:
 *   - identity decides: the kernel start token, the argv and the host boot instant, never the number alone;
 *   - one verdict: the row `claw_list` shows and the accept/refuse decision of `claw_resume` cannot disagree;
 *   - a reboot is a resume, not a relaunch: daemon/host downtime never spends the automatic relaunch budget;
 *   - the near miss stays refused: a genuinely live worker with matching identity is never shadowed. */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claimLock, handleRequest, heartbeat, reconcileRun, type DaemonDeps } from "../../lib/claw/daemon.ts";
import { runListing } from "../../lib/claw/orchestrator.ts";
import { bootedAtMs, pidAlive, readProcessIdentity, type ProcessIdentity } from "../../lib/claw/process.ts";
import { resumeRefusal, runLiveness } from "../../lib/claw/resume.ts";
import { recoveryReason } from "../../lib/claw/supervisor.ts";
import { ClawStore, readJson, type DaemonLock, type Request, type Run } from "../../lib/claw/store.ts";

/** Runs in these tests launch after the boot unless a test says otherwise; the incident's runs launched before it. */
const START = "2026-11-03T10:00:00.000Z";
const BOOT = Date.parse("2026-11-03T09:17:18.000Z");
const PRE_BOOT = "2026-11-03T08:00:00.000Z";
const TEAM = { teamId: "t", teamKey: "TREBOL", projectId: "p", project: "Hoja", assigneeId: "u", assignee: "Luis", states: { "in progress": "s-ip", "in review": "s-ir" } };

function fakeTern() {
	const live = new Set<number>([1]);
	const launches: string[] = [];
	const exec = async (args: string[]) => {
		if (args[0] === "inspect") return JSON.stringify({ sessions: [{ id: 1, tabs: [{ id: 1, name: "Claw", blocks: [...live].map((id) => ({ id, exited: null, live: true })) }] }] });
		if (args[0] === "new") {
			const block = 900 + launches.length;
			launches.push(args[args.length - 1]);
			live.add(block);
			return JSON.stringify({ tab: block + 100, block });
		}
		if (args[0] === "close") { live.delete(Number(args[1])); return "{}"; }
		return "{}";
	};
	return { exec, live, launches, launched: () => launches };
}

function fakeHoja() {
	const issues = new Map<string, any>();
	const calls = { create: 0, read: 0 };
	const hoja = {
		calls, issues,
		async resolve() { return { ...TEAM } as any; },
		async createIssue(_r: any, _t: string, description: string) {
			calls.create++;
			const id = `iss-${issues.size + 1}`;
			issues.set(id, { id, identifier: `TREBOL-${900 + issues.size}`, description, state: "In Progress", teamId: "t", projectId: "p", assigneeId: "u", comments: [] });
			return { id, identifier: `TREBOL-${900 + issues.size}` };
		},
		async readIssue(id: string) { calls.read++; const i = issues.get(id); if (!i) throw new Error(`Hoja issue ${id} not found on read-back`); return { ...i, comments: [...i.comments] }; },
		async comment(id: string, body: string) { issues.get(id)?.comments.push(body); },
		async setState() { /* no state change in these tests */ },
	} as any;
	return hoja;
}

describe("claw liveness after a host reboot (TREBOL-388)", () => {
	let dir: string;
	let store: ClawStore;
	let tern: ReturnType<typeof fakeTern>;
	let hoja: ReturnType<typeof fakeHoja>;
	let clock: Date;
	let livePids: Set<number>;
	let identities: Map<number, ProcessIdentity>;
	let deps: DaemonDeps;
	let seq = 0;
	const advance = (ms: number) => { clock = new Date(clock.getTime() + ms); };

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "claw-liveness-"));
		store = ClawStore.forWorkspace(dir);
		clock = new Date(Date.parse(START));
		tern = fakeTern();
		hoja = fakeHoja();
		livePids = new Set<number>();
		identities = new Map<number, ProcessIdentity>();
		seq = 0;
		deps = {
			store, hoja, tern: tern.exec, workspace: dir, now: () => clock,
			alive: (pid) => livePids.has(pid), signal: () => undefined,
			identity: (pid) => identities.get(pid),
			bootedAt: BOOT,
			preflight: async () => ({ ok: true }),
			planLaunch: () => ({ mode: "discovery" as const }),
			slo: { startedMs: 30_000, tabCloseBaseMs: 1_000, tabCloseCapMs: 4_000, digestMs: 0 },
		} as DaemonDeps;
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	const makeRun = (over: Partial<Run> = {}): Run => {
		seq++;
		const at = clock.toISOString();
		const issueId = `iss-live-${seq}`;
		hoja.issues.set(issueId, { id: issueId, identifier: `TREBOL-8${seq}0`, description: `<!-- claw-run:run-live-${seq} -->`, state: "In Progress", teamId: "t", projectId: "p", assigneeId: "u", comments: [] });
		const sessionFile = join(dir, `session-${seq}.jsonl`);
		writeFileSync(sessionFile, `${JSON.stringify({ type: "session", id: `sess-${seq}`, cwd: dir })}\n`);
		const run = {
			id: `run-live-${seq}`, label: "Label", task: "Do the thing", cwd: dir, status: "running", phase: "tab_open",
			createdAt: at, updatedAt: at, project: "Hoja", eventsOffset: 0, settles: 1, attempts: 0, outbox: [], seen: [],
			hoja: { issueId, identifier: `TREBOL-8${seq}0`, teamKey: "TREBOL", project: "Hoja", assignee: "Luis" },
			sessionFile, launchStartedAt: at, ...over,
		} as Run;
		store.saveRun(run);
		return run;
	};
	/** A run whose worker reported started and whose identity was recorded, as a real daemon now stores it. */
	const withWorker = (run: Run, pid: number, start: string, seenAt = run.launchStartedAt!): Run => {
		run.pid = pid;
		run.worker = { pid, start, commandHash: "worker-argv", seenAt };
		store.saveRun(run);
		return run;
	};
	const facts = (over: Partial<Parameters<typeof runLiveness>[1]> = {}) => ({
		alive: deps.alive, identity: deps.identity, bootedAt: deps.bootedAt, live: undefined as Set<number> | undefined,
		nowMs: clock.getTime(), ...over,
	});
	const request = (body: Omit<Request, "id" | "createdAt">) => handleRequest({ id: `req-${++seq}`, createdAt: clock.toISOString(), ...body } as Request, deps);

	describe("identity, not PID existence", () => {
		it("a reused pid on the same boot is not this run's worker", () => {
			const run = withWorker(makeRun(), 2915896, "kernel-start:1000");
			livePids.add(2915896);                                    // the number exists again
			identities.set(2915896, { start: "kernel-start:9000", command: "node vite" });
			const verdict = runLiveness(run, facts());
			expect(verdict.state).toBe("dead");
			expect(verdict.why).toContain("reused");
		});

		it("same start token but a different command is a different process", () => {
			const run = withWorker(makeRun(), 4242, "kernel-start:1000");
			livePids.add(4242);
			identities.set(4242, { start: "kernel-start:1000", command: "node vite", commandHash: "other-argv" });
			expect(runLiveness(run, facts()).state).toBe("dead");
		});

		it("a worker that reported before this host booted is provably gone, whatever its pid is doing now", () => {
			// No identity on the record at all: this is what a run stored before identity existed looks like.
			const run = makeRun({ pid: 2915630, launchStartedAt: PRE_BOOT });
			livePids.add(2915630);
			identities.set(2915630, { start: "kernel-start:12", command: "postgres" });
			const verdict = runLiveness(run, facts());
			expect(verdict.state).toBe("dead");
			expect(verdict.why).toContain("host rebooted");
		});

		it("the near miss stays refused: a live worker with matching identity is alive", () => {
			const run = withWorker(makeRun(), 4400, "kernel-start:555");
			livePids.add(4400);
			identities.set(4400, { start: "kernel-start:555", command: "pi --name Label", commandHash: "worker-argv" });
			expect(runLiveness(run, facts()).state).toBe("alive");
		});

		it("a live pid with unreadable identity is unknown, never dead", () => {
			const run = withWorker(makeRun(), 4401, "kernel-start:556");
			livePids.add(4401);
			expect(runLiveness(run, facts()).state).toBe("unknown");
		});

		it("a run with no pid is judged by its tab only, and a missing snapshot is unknown instead of dead", () => {
			const run = makeRun({ status: "launching", pid: undefined, block: 410 });
			expect(runLiveness(run, facts({ live: new Set([410]) })).state).toBe("alive");
			expect(runLiveness(run, facts({ live: new Set() })).state).toBe("dead");
			expect(runLiveness(run, facts({ live: undefined })).state).toBe("unknown");
		});
	});

	describe("claw_list and claw_resume use one verdict", () => {
		const cases = () => [
			{ name: "alive worker", run: withWorker(makeRun(), 4400, "kernel-start:555"), pid: 4400, identity: { start: "kernel-start:555", commandHash: "worker-argv" } as ProcessIdentity, expected: false },
			{ name: "reused pid", run: withWorker(makeRun(), 2915896, "kernel-start:1000"), pid: 2915896, identity: { start: "kernel-start:9000" } as ProcessIdentity, expected: true },
			{ name: "dead pid", run: withWorker(makeRun(), 4300, "kernel-start:1000"), pid: undefined, identity: undefined, expected: true },
		];

		it("a row's resumable flag equals the resume decision for the same run", () => {
			for (const item of cases()) {
				livePids.clear();
				identities.clear();
				if (item.pid !== undefined) livePids.add(item.pid);
				if (item.pid !== undefined && item.identity) identities.set(item.pid, item.identity);
				const row = runListing([item.run], clock.getTime(), { alive: deps.alive, identity: deps.identity, bootedAt: deps.bootedAt })[0];
				const refusal = resumeRefusal(store.getRun(item.run.id)!, { ...facts(), sessionExists: () => true });
				expect({ name: item.name, resumable: row.resumable }).toEqual({ name: item.name, resumable: item.expected });
				expect({ name: item.name, resumable: refusal === undefined }).toEqual({ name: item.name, resumable: item.expected });
			}
		});

		it("the reported fault: a dead pid with a block the reboot restored is resumable, and the refusal names no pid", async () => {
			const run = withWorker(makeRun({ block: 410 }), 2915896, "kernel-start:1000");
			tern.live.add(410);                                       // a restored tab, no pi inside it
			expect(resumeRefusal(run, { ...facts({ live: new Set(tern.live) }), sessionExists: () => true })).toBeUndefined();
			const resumed = await request({ kind: "resume", runId: run.id });
			expect((resumed as any).resumeCount).toBe(1);
			expect(tern.launched().at(-1)).toContain(`--session '${run.sessionFile}'`);
			expect(store.readInbox(0).items.map((i) => i.kind)).not.toContain("run_budget_spent");
		});

		it("after a reboot, claw_resume relaunches the run on its recorded session instead of refusing it", async () => {
			const run = withWorker(makeRun({ launchStartedAt: PRE_BOOT }), 2915630, "kernel-start:1000", PRE_BOOT);
			livePids.add(2915630);                                    // reused after the reboot
			identities.set(2915630, { start: "kernel-start:12", command: "sshd: unrelated" });
			expect(runListing([run], clock.getTime(), { alive: deps.alive, identity: deps.identity, bootedAt: deps.bootedAt })[0].resumable).toBe(true);
			const resumed = await request({ kind: "resume", runId: run.id }) as any;
			expect(resumed.resumeCount).toBe(1);
			expect(store.getRun(run.id)!.pid).toBeUndefined();        // the stale identity did not survive the resume
			expect(store.getRun(run.id)!.worker).toBeUndefined();
			expect(tern.launched()).toHaveLength(1);                  // one worker, never a second on the same session
		});

		it("the near miss stays refused end to end: a genuinely live worker is never shadowed", async () => {
			const run = withWorker(makeRun({ block: 411 }), 4400, "kernel-start:555");
			livePids.add(4400);
			identities.set(4400, { start: "kernel-start:555", command: "pi", commandHash: "worker-argv" });
			tern.live.add(411);
			await expect(request({ kind: "resume", runId: run.id })).rejects.toThrow(/still running \(pid 4400\).*claw_send/);
			expect(tern.launched()).toHaveLength(0);
			expect(store.getRun(run.id)!.resumeCount).toBeUndefined();
		});
	});

	describe("downtime never spends the relaunch budget", () => {
		it("a lost worker that the reboot killed stays lost-and-resumable, with no relaunch and no budget record", async () => {
			const run = withWorker(makeRun({
				status: "lost", settles: 0, phase: "tab_open", block: 412, launchStartedAt: PRE_BOOT,
				deadline: new Date(Date.parse(PRE_BOOT) + 90_000).toISOString(),
			}), 2916175, "kernel-start:1000", PRE_BOOT);
			livePids.delete(2916175);
			await reconcileRun(store.getRun(run.id)!, deps, new Set(tern.live));
			const after = store.getRun(run.id)!;
			expect(after.status).toBe("lost");
			expect(after.relaunchCount).toBeUndefined();
			expect(store.readInbox(0).items.filter((i) => i.kind === "run_budget_spent")).toHaveLength(0);
			// ...and the recorded session is still the way back in.
			const resumed = await request({ kind: "resume", runId: run.id }) as any;
			expect(resumed.resumeCount).toBe(1);
		});

		it("a worker that crashed inside one boot is still relaunched once (the reboot rule is not a blanket no-retry)", async () => {
			const run = withWorker(makeRun({ status: "lost", settles: 0, phase: "tab_open", block: undefined }), 5150, "kernel-start:1000");
			livePids.delete(5150);
			await reconcileRun(store.getRun(run.id)!, deps, new Set());
			const after = store.getRun(run.id)!;
			expect(after.relaunchCount).toBe(1);
			expect(store.readInbox(0).items.map((i) => i.kind)).toContain("run_recovered");
		});

		it("the dispatch deadline still refuses a first launch that never reached a worker", () => {
			const deadline = new Date(Date.parse(START) - 60_000).toISOString();
			expect(recoveryReason({ status: "failed", failureClass: "launch", phase: "issue_created", deadline, settles: 0 } as Run, clock.getTime()))
				.toEqual({ reason: "the launch failed before any worker tab existed", expired: true });
			// The same deadline on a run that did have a worker can no longer refuse recovery.
			expect(recoveryReason({ status: "lost", phase: "tab_open", deadline, settles: 0 } as Run, clock.getTime()))
				.toEqual({ reason: "the worker stopped before its first settled turn", expired: false });
		});
	});

	describe("the real process table", () => {
		it("reads this process's own start token, and the host boot is a plausible instant", () => {
			const self = readProcessIdentity(process.pid);
			expect(self?.start).toMatch(/^(kernel-start|lstart):/);
			expect(pidAlive(process.pid)).toBe(true);
			const boot = bootedAtMs();
			if (boot !== undefined) {
				expect(boot).toBeLessThanOrEqual(Date.now());
				expect(boot).toBeGreaterThan(Date.now() - 400 * 24 * 3600_000);
			}
			expect(readProcessIdentity(Number.MAX_SAFE_INTEGER)).toBeUndefined();
		});

		it("a real child process proves alive by identity, and its exit proves it gone", async () => {
			const child = spawn(process.execPath, ["-e", "setTimeout(() => undefined, 30_000)"], { stdio: "ignore" });
			const pid = child.pid;
			expect(pid).toBeDefined();
			try {
				const identity = await waitFor(() => readProcessIdentity(pid!), (found) => found !== undefined);
				const run = makeRun({
					pid,
					worker: { pid: pid!, start: identity!.start, commandHash: identity!.commandHash, seenAt: new Date().toISOString() },
				});
				const facts = { alive: pidAlive, identity: readProcessIdentity, bootedAt: bootedAtMs(), nowMs: Date.now() };
				expect(runLiveness(run, facts).state).toBe("alive");
				child.kill("SIGKILL");
				await waitFor(() => pidAlive(pid!), (alive) => !alive);
				expect(runLiveness(run, facts).state).toBe("dead");
			} finally {
				if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
			}
		});
	});

	describe("the daemon singleton lock", () => {
		it("a lock whose pid a reboot reused is reclaimed; a lock whose start token matches still blocks", () => {
			writeFileSync(store.lockPath, JSON.stringify({ pid: 424242, startedAt: START, processStart: "kernel-start:1000" } satisfies DaemonLock));
			// Same number, different process: the old daemon is gone, so a new one may claim the singleton.
			expect(claimLock(store, () => true, "code-key", () => ({ start: "kernel-start:9000" }))).toBe(true);
			expect(readJson<DaemonLock>(store.lockPath)?.pid).toBe(process.pid);
			// The same start token is the same daemon: never steal a running singleton.
			writeFileSync(store.lockPath, JSON.stringify({ pid: 424242, startedAt: START, processStart: "kernel-start:1000" } satisfies DaemonLock));
			expect(claimLock(store, () => true, "code-key", () => ({ start: "kernel-start:1000" }))).toBe(false);
		});

		it("a heartbeat keeps the start token, so ownership stays checkable", () => {
			writeFileSync(store.lockPath, JSON.stringify({ pid: process.pid, startedAt: START, processStart: "kernel-start:777", fingerprint: "code" } satisfies DaemonLock));
			expect(heartbeat(store)).toBe(true);
			expect(readJson<DaemonLock>(store.lockPath)).toMatchObject({ pid: process.pid, processStart: "kernel-start:777", fingerprint: "code" });
		});
	});
});

/** Polls a cheap predicate until it answers, so a spawned process never makes the suite flaky. */
async function waitFor<T>(read: () => T, done: (value: T) => boolean, timeoutMs = 5_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = read();
		if (done(value)) return value;
		if (Date.now() >= deadline) throw new Error("condition not reached in time");
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}
