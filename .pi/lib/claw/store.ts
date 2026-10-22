/** File-backed state for /claw. Layout under <workspace>/.swarm/claw:
 *  - runs/<id>.json, runs/<id>.task.md, runs/<id>.events.jsonl (append-only, written by the worker process)
 *  - triggers/<id>.json, requests/<id>.json (clients -> daemon), responses/<id>.json (daemon -> clients)
 *  - inbox.jsonl (append-only, daemon -> orchestrator), orchestrator.json (inbox offset and owning session)
 *  - control.json (on/off), daemon.lock (singleton), daemon.log
 *  Single writer rule: only the daemon writes runs/ and triggers/; clients only write requests/ and control.json.
 *  Workers only append to their own events file. Stays free of parameter properties so the daemon can run under
 *  `node --experimental-strip-types`. */
import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

import type { Resolved } from "./hoja.ts";
import type { SourceState } from "./preflight.ts";

/** awaiting_decision: the worker opened its own ask modal and its turn is suspended until a human answers or cancels
 *  in that worker's tab. It is not a report, not a result, and not the terminal `needs_user` outcome (awaiting_user). */
export type RunStatus = "launching" | "running" | "idle" | "awaiting_decision" | "awaiting_user" | "completed" | "failed" | "lost" | "cancelled";
export const TERMINAL: readonly RunStatus[] = ["completed", "failed", "lost", "cancelled"];
/** Where a run is in its launch sequence; persisted before each side effect so a restart knows what is safe to redo.
 *  create_dispatched: the Hoja create was about to be sent; its outcome may be unknown and is only ever reconciled. */
export type RunPhase = "intent" | "create_dispatched" | "issue_created" | "tab_opening" | "tab_open";
export type HojaRef = { issueId: string; identifier: string; teamKey: string; project: string; assignee: string };
export type Finish = { outcome: "completed" | "failed" | "needs_user"; summary: string; evidence: string[]; at: string };
/** A worker's own ask_user_question modal, as the daemon sees it from worker events.
 *  open: the modal is showing in the worker's tab and the turn is suspended. answered/cancelled: the modal resolved.
 *  unresolved: the worker reported a finish (or the turn settled, or the process ended) with no closing ask event, so
 *  nobody recorded how the modal closed; it is never presented as still waiting. */
export type RunAskState = "open" | "answered" | "cancelled" | "unresolved";
export type RunAsk = { flowId: string; title?: string; questionIds: string[]; openedAt: string; state: RunAskState; closedAt?: string };
export type OutboxOp = { id: string; kind: "comment"; body: string; done: boolean } | { id: string; kind: "state"; state: string; done: boolean };
export type SpawnInput = { task: string; project: string; assignee?: string; label?: string; cwd?: string; provider?: string; model?: string };
export type Run = {
	id: string; label: string; task: string; cwd: string; status: RunStatus; phase: RunPhase;
	createdAt: string; updatedAt: string; project: string; assignee?: string; provider?: string; model?: string;
	requestedAssignee?: string; requestId?: string; fireKey?: string; trigger?: string;
	tab?: number; block?: number; sessionFile?: string; pid?: number;
	eventsOffset: number; settles: number; finalText?: string; finish?: Finish;
	hoja?: HojaRef; attempts: number; outbox: OutboxOp[]; seen: string[]; error?: string;
	/** The worker is running but its tab did not take the run label; shown by claw_read and status. */
	tabWarning?: string;
	/** How extensions were resolved for this worker when the launch differed from Pi's own package discovery. */
	launchNote?: string;
	/** Last Hoja write failure; the op stays pending and is retried. Kept apart from `error` so it cannot hide a launch failure. */
	syncError?: string;
	/** ISO instant after which no side effect may start (the spawn request's expiry). Checked before the Hoja create and before the tab. */
	deadline?: string;
	/** Team, state and assignee resolved before dispatch. Needed to verify an issue whose create outcome was unknown. */
	target?: Resolved;
	/** Next reconcile of an unknown create (backoff). */
	reconcileAt?: string;
	/** When the daemon closed this run's worker tab (completed, cancelled or failed). Set once; a closed block is not retried. */
	tabClosedAt?: string;
	/** Last failed attempt to close the worker tab; retried while the run is terminal and Tern answers. */
	tabCloseError?: string;
	/** When this run last entered `idle`; the stall clock. Cleared by `claw_send` (the worker is working again). */
	idleSince?: string;
	/** When the supervisor first reported this idle episode as stalled. One report per episode. */
	stalledAt?: string;
	/** When this run last entered `awaiting_user`; what the decision notice says "since" from. */
	awaitingSince?: string;
	/** Who ended a failed run: a launch step ("launch"), the worker's own report ("worker"), or the supervisor ("stalled"). */
	failureClass?: "launch" | "worker" | "stalled";
	/** Bounded supervisor acts, keyed by `<action>:<state>`. Attempts, next due time, budget exhaustion. Applies at most
	 *  once per run per key, so a fault cannot be acted on in a loop; see .pi/lib/claw/supervisor.ts. */
	remedies?: Record<string, Remedy>;
	/** How many times this run was restarted after a launch failure that provably created nothing (0 or 1). */
	relaunchCount?: number;
	/** When the supervisor noticed this run's worker tab missing while the worker process was still alive. */
	tabMissingAt?: string;
	/** The checkout this run was created from (HEAD, branch, fingerprint of tracked changes). The launch gate refuses a
	 *  worker tab when that checkout has moved or gained tracked edits since, so a worker cannot load a different tree. */
	source?: SourceState;
	/** The same checkout as it was immediately before the worker tab opened. */
	sourceAtLaunch?: SourceState;
	/** Non-fatal launch-gate findings (a source that was already dirty, a source this gate cannot inspect). */
	launchWarning?: string;
	/** Attempts the last launch gate used: 1 means the source was healthy on the first try. */
	launchAttempts?: number;
	/** The worker's own question modal. Absent when the worker never asked (legacy runs keep their plain needs_user). */
	ask?: RunAsk;
};

/** One bounded supervisor act. `nextAt` is jittered so several runs never retry in lockstep; `exhausted` means the
 *  budget is spent and the act is reported once instead of retried. */
export type Remedy = { attempts: number; lastAt: string; nextAt: string; done?: boolean; exhausted?: boolean; note?: string };
export type ClawEvent = {
	eid: string; type: "started" | "settled" | "ask" | "resumed" | "finish"; at: string; runId: string;
	pid?: number; sessionFile?: string; text?: string; stopReason?: string;
	outcome?: Finish["outcome"]; summary?: string; evidence?: string[];
	/** For type "ask": the worker's own modal opening or resolving. The worker owns this event; the daemon only applies it. */
	ask?: { flowId: string; title?: string; questionIds: string[]; state: "opened" | "answered" | "cancelled" };
};
export type TriggerWhen = { kind: "cron"; cron: string } | { kind: "at"; at: string } | { kind: "on_exit"; runId: string; on?: RunStatus[] };
export type TriggerAction = ({ kind: "spawn" } & SpawnInput) | { kind: "notify"; message: string };
export type Trigger = {
	id: string; when: TriggerWhen; action: TriggerAction; enabled: boolean; once: boolean; createdAt: string;
	nextFireAt?: string; fired: number; lastFiredAt?: string; lastRunId?: string; lastError?: string; retryAt?: string;
};
export type InboxKind =
	| "run_started" | "run_idle" | "run_completed" | "run_failed" | "run_needs_user" | "run_lost" | "run_cancelled"
	| "run_awaiting_input" | "run_input_answered" | "run_resumed"
	| "trigger_fired" | "notify" | "error"
	/** Supervisor notices. `run_stalled` names what a stuck run needs and since when; `run_tab_orphan` reports a worker
	 *  tab the daemon could not close; `run_recovered` records a bounded automatic recovery. */
	| "run_stalled" | "run_tab_orphan" | "run_recovered"
	/** A retry budget is spent: the act stopped and the reason is recorded once instead of retrying forever. */
	| "run_budget_spent"
	/** One collapsed digest per window (see .pi/lib/claw/supervisor.ts) and an all-clear heartbeat, so silence is health. */
	| "claw_digest" | "claw_heartbeat";
/** `id` is the stable delivery identity: the dedup key when one exists, otherwise a generated id. It is what the receiver records in its transcript. */
export type InboxItem = { id: string; at: string; key?: string; kind: InboxKind; runId?: string; triggerId?: string; text: string };
/** A low-severity notice held for the next digest. Delivered only inside a `claw_digest` inbox item, so per-event
 *  chatter never wakes the orchestrator one item at a time. Same dedupe-on-key contract as InboxItem. */
export type Notice = { id: string; at: string; key?: string; kind: InboxKind; runId?: string; text: string };
/** Supervisor bookkeeping that must survive a daemon restart: the digest cursor, the last digest/heartbeat, and counters. */
export type SupervisorState = {
	noticesOffset: number;
	lastDigestAt?: string;
	lastHeartbeatAt?: string;
	digests: number;
	notices: number;
	lastTickAt?: string;
	ticks: number;
	/** Runs the supervisor reported as stalled, orphaned or recovered since the store was created. */
	anomalies: number;
};
export type Request =
	| { id: string; kind: "spawn"; createdAt: string; expiresAt: string; input: SpawnInput }
	| { id: string; kind: "send"; createdAt: string; runId: string; text: string }
	| { id: string; kind: "cancel"; createdAt: string; runId: string }
	| { id: string; kind: "trigger_add"; createdAt: string; when: TriggerWhen; action: TriggerAction; once: boolean }
	| { id: string; kind: "trigger_remove"; createdAt: string; triggerId: string }
	/** Caller gave up waiting. Settles the target request: refused (not started) if still undispatched, else reports its outcome. */
	| { id: string; kind: "withdraw"; createdAt: string; requestId: string };
/** code "not_started" is a definitive refusal with no side effect (expired or withdrawn before dispatch). */
export type Response = { id: string; ok: boolean; result?: unknown; error?: string; code?: "not_started" };
export type OrchestratorState = {
	offset: number; owner?: string; ownerPid?: number;
	/** Inbox items handed to a session whose persistence is not yet seen in that session's transcript. */
	inflight?: { ids: string[]; endOffset: number; sentAt: string; session: string };
};
/** The daemon singleton lock. `fingerprint` is the code key the daemon was started from (see ./fingerprint.ts); it is
 *  absent on a lock written before that check existed, which is what makes an old supervisor recognizable. */
export type DaemonLock = { pid: number; startedAt?: string; heartbeat?: number; fingerprint?: string };
/** Request without its id/timestamp, distributed over the union so each kind keeps its fields. */
export type RequestBody = Request extends infer R ? (R extends unknown ? Omit<R, "id" | "createdAt" | "expiresAt"> : never) : never;

export const writeJson = (path: string, value: unknown) => {
	const tmp = `${path}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`;
	writeFileSync(tmp, JSON.stringify(value, null, 2));
	renameSync(tmp, path);
};
export const readJson = <T>(path: string): T | undefined => {
	try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch { return undefined; }
};

/** Reads whole JSON lines appended after `offset` bytes; a trailing partial line is left for the next read. */
export function readLines<T>(path: string, offset: number): { items: T[]; offset: number } {
	if (!existsSync(path)) return { items: [], offset };
	const fd = openSync(path, "r");
	try {
		const size = fstatSync(fd).size;
		if (size <= offset) return { items: [], offset: Math.min(offset, size) };
		const buf = Buffer.alloc(size - offset);
		readSync(fd, buf, 0, buf.length, offset);
		const end = buf.lastIndexOf(0x0a);
		if (end < 0) return { items: [], offset };
		const items: T[] = [];
		for (const line of buf.subarray(0, end).toString("utf8").split("\n")) {
			if (!line.trim()) continue;
			try { items.push(JSON.parse(line) as T); } catch { /* corrupt line: skip, never block the stream */ }
		}
		return { items, offset: offset + end + 1 };
	} finally { closeSync(fd); }
}

const SAFE_ID = /^[\w-]+$/;

export class ClawStore {
	readonly dir: string;
	readonly runsDir: string;
	readonly triggersDir: string;
	readonly requestsDir: string;
	readonly responsesDir: string;
	readonly inboxPath: string;
	readonly controlPath: string;
	readonly lockPath: string;
	readonly logPath: string;
	readonly noticesPath: string;
	readonly supervisorPath: string;

	constructor(dir: string) {
		this.dir = dir;
		this.runsDir = join(dir, "runs");
		this.triggersDir = join(dir, "triggers");
		this.requestsDir = join(dir, "requests");
		this.responsesDir = join(dir, "responses");
		this.inboxPath = join(dir, "inbox.jsonl");
		this.controlPath = join(dir, "control.json");
		this.lockPath = join(dir, "daemon.lock");
		this.logPath = join(dir, "daemon.log");
		this.noticesPath = join(dir, "notices.jsonl");
		this.supervisorPath = join(dir, "supervisor.json");
		for (const d of [this.runsDir, this.triggersDir, this.requestsDir, this.responsesDir]) mkdirSync(d, { recursive: true });
	}
	static forWorkspace(workspace: string): ClawStore { return new ClawStore(join(workspace, ".swarm", "claw")); }
	newId(prefix: "run" | "trg" | "req" | "evt"): string { return `${prefix}-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`; }

	saveRun(run: Run): Run { run.updatedAt = new Date().toISOString(); writeJson(join(this.runsDir, `${run.id}.json`), run); return run; }
	getRun(id: string): Run | undefined { return SAFE_ID.test(id) ? readJson<Run>(join(this.runsDir, `${id}.json`)) : undefined; }
	listRuns(): Run[] {
		return readdirSync(this.runsDir).filter((f) => /^run-[\w-]+\.json$/.test(f))
			.map((f) => readJson<Run>(join(this.runsDir, f))).filter((r): r is Run => Boolean(r))
			.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
	}
	taskPath(id: string): string { return join(this.runsDir, `${id}.task.md`); }
	eventsPath(id: string): string { return join(this.runsDir, `${id}.events.jsonl`); }
	/** The worker's own stderr, captured by the launch command so a startup failure can name its reason. */
	workerLogPath(id: string): string { return join(this.runsDir, `${id}.worker.log`); }
	readWorkerLog(id: string, maxBytes = 16_384): string {
		try {
			const raw = readFileSync(this.workerLogPath(id));
			return raw.subarray(Math.max(0, raw.length - maxBytes)).toString("utf8");
		} catch { return ""; }
	}
	appendEvent(event: ClawEvent): void { appendFileSync(this.eventsPath(event.runId), `${JSON.stringify(event)}\n`); }
	readEvents(id: string, offset: number) { return readLines<ClawEvent>(this.eventsPath(id), offset); }

	saveTrigger(t: Trigger): Trigger { writeJson(join(this.triggersDir, `${t.id}.json`), t); return t; }
	getTrigger(id: string): Trigger | undefined { return SAFE_ID.test(id) ? readJson<Trigger>(join(this.triggersDir, `${id}.json`)) : undefined; }
	listTriggers(): Trigger[] {
		return readdirSync(this.triggersDir).filter((f) => /^trg-[\w-]+\.json$/.test(f))
			.map((f) => readJson<Trigger>(join(this.triggersDir, f))).filter((t): t is Trigger => Boolean(t))
			.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
	}
	deleteTrigger(id: string): boolean {
		if (!/^trg-[\w-]+$/.test(id) || !existsSync(join(this.triggersDir, `${id}.json`))) return false;
		rmSync(join(this.triggersDir, `${id}.json`));
		return true;
	}

	/** Clients call this; the daemon consumes it. Id is the idempotency key. */
	writeRequest(req: Request): void { writeJson(join(this.requestsDir, `${req.id}.json`), req); }
	listRequests(): Request[] {
		return readdirSync(this.requestsDir).filter((f) => /^req-[\w-]+\.json$/.test(f)).sort()
			.map((f) => readJson<Request>(join(this.requestsDir, f))).filter((r): r is Request => Boolean(r));
	}
	readResponse(id: string): Response | undefined { return SAFE_ID.test(id) ? readJson<Response>(join(this.responsesDir, `${id}.json`)) : undefined; }
	writeResponse(res: Response): void { writeJson(join(this.responsesDir, `${res.id}.json`), res); }
	removeRequest(id: string): void { rmSync(join(this.requestsDir, `${id}.json`), { force: true }); }

	appendInbox(item: Omit<InboxItem, "at" | "id">): void {
		if (item.key && this.readInbox(0).items.some((i) => i.key === item.key)) return;
		const id = item.key ?? this.newId("evt");
		appendFileSync(this.inboxPath, `${JSON.stringify({ id, at: new Date().toISOString(), ...item })}\n`);
	}
	readInbox(offset: number) { return readLines<InboxItem>(this.inboxPath, offset); }
	/** Low-severity notices, folded into the next digest. Durable and append-only like the inbox; deduped on key. */
	appendNotice(item: Omit<Notice, "at" | "id">): void {
		if (item.key && this.readNotices(0).items.some((i) => i.key === item.key)) return;
		const id = item.key ?? this.newId("evt");
		appendFileSync(this.noticesPath, `${JSON.stringify({ id, at: new Date().toISOString(), ...item })}\n`);
	}
	readNotices(offset: number) { return readLines<Notice>(this.noticesPath, offset); }
	readSupervisor(): SupervisorState {
		return readJson<SupervisorState>(this.supervisorPath) ?? { noticesOffset: 0, digests: 0, notices: 0, ticks: 0, anomalies: 0 };
	}
	writeSupervisor(state: SupervisorState): void { writeJson(this.supervisorPath, state); }
	/** Owner = the Pi session that drives the inbox; only that session delivers inbox items. */
	readOrchestrator(): OrchestratorState { return readJson<OrchestratorState>(join(this.dir, "orchestrator.json")) ?? { offset: 0 }; }
	writeOrchestrator(state: OrchestratorState): void { writeJson(join(this.dir, "orchestrator.json"), state); }

	/** Absent control file means on. `pane` is the orchestrator's Tern block (TERN_PANE) recorded by /claw on; worker tabs open in its session. */
	readControl(): { enabled: boolean; pane?: number; supervise?: Record<string, unknown> } {
		const c = readJson<{ enabled?: boolean; pane?: number; supervise?: Record<string, unknown> }>(this.controlPath);
		return { enabled: c?.enabled !== false, pane: Number.isInteger(c?.pane) ? c?.pane : undefined, supervise: c?.supervise };
	}
	writeControl(enabled: boolean, pane: number | undefined): void {
		// Keep the operator's supervisor overrides: /claw on|off rewrites this file and must not drop them.
		const supervise = readJson<{ supervise?: Record<string, unknown> }>(this.controlPath)?.supervise;
		writeJson(this.controlPath, { enabled, pane, ...(supervise ? { supervise } : {}), updatedAt: new Date().toISOString() });
	}
}
