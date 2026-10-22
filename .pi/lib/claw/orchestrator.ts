/** Orchestrator-side client: every mutation is a request file the daemon answers. Reads go straight to the store. */
import { existsSync } from "node:fs";
import { ClawStore, readJson, TERMINAL, type DaemonLock, type Request, type RequestBody, type Response, type Run } from "./store.ts";
import { LAUNCH_TIMEOUT_MS, pidAlive, startDaemonProcess } from "./daemon.ts";
import { compareFingerprint, computeClawFingerprint, needsReplacement, type ClawFingerprint } from "./fingerprint.ts";
import { DAEMON_MAIN, refreshDaemon, type RefreshOptions, type RefreshOutcome } from "./lifecycle.ts";
import { runIdFor } from "./spawn.ts";
import { goalRow } from "./goal.ts";
import { reachability } from "./resume.ts";

export { DAEMON_MAIN };
export const REQUEST_TIMEOUT_MS = 90_000;
export const WITHDRAW_WAIT_MS = 5_000;

/** What the caller may rely on. `pending` means a side effect may still happen: the caller must read state, not retry. */
export type CallOutcome =
	| { state: "done"; result: unknown }
	| { state: "not_started"; requestId: string; reason: string }
	| { state: "pending"; requestId: string; runId?: string; reason: string };

type Ensure = (store: ClawStore, workspace: string) => number | undefined;
export type RequestOptions = {
	timeoutMs?: number; withdrawWaitMs?: number; ensure?: Ensure;
	/** Code-staleness check performed before the request is queued (default `refreshDaemon`). */
	refresh?: (store: ClawStore, workspace: string, options?: RefreshOptions) => Promise<RefreshOutcome>;
};

export function daemonPid(store: ClawStore): number | undefined {
	const pid = readJson<{ pid: number }>(store.lockPath)?.pid;
	return pid !== undefined && pidAlive(pid) ? pid : undefined;
}

/** The live daemon's pid when it is running the code on disk; otherwise starts one, unless the live one is stale — then
 *  it must be replaced first (`refreshDaemon`), and starting a second process would only fight for the singleton. */
export function ensureDaemon(store: ClawStore, workspace: string, fingerprint?: ClawFingerprint): number | undefined {
	const lock = readJson<DaemonLock>(store.lockPath);
	if (lock?.pid !== undefined && pidAlive(lock.pid)) {
		const comparison = compareFingerprint(lock.fingerprint, (fingerprint ?? computeClawFingerprint())?.key);
		return needsReplacement(comparison) ? undefined : lock.pid;
	}
	startDaemonProcess(workspace, store, DAEMON_MAIN);
	return undefined;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForResponse(store: ClawStore, workspace: string, id: string, timeoutMs: number, ensure: Ensure): Promise<Response | undefined> {
	const deadline = Date.now() + timeoutMs;
	let lastCheck = Date.now();
	for (;;) {
		const res = store.readResponse(id);
		if (res) return res;
		if (Date.now() >= deadline) return undefined;
		if (Date.now() - lastCheck > 5000) { lastCheck = Date.now(); ensure(store, workspace); }
		await sleep(250);
	}
}

function settle(id: string, res: Response): CallOutcome {
	if (res.ok) return { state: "done", result: res.result };
	if (res.code === "not_started") return { state: "not_started", requestId: id, reason: res.error ?? "not started" };
	throw new Error(res.error ?? "claw daemon refused the request");
}

/** Queues one request with an expiry the daemon enforces. If no answer arrives in time, the caller withdraws it:
 *  an undispatched request is refused for good (never starts later); a dispatched one reports its real outcome. */
export async function request(store: ClawStore, workspace: string, body: RequestBody, options: RequestOptions = {}): Promise<CallOutcome> {
	const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
	const withdrawWaitMs = options.withdrawWaitMs ?? WITHDRAW_WAIT_MS;
	const ensure = options.ensure ?? ensureDaemon;
	// A live daemon that runs older code does not have this request's behaviour, so it is replaced before the request is
	// queued. Every other case queues immediately: the request file is the caller's only durable handle, and a check
	// that is not needed must not delay it.
	const lock = readJson<DaemonLock>(store.lockPath);
	const staleLive = lock?.pid !== undefined && Number.isInteger(lock.pid) && lock.pid > 1 && pidAlive(lock.pid)
		&& needsReplacement(compareFingerprint(lock.fingerprint, computeClawFingerprint()?.key));
	if (staleLive) {
		const freshness = await (options.refresh ?? refreshDaemon)(store, workspace).catch((error) => ({
			action: "skipped", state: "unknown", blocked: false, note: `code check failed: ${(error as Error).message}`,
		} as RefreshOutcome));
		if (freshness.blocked) throw new Error(freshness.note);
	}
	const createdAt = new Date().toISOString();
	const id = store.newId("req");
	const req = (body.kind === "spawn"
		? { ...body, id, createdAt, expiresAt: new Date(Date.now() + timeoutMs).toISOString() }
		: { ...body, id, createdAt }) as Request;
	const runId = req.kind === "spawn" ? runIdFor(id) : undefined;
	store.writeRequest(req);
	ensure(store, workspace);

	const answer = await waitForResponse(store, workspace, id, timeoutMs, ensure);
	if (answer) return settle(id, answer);

	const withdrawId = store.newId("req");
	store.writeRequest({ id: withdrawId, kind: "withdraw", createdAt: new Date().toISOString(), requestId: id });
	const withdrawn = await waitForResponse(store, workspace, withdrawId, withdrawWaitMs, ensure);
	if (!withdrawn) {
		return { state: "pending", requestId: id, runId, reason: "The daemon has not answered yet. The request is queued and is refused for good if its deadline passes before dispatch. Read claw_list or claw_read before any new attempt." };
	}
	if (!withdrawn.ok) throw new Error(withdrawn.error ?? "claw daemon refused the withdrawal");
	const r = withdrawn.result as { withdrawn: boolean; state: string; runId?: string; result?: unknown; error?: string };
	if (r.withdrawn || r.state === "not_started") return { state: "not_started", requestId: id, reason: "The request was withdrawn before dispatch; nothing was started." };
	if (r.state === "accepted" && r.result !== undefined) return { state: "done", result: r.result };
	if (r.state === "accepted") return { state: "pending", requestId: id, runId: r.runId ?? runId, reason: "The request was dispatched before the caller gave up. Its run may still be launching. Read claw_read on runId; do not submit it again." };
	throw new Error(r.error ?? "claw daemon refused the request");
}

export function statusSummary(store: ClawStore, nowMs = Date.now()) {
	const runs = store.listRuns();
	const facts = { alive: pidAlive, sessionExists: existsSync, nowMs: Date.now() };
	const lock = readJson<DaemonLock>(store.lockPath);
	const comparison = compareFingerprint(lock?.fingerprint, computeClawFingerprint()?.key);
	const live = lock?.pid !== undefined && pidAlive(lock.pid);
	const counts: Record<string, number> = {};
	for (const r of runs) counts[r.status] = (counts[r.status] ?? 0) + 1;
	return {
		enabled: store.readControl().enabled,
		daemonPid: live ? lock?.pid : null,
		/** Whether the running supervisor is the one this code would start. `unknown` means the code could not be read. */
		daemon: { pid: live ? lock?.pid : null, startedAt: live ? lock?.startedAt : undefined, code: comparison.state, note: comparison.detail },
		runs: counts,
		active: runs.filter((r) => !TERMINAL.includes(r.status) && r.status !== "awaiting_user").map((r) => ({ id: r.id, label: r.label, status: r.status, identifier: r.hoja?.identifier, launchNote: r.launchNote })),
		awaitingDecision: runs.filter((r) => r.ask?.state === "open").map((r) => ({ id: r.id, identifier: r.hoja?.identifier, tab: r.block, questions: r.ask?.questionIds ?? [], openedAt: r.ask?.openedAt })),
		awaitingUser: runs.filter((r) => r.status === "awaiting_user").map((r) => ({ id: r.id, summary: r.finish?.summary, since: r.finish?.at })),
		unresolvedCreates: runs.filter((r) => r.phase === "create_dispatched" && !TERMINAL.includes(r.status)).map((r) => ({ id: r.id, error: r.error })),
		/** The always-on completion goal of every run: condition, turns used, judge calls, last verdict and elapsed time.
		 *  Nothing here bounds a goal; a `warning` row has merely run unusually long. */
		goals: runs.filter((r) => r.goal).map((r) => ({ id: r.id, identifier: r.hoja?.identifier, ...goalRow(r.goal, nowMs)! })),
		/** Runs a human asked to keep open: their tab survives a terminal state, across daemon restarts. */
		keptOpen: runs.filter((r) => r.keepOpen === true).map((r) => ({ id: r.id, identifier: r.hoja?.identifier, status: r.status, tab: r.block, sessionFile: r.sessionFile })),
		/** Terminal runs whose conversation can still be reopened with claw_resume, and why the others cannot. */
		resumable: runs.map((r) => ({ run: r, state: reachability(r, facts) })).filter((x) => TERMINAL.includes(x.run.status) && x.state.resumable)
			.map((x) => ({ id: x.run.id, identifier: x.run.hoja?.identifier, status: x.run.status, sessionFile: x.run.sessionFile, resumes: x.run.resumeCount ?? 0 })),
		hojaSyncPending: runs.reduce((n, r) => n + r.outbox.filter((o) => !o.done).length, 0),
		triggers: store.listTriggers().map((t) => ({ id: t.id, enabled: t.enabled, next: t.nextFireAt, fired: t.fired, lastError: t.lastError })),
		unreadInbox: store.readInbox(store.readOrchestrator().offset).items.length,
		logExists: existsSync(store.logPath),
	};
}

/** Run rows for `claw list`. `ageSeconds` is time since creation; a launching run also shows seconds left before it
 *  times out, counted from the current launch or resume attempt. `keepOpen` and `resumable` say how the run can still be
 *  reached: a kept run's tab is never auto-closed, and a resumable one reopens on its own session file with claw_resume.
 *  `reachability` is the reason when it cannot be resumed. */
export function runListing(runs: Run[], nowMs: number, options: { alive?: (pid: number) => boolean; live?: Set<number> } = {}) {
	const alive = options.alive ?? pidAlive;
	return runs.map((r) => {
		const launchAge = Math.max(0, Math.round((nowMs - Date.parse(r.launchStartedAt ?? r.createdAt)) / 1000));
		const ageSeconds = Math.max(0, Math.round((nowMs - Date.parse(r.createdAt)) / 1000));
		const launchTimeoutInSeconds = r.status === "launching" ? Math.max(0, Math.round(LAUNCH_TIMEOUT_MS / 1000) - launchAge) : undefined;
		const reach = reachability(r, { alive, live: options.live, sessionExists: existsSync, nowMs });
		const waiting = r.ask?.state === "open" ? { questions: r.ask.questionIds, since: r.ask.openedAt, tab: r.block } : undefined;
		return {
			id: r.id, label: r.label, status: r.status, phase: r.phase, identifier: r.hoja?.identifier, ageSeconds, launchTimeoutInSeconds,
			error: r.error, launchNote: r.launchNote, waiting, goal: goalRow(r.goal, nowMs),
			keepOpen: reach.keepOpen, resumable: reach.resumable, reachability: reach.reason,
			sessionFile: r.sessionFile, resumes: r.resumeCount ?? 0, resumeError: r.resumeError,
		};
	});
}
