/** Orchestrator-side client: every mutation is a request file the daemon answers. Reads go straight to the store. */
import { existsSync } from "node:fs";
import { ClawStore, readJson, TERMINAL, type Request, type RequestBody, type Response, type Run } from "./store.ts";
import { LAUNCH_TIMEOUT_MS, pidAlive, startDaemonProcess } from "./daemon.ts";
import { runIdFor } from "./spawn.ts";
import { goalRow } from "./goal.ts";

export const DAEMON_MAIN = new URL("./daemon-main.ts", import.meta.url).pathname;
export const REQUEST_TIMEOUT_MS = 90_000;
export const WITHDRAW_WAIT_MS = 5_000;

/** What the caller may rely on. `pending` means a side effect may still happen: the caller must read state, not retry. */
export type CallOutcome =
	| { state: "done"; result: unknown }
	| { state: "not_started"; requestId: string; reason: string }
	| { state: "pending"; requestId: string; runId?: string; reason: string };

type Ensure = (store: ClawStore, workspace: string) => number | undefined;
export type RequestOptions = { timeoutMs?: number; withdrawWaitMs?: number; ensure?: Ensure };

export function daemonPid(store: ClawStore): number | undefined {
	const pid = readJson<{ pid: number }>(store.lockPath)?.pid;
	return pid !== undefined && pidAlive(pid) ? pid : undefined;
}

export function ensureDaemon(store: ClawStore, workspace: string): number | undefined {
	const pid = daemonPid(store);
	if (pid !== undefined) return pid;
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
	const counts: Record<string, number> = {};
	for (const r of runs) counts[r.status] = (counts[r.status] ?? 0) + 1;
	return {
		enabled: store.readControl().enabled,
		daemonPid: daemonPid(store) ?? null,
		runs: counts,
		active: runs.filter((r) => !TERMINAL.includes(r.status) && r.status !== "awaiting_user").map((r) => ({ id: r.id, label: r.label, status: r.status, identifier: r.hoja?.identifier, launchNote: r.launchNote })),
		awaitingDecision: runs.filter((r) => r.ask?.state === "open").map((r) => ({ id: r.id, identifier: r.hoja?.identifier, tab: r.block, questions: r.ask?.questionIds ?? [], openedAt: r.ask?.openedAt })),
		awaitingUser: runs.filter((r) => r.status === "awaiting_user").map((r) => ({ id: r.id, summary: r.finish?.summary, since: r.finish?.at })),
		unresolvedCreates: runs.filter((r) => r.phase === "create_dispatched" && !TERMINAL.includes(r.status)).map((r) => ({ id: r.id, error: r.error })),
		/** The always-on completion goal of every run: condition, turns used, judge calls, last verdict and elapsed time.
		 *  Nothing here bounds a goal; a `warning` row has merely run unusually long. */
		goals: runs.filter((r) => r.goal).map((r) => ({ id: r.id, identifier: r.hoja?.identifier, ...goalRow(r.goal, nowMs)! })),
		hojaSyncPending: runs.reduce((n, r) => n + r.outbox.filter((o) => !o.done).length, 0),
		triggers: store.listTriggers().map((t) => ({ id: t.id, enabled: t.enabled, next: t.nextFireAt, fired: t.fired, lastError: t.lastError })),
		unreadInbox: store.readInbox(store.readOrchestrator().offset).items.length,
		logExists: existsSync(store.logPath),
	};
}

/** Run rows for `claw list`. `ageSeconds` is time since creation; a launching run also shows seconds left before it times out. */
export function runListing(runs: Run[], nowMs: number) {
	return runs.map((r) => {
		const ageSeconds = Math.max(0, Math.round((nowMs - Date.parse(r.createdAt)) / 1000));
		const launchTimeoutInSeconds = r.status === "launching" ? Math.max(0, Math.round(LAUNCH_TIMEOUT_MS / 1000) - ageSeconds) : undefined;
		const waiting = r.ask?.state === "open" ? { questions: r.ask.questionIds, since: r.ask.openedAt, tab: r.block } : undefined;
		return { id: r.id, label: r.label, status: r.status, phase: r.phase, identifier: r.hoja?.identifier, ageSeconds, launchTimeoutInSeconds, error: r.error, launchNote: r.launchNote, waiting, goal: goalRow(r.goal, nowMs) };
	});
}
