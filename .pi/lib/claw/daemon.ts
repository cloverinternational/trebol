/** The /claw daemon: a singleton, detached process that owns every run and trigger write.
 *  Each tick: serve client requests, resume unfinished launches, apply worker events, detect lost workers,
 *  flush Hoja writes (outbox), then fire due triggers. Every step is idempotent so a crash at any point is safe. */
import { spawn as spawnChild } from "node:child_process";
import { openSync, rmSync, writeFileSync } from "node:fs";
import { nextCronTime, validateCron } from "../../../packages/tools/schedule/src/cron.ts";
import type { LaunchDeps } from "./spawn.ts";
import { continueRun, failRun, findByKey, queueComment, queueState, runMarker, startRun, opMarker } from "./spawn.ts";
import { liveBlocks, closeBlock, sendToBlock, findRunBlock } from "./launcher.ts";
import { ClawStore, readJson, TERMINAL, type ClawEvent, type Request, type Response, type Run, type RunStatus, type Trigger, type SpawnInput } from "./store.ts";
import { validateFinish } from "./child.ts";
import { CLOSE_ON_END, DEFAULT_SLO, closeRunTab, flushDigest, sloFrom, superviseRun, supervisionPending, type SloConfig } from "./supervisor.ts";

export const TICK_MS = 1000;
export const IDLE_EXIT_MS = 120_000;
export const LOST_GRACE_MS = 60_000;
export const TRIGGER_RETRY_MS = 60_000;
export const CANCEL_VERIFY_MS = 5_000;
/** A run still "launching" this long after creation has no worker: it is failed with a reason, never left silent. */
export const LAUNCH_TIMEOUT_MS = 5 * 60_000;
/** How long an open worker question may stay unanswered before the orchestrator is reminded once. It is a reminder,
 *  not a timeout: the run stays `awaiting_decision` (active) because its worker tab is still alive and waiting. */
export const ASK_STALE_MS = 30 * 60 * 1000;

export type DaemonDeps = LaunchDeps & {
	now: () => Date;
	alive: (pid: number) => boolean;
	signal: (pid: number, sig: "SIGTERM") => void;
	cancelVerifyMs?: number;
	/** Supervisor SLO overrides; tests use small bounds, a workspace may tighten them in control.json `supervise`. */
	slo?: Partial<SloConfig>;
};

export function pidAlive(pid: number): boolean {
	try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

/** A cancel is verified only when the worker process and its tab are both confirmed gone. Anything else is unverified,
 *  and the Hoja issue state is then left alone. */
export async function verifyCancelled(run: Run, deps: DaemonDeps): Promise<boolean> {
	if (run.pid !== undefined) {
		const deadline = Date.now() + (deps.cancelVerifyMs ?? CANCEL_VERIFY_MS);
		while (deps.alive(run.pid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 200));
		if (deps.alive(run.pid)) return false;
	}
	if (run.block !== undefined) {
		const live = await liveBlocks(deps.tern).catch(() => undefined);
		if (!live || live.has(run.block)) return false;
	}
	return true;
}

/** Singleton claim. A live owner blocks; a dead owner's lock is reclaimed; the write is re-read to confirm ownership. */
export function claimLock(store: ClawStore, alive: (pid: number) => boolean = pidAlive): boolean {
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			writeFileSync(store.lockPath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), heartbeat: Date.now() }), { flag: "wx" });
		} catch {
			const current = readJson<{ pid: number }>(store.lockPath);
			if (current && current.pid !== process.pid && alive(current.pid)) return false;
			rmSync(store.lockPath, { force: true });
			continue;
		}
		return readJson<{ pid: number }>(store.lockPath)?.pid === process.pid;
	}
	return false;
}

export function heartbeat(store: ClawStore): boolean {
	const current = readJson<{ pid: number }>(store.lockPath);
	if (current?.pid !== process.pid) return false;
	writeFileSync(store.lockPath, JSON.stringify({ pid: process.pid, startedAt: readJson<{ startedAt: string }>(store.lockPath)?.startedAt, heartbeat: Date.now() }));
	return true;
}

export function releaseLock(store: ClawStore): void {
	if (readJson<{ pid: number }>(store.lockPath)?.pid === process.pid) rmSync(store.lockPath, { force: true });
}

const summary = (r: Run) => ({ id: r.id, label: r.label, status: r.status, phase: r.phase, project: r.project, assignee: r.assignee, identifier: r.hoja?.identifier, block: r.block, pid: r.pid, error: r.error, launchNote: r.launchNote, finish: r.finish });
export const isActive = (r: Run) => !TERMINAL.includes(r.status) && r.status !== "awaiting_user";

export { closeRunTab };

/** What `claw send` says when a run cannot take input. Always names the next step. */
export function sendRefusal(run: Run): string {
	if (run.status === "awaiting_user") return `run ${run.id} is awaiting_user and its tab is gone; relaunch with claw_spawn using the summary from claw_read`;
	return `run ${run.id} is ${run.status}; it cannot take input. Start a new run with claw_spawn if more work is needed`;
}

export async function handleRequest(req: Request, deps: DaemonDeps): Promise<unknown> {
	const { store, tern } = deps;
	const control = store.readControl();
	switch (req.kind) {
		case "spawn": {
			if (!control.enabled) throw new Error("claw is off: new runs are not scheduled. Turn it on with /claw on");
			return summary(await startRun(req.input, deps, { requestId: req.id, deadline: req.expiresAt }));
		}
		case "send": {
			const run = store.getRun(req.runId);
			if (!run) throw new Error(`no run ${req.runId}`);
			// A modal is a dialog in the worker's own tab: typing text into it would answer or corrupt it on the
			// user's behalf. This refusal comes first, before any reactivation path, so nothing is ever typed into it.
			if (run.ask?.state === "open") throw new Error(`run ${run.id} has a question open in its own tab (${run.ask.questionIds.length || "some"} question(s)); answer it in that tab so the same run continues. claw_send is refused while a modal is open.`);
			// awaiting_user keeps its tab: input re-activates the run instead of refusing it.
			let reactivated = false;
			if (run.status === "awaiting_user" && run.block !== undefined) {
				const live = await liveBlocks(tern).catch(() => new Set<number>());
				if (live.has(run.block)) { run.status = "running"; store.saveRun(run); reactivated = true; }
			}
			if (!isActive(run) || run.block === undefined) throw new Error(sendRefusal(run));
			await sendToBlock(tern, run.block, req.text);
			// An idle worker is working again after input: its next settled turn is a new idle episode and must be announced.
			// The stall clock is reset by the same input, so a human who answers a stalled run extends it deliberately.
			if (run.status === "idle") { run.status = "running"; run.idleSince = undefined; run.stalledAt = undefined; store.saveRun(run); }
			return { sent: run.id, reactivated };
		}
		case "cancel": {
			const run = store.getRun(req.runId);
			if (!run) throw new Error(`no run ${req.runId}`);
			if (TERMINAL.includes(run.status)) return summary(run);
			if (run.pid && deps.alive(run.pid)) deps.signal(run.pid, "SIGTERM");
			await closeRunTab(run, tern).catch((e) => { run.error = `tab close failed: ${(e as Error).message}`.slice(0, 300); });
			const verified = await verifyCancelled(run, deps);
			run.status = "cancelled";
			if (!run.hoja) {
				// No Hoja issue is linked. If the create was unresolved, a late commit may exist: a human must check the marker.
				if (run.phase === "create_dispatched") run.error = `cancelled while the Hoja create outcome was unknown; a late issue carrying ${runMarker(run.id)} may exist and needs a manual check`;
			} else {
				queueComment(run, verified
					? "Claw: run cancelled by the orchestrator; worker process and tab confirmed gone. No completion is implied."
					: "Claw: cancel requested but the worker or its tab is not confirmed gone; Hoja state left unchanged. No completion is implied.");
			}
			// Claw-owned issue only (run.hoja is set by this run's own create), and only after verified cancellation. Never Done.
			if (verified && run.hoja) queueState(run, "Canceled");
			store.saveRun(run);
			store.appendInbox({ kind: "run_cancelled", runId: run.id, text: `${run.id} cancelled`, key: `cancel:${run.id}` });
			return summary(run);
		}
		case "withdraw": {
			// Settles a request its caller gave up on. The daemon is sequential: the target is already answered, or a run
			// exists (dispatched), or it is still undispatched and is refused now so it can never start later.
			const target = store.readResponse(req.requestId);
			if (target) return { withdrawn: false, state: target.ok ? "accepted" : target.code === "not_started" ? "not_started" : "refused", result: target.result, error: target.error };
			const run = findByKey(store, { requestId: req.requestId });
			if (run) return { withdrawn: false, state: "accepted", runId: run.id };
			store.writeResponse({ id: req.requestId, ok: false, code: "not_started", error: "withdrawn by the caller before dispatch; not started" });
			return { withdrawn: true, state: "not_started" };
		}
		case "trigger_add": {
			const id = `trg-${req.id.replace(/^req-/, "")}`;
			const existing = store.getTrigger(id);
			if (existing) return existing;
			const now = deps.now();
			const when = req.when;
			let nextFireAt: string | undefined;
			if (when.kind === "cron") { validateCron(when.cron); nextFireAt = nextCronTime(when.cron, now).toISOString(); }
			else if (when.kind === "at") { if (Number.isNaN(Date.parse(when.at))) throw new Error("at must be an ISO time"); nextFireAt = new Date(when.at).toISOString(); }
			else if (!store.getRun(when.runId)) throw new Error(`on_exit: no run ${when.runId}`);
			// Refuse an unknown project or assignee now, not on every later fire (a trigger that can never launch).
			if (req.action.kind === "spawn") { validateSpawn(req.action); await deps.hoja.resolve(req.action.project, req.action.assignee); }
			const trigger: Trigger = { id, when, action: req.action, enabled: true, once: req.once, createdAt: now.toISOString(), nextFireAt, fired: 0 };
			return store.saveTrigger(trigger);
		}
		case "trigger_remove":
			return { removed: store.deleteTrigger(req.triggerId) };
	}
}

function validateSpawn(input: SpawnInput): void {
	if (!input.task?.trim()) throw new Error("task is required");
	if (!input.project?.trim()) throw new Error("project is required");
}

/** Serves each request once. A response file is the completion marker, so a replayed request is a no-op. */
export async function processRequests(deps: DaemonDeps): Promise<void> {
	for (const req of deps.store.listRequests()) {
		if (!deps.store.readResponse(req.id)) {
			let res: Response;
			try {
				// A spawn past its deadline never starts, unless a run already exists for it (then it was dispatched).
				const expired = req.kind === "spawn" && deps.now().getTime() > Date.parse(req.expiresAt);
				if (expired && !findByKey(deps.store, { requestId: req.id })) res = { id: req.id, ok: false, code: "not_started", error: "expired before dispatch; not started" };
				else res = { id: req.id, ok: true, result: await handleRequest(req, deps) };
			}
			catch (error) { res = { id: req.id, ok: false, error: (error as Error).message.slice(0, 1000) }; }
			deps.store.writeResponse(res);
		}
		deps.store.removeRequest(req.id);
	}
}

/** No event means the worker never reached `session_start`: it died while pi was still starting. */
const neverStarted = (run: Run): boolean => run.pid === undefined && run.eventsOffset === 0 && run.phase === "tab_open";

/** The first actionable line of a worker's captured stderr. pi prints one line per startup failure. */
export function startupFailureReason(log: string): string | undefined {
	const line = log.split("\n").map((entry) => entry.trim()).find((entry) => entry.length > 0
		&& /Failed to load extension|conflicts with|Unknown option|Cannot find module|ERR_MODULE_NOT_FOUND|SyntaxError|EACCES|EISDIR|ENOENT/i.test(entry));
	if (!line) return undefined;
	return line.replace(/\s+/g, " ").slice(0, 300);
}

/** A worker that died before its first session event is failed with the reason, never reported as "lost". */
function failStartup(run: Run, deps: DaemonDeps): void {
	const reason = startupFailureReason(deps.store.readWorkerLog(run.id));
	run.status = "failed";
	run.error = (reason
		? `worker exited before session_start: ${reason}`
		: `worker exited before session_start and wrote no reason (stderr log: ${deps.store.workerLogPath(run.id)})`).slice(0, 500);
	queueComment(run, `Claw: ${run.error}. No completion is implied.`);
	deps.store.appendInbox({ kind: "run_failed", runId: run.id, text: `${run.label} failed: ${run.error}`, key: `fail:${run.id}` });
}

export function applyEvent(run: Run, ev: ClawEvent, store: ClawStore): void {
	if (run.seen.includes(ev.eid)) return;
	run.seen = [...run.seen, ev.eid].slice(-500);
	const key = `ev:${ev.eid}`;
	if (ev.type === "started") {
		run.pid = ev.pid;
		run.sessionFile = ev.sessionFile;
		if (!TERMINAL.includes(run.status) && run.status !== "awaiting_user") run.status = "running";
		// A started worker is working: its stall clock and stall report belong to the previous episode.
		run.idleSince = undefined;
		run.stalledAt = undefined;
		// Low severity: folded into the next digest, never a wake-up of its own (SLO S4).
		store.appendNotice({ kind: "run_started", runId: run.id, text: `${run.label} (${run.hoja?.identifier ?? run.id}) is running`, key });
		return;
	}
	if (ev.type === "settled") {
		run.settles++;
		run.finalText = ev.text;
		// A turn cannot settle while the worker's own modal is still open. If it does, the close event was lost:
		// stop presenting the question as still waiting.
		if (run.ask?.state === "open") run.ask = { ...run.ask, state: "unresolved", closedAt: ev.at };
		// Only a launching or running worker goes idle. Terminal, awaiting_user and idle runs get no new notice: a
		// settle there is expected (after claw_finish) or already reported. awaiting_decision is included because a
		// settle there means the modal vanished without closing: the run must not stay waiting.
		if (run.status !== "launching" && run.status !== "running" && run.status !== "awaiting_decision") return;
		// A settled turn is not a result: it may be idle, waiting for a permission or a question, or done without a report.
		// The notice belongs to the transition, so it is keyed by the run and its settle count, not by the event.
		run.status = "idle";
		// The stall clock starts at this transition; `claw_send` clears it and the supervisor acts on it (SLO S1).
		run.idleSince = ev.at ?? new Date().toISOString();
		run.stalledAt = undefined;
		// Low severity: a notice folded into the next digest, never a wake-up of its own (SLO S4).
		store.appendNotice({
			kind: "run_idle", runId: run.id,
			text: run.ask?.state === "cancelled"
				? `${run.label} cancelled its own question and settled the turn without claw_finish (not a completion); the run is idle, so it still needs a truthful report or an answer in its tab`
				: `${run.label} settled a turn without claw_finish (not a completion)`,
			key: `idle:${run.id}:${run.settles}`,
		});
		return;
	}
	// The worker's own question modal. An open modal is its own state, never `awaiting_user`: that word is reserved for
	// the terminal needs_user report, and merging them would hide whether a human has to answer in the worker's tab.
	if (ev.type === "ask") {
		if (TERMINAL.includes(run.status) || !ev.ask) return;
		const label = run.hoja?.identifier ?? run.id;
		const where = run.block !== undefined ? `tab ${run.tab ?? "?"} (block ${run.block})` : "its tab";
		if (ev.ask.state === "opened") {
			run.ask = { flowId: ev.ask.flowId, title: ev.ask.title, questionIds: ev.ask.questionIds, openedAt: ev.at, state: "open" };
			run.status = "awaiting_decision";
			store.appendInbox({
				kind: "run_awaiting_input", runId: run.id,
				text: `${label} is waiting for your answer in ${where}: ${ev.ask.questionIds.length || "one"} question(s)${ev.ask.title ? ` — "${ev.ask.title}"` : ""}. Answer in that tab and the same run continues.`,
				key: `ask-open:${run.id}:${ev.ask.flowId}`,
			});
			return;
		}
		run.ask = {
			flowId: ev.ask.flowId,
			title: run.ask?.title,
			questionIds: ev.ask.questionIds.length ? ev.ask.questionIds : run.ask?.questionIds ?? [],
			openedAt: run.ask?.openedAt ?? ev.at,
			state: ev.ask.state === "cancelled" ? "cancelled" : "answered",
			closedAt: ev.at,
		};
		if (run.status === "awaiting_decision") run.status = "running";
		store.appendInbox({
			kind: "run_input_answered", runId: run.id,
			text: ev.ask.state === "cancelled"
				? `${label}'s question was cancelled; the worker continues in ${where} and must report a truthful outcome (needs_user if it still needs a decision).`
				: `${label}'s question was answered in ${where}; the same run continues.`,
			key: `ask-close:${run.id}:${ev.ask.flowId}`,
		});
		return;
	}
	// A new turn in the same worker tab after a reported finish: the run was resumed, not re-created.
	if (ev.type === "resumed") {
		if (TERMINAL.includes(run.status)) return;
		run.status = "running";
		store.appendInbox({ kind: "run_resumed", runId: run.id, text: `${run.label} resumed in the same tab after its report`, key: `resumed:${ev.eid}` });
		return;
	}
	// finish
	if (TERMINAL.includes(run.status)) return;
	// The worker reported a result while its modal still looked open, so no closing ask event was recorded. Never keep
	// presenting it as waiting for an answer; the report itself is the truth about the turn.
	if (run.ask?.state === "open") run.ask = { ...run.ask, state: "unresolved", closedAt: ev.at };
	const outcome = ev.outcome ?? "failed";
	const finish = validateFinishSafe({ outcome, summary: ev.summary, evidence: ev.evidence });
	run.finish = { ...finish, at: new Date().toISOString() };
	const label = run.hoja?.identifier ?? run.id;
	const body = [`Claw ${run.id} reported **${finish.outcome}**.`, "", finish.summary, "", ...(finish.evidence.length ? ["Evidence:", ...finish.evidence.map((e) => `- ${e}`)] : ["Evidence: none"])].join("\n");
	queueComment(run, body);
	if (finish.outcome === "completed") {
		run.status = "completed";
		queueState(run, "In Review");
		store.appendInbox({ kind: "run_completed", runId: run.id, text: `${label} completed (In Review, not Done): ${finish.summary}`, key });
	} else if (finish.outcome === "needs_user") {
		run.status = "awaiting_user";
		// The "since" the supervisor repeats, and the tab flag that makes the decision visible in the tab bar.
		run.awaitingSince = run.finish.at;
		store.appendInbox({ kind: "run_needs_user", runId: run.id, text: `${label} needs your decision since ${run.finish.at.slice(11, 16)}Z: ${finish.summary}. Answer with claw_send ${run.id} "<decision>" or claw_cancel ${run.id}.`, key });
	} else {
		run.status = "failed";
		run.failureClass = "worker";
		store.appendInbox({ kind: "run_failed", runId: run.id, text: `${label} failed: ${finish.summary}`, key });
	}
}

/** A completion without evidence is downgraded to failed, even if a worker bypassed validateFinish. */
function validateFinishSafe(input: { outcome: string; summary?: string; evidence?: string[] }): Omit<NonNullable<Run["finish"]>, "at"> {
	try { return validateFinish({ outcome: input.outcome, summary: input.summary ?? "(no summary)", evidence: input.evidence ?? [] }); }
	catch (error) {
		return { outcome: "failed", summary: `completion refused: ${(error as Error).message}`, evidence: [] };
	}
}

/** Hoja writes for one run, in order. Each op is verified by read-back and skipped if already visible (replay safe). */
export async function flushOutbox(run: Run, deps: DaemonDeps): Promise<boolean> {
	let changed = false;
	for (const op of run.outbox) {
		if (op.done) continue;
		if (!run.hoja) { op.done = true; changed = true; continue; }
		try {
			const issueId = run.hoja.issueId;
			const view = await deps.hoja.readIssue(issueId);
			if (op.kind === "comment") {
				if (!view.comments.some((c) => c.includes(opMarker(op.id)))) {
					await deps.hoja.comment(issueId, op.body);
					const after = await deps.hoja.readIssue(issueId);
					if (!after.comments.some((c) => c.includes(opMarker(op.id)))) throw new Error("comment not visible on read-back");
				}
			} else if (view.state.toLowerCase() !== op.state.toLowerCase()) {
				const resolved = await deps.hoja.resolve(run.hoja.project, run.requestedAssignee);
				await deps.hoja.setState(resolved, issueId, op.state);
				const after = await deps.hoja.readIssue(issueId);
				if (after.state.toLowerCase() !== op.state.toLowerCase()) throw new Error(`state read-back is "${after.state}", expected "${op.state}"`);
			}
			op.done = true;
			run.syncError = undefined;
			changed = true;
		} catch (error) {
			run.syncError = `Hoja sync pending (${op.kind}): ${(error as Error).message}`.slice(0, 400);
			return changed;
		}
	}
	return changed;
}

/** Restarts a run whose launch failed and provably created no tab. Same run, same Hoja issue: no duplicate issue or
 *  duplicate worker. The next tick's `continueRun` redoes the tab step. */
async function relaunchLaunch(run: Run, deps: DaemonDeps, reason: string): Promise<void> {
	deps.store.appendInbox({
		kind: "run_recovered", runId: run.id, key: `recovered:${run.id}`,
		text: `${run.hoja?.identifier ?? run.id} recovered: ${reason}. Relaunching the worker tab (same issue, attempt ${(run.relaunchCount ?? 0) + 1}); the earlier failure is not a result.`,
	});
	run.relaunchCount = (run.relaunchCount ?? 0) + 1;
	run.status = "launching";
	run.phase = "issue_created";
	run.error = undefined;
	run.tabCloseError = undefined;
	run.block = undefined;
	run.tab = undefined;
}

export async function reconcileRun(run: Run, deps: DaemonDeps, live: Set<number> | undefined): Promise<void> {
	const { store } = deps;
	const before = JSON.stringify(run);
	const read = store.readEvents(run.id, run.eventsOffset);
	for (const ev of read.items) applyEvent(run, ev, store);
	run.eventsOffset = read.offset;

	if (isActive(run)) {
		let dead = false;
		if (run.pid !== undefined) dead = !deps.alive(run.pid);
		else if (run.block !== undefined && live && !live.has(run.block) && deps.now().getTime() - Date.parse(run.createdAt) > LOST_GRACE_MS) dead = true;
		if (dead) {
			// A worker may have written its last event just before exiting; re-read before declaring it lost.
			const again = store.readEvents(run.id, run.eventsOffset);
			for (const ev of again.items) applyEvent(run, ev, store);
			run.eventsOffset = again.offset;
			// A worker that never reached session_start died starting up (a duplicate extension registration,
			// a bad flag, a missing module). That is a failure with a reason, never a silent "lost" run.
			if (isActive(run) && neverStarted(run)) failStartup(run, deps);
			else if (isActive(run)) {
				run.status = "lost";
				run.error = run.ask?.state === "open"
					? "worker stopped without claw_finish while its own question modal was still open (process or tab gone); the decision was never answered"
					: "worker stopped without claw_finish (process or tab gone)";
				if (run.ask?.state === "open") run.ask = { ...run.ask, state: "unresolved", closedAt: deps.now().toISOString() };
				queueComment(run, `Claw: ${run.error}. No completion is implied.`);
				store.appendInbox({ kind: "run_lost", runId: run.id, text: `${run.label} lost: ${run.error}`, key: `lost:${run.id}` });
			}
		}
	}
	// An unanswered modal is a live wait, not an idle run: remind once (deduped by key) instead of letting it look silent.
	if (run.ask?.state === "open" && deps.now().getTime() - Date.parse(run.ask.openedAt) >= ASK_STALE_MS) {
		const minutes = Math.round((deps.now().getTime() - Date.parse(run.ask.openedAt)) / 60_000);
		store.appendInbox({
			kind: "run_awaiting_input", runId: run.id,
			text: `${run.hoja?.identifier ?? run.id} has waited ${minutes} min for an answer in its own tab; the run is still active and continues there. If the question is no longer wanted, cancel the run (claw_cancel) instead of leaving it open.`,
			key: `ask-stale:${run.id}:${run.ask.flowId}`,
		});
	}
	if (run.status === "launching" && deps.now().getTime() - Date.parse(run.createdAt) > LAUNCH_TIMEOUT_MS) {
		const unknown = run.phase === "create_dispatched" ? "; the Hoja create outcome was unknown, so a late issue carrying the run marker may exist and needs a manual check" : "";
		const captured = startupFailureReason(store.readWorkerLog(run.id));
		failRun(run, deps, `launch timed out after ${LAUNCH_TIMEOUT_MS / 1000}s in phase ${run.phase} with no worker started event${captured ? `; worker stderr: ${captured}` : ""}${unknown}`);
		run.failureClass = "launch";
	}
	// Self-supervision owns terminal tab close, the idle/stall bound, decision reminders and bounded recovery. It gets
	// the Tern snapshot even when it is undefined (a failed snapshot must not silently cancel the close).
	await superviseRun(run, {
		store, hoja: deps.hoja, tern: deps.tern, workspace: deps.workspace, now: () => deps.now(), alive: deps.alive,
		slo: deps.slo ?? store.readControl().supervise,
		noTabCarries: async (runId) => (await findRunBlock(deps.tern, runId)) === undefined,
		relaunch: (r, reason) => relaunchLaunch(r, deps, reason),
	}, live);
	if (run.outbox.some((o) => !o.done)) await flushOutbox(run, deps);
	if (JSON.stringify(run) !== before) store.saveRun(run);
}

export async function fireTriggers(deps: DaemonDeps, enabled: boolean): Promise<void> {
	const { store } = deps;
	const now = deps.now();
	for (const t of store.listTriggers()) {
		if (!t.enabled || !enabled) continue;
		if (t.retryAt && Date.parse(t.retryAt) > now.getTime()) continue;
		let due: { scheduled: string; key: string } | undefined;
		if (t.when.kind === "on_exit") {
			const run = store.getRun(t.when.runId);
			if (run && TERMINAL.includes(run.status) && (t.when.on ?? ["completed"]).includes(run.status)) due = { scheduled: run.updatedAt, key: `${t.id}@${run.id}` };
		} else if (t.nextFireAt && Date.parse(t.nextFireAt) <= now.getTime()) {
			due = { scheduled: t.nextFireAt, key: `${t.id}@${t.nextFireAt}` };
		}
		if (!due) continue;
		try {
			let runId: string | undefined;
			if (t.action.kind === "spawn") {
				const { task, project, assignee, label, cwd } = t.action;
				runId = (await startRun({ task, project, assignee, label, cwd }, deps, { fireKey: due.key, trigger: t.id })).id;
			} else {
				store.appendInbox({ kind: "notify", triggerId: t.id, text: t.action.message, key: due.key });
			}
			store.appendInbox({ kind: "trigger_fired", triggerId: t.id, runId, text: `trigger ${t.id} fired${runId ? ` -> ${runId}` : ""}`, key: `fired:${due.key}` });
			t.fired++;
			t.lastFiredAt = now.toISOString();
			t.lastRunId = runId ?? t.lastRunId;
			t.lastError = undefined;
			t.retryAt = undefined;
			t.nextFireAt = t.when.kind === "cron" ? nextCronTime(t.when.cron, now).toISOString() : undefined;
			if (t.when.kind !== "cron" || t.once) t.enabled = false;
		} catch (error) {
			t.lastError = (error as Error).message.slice(0, 300);
			t.retryAt = new Date(now.getTime() + TRIGGER_RETRY_MS).toISOString();
		}
		store.saveTrigger(t);
	}
}

/** One pass. Order matters: requests first so a fresh spawn is visible this tick; triggers last. */
export async function tick(deps: DaemonDeps): Promise<{ ternAvailable: boolean }> {
	const { store, tern } = deps;
	await processRequests(deps);
	for (const run of store.listRuns()) {
		if (TERMINAL.includes(run.status)) continue;
		if (run.reconcileAt && Date.parse(run.reconcileAt) > deps.now().getTime()) continue;
		if (run.phase === "intent" || run.phase === "create_dispatched" || run.phase === "issue_created" || run.phase === "tab_opening") await continueRun(run, deps);
	}
	let live: Set<number> | undefined;
	let ternAvailable = true;
	try { live = await liveBlocks(tern); } catch { ternAvailable = false; }
	for (const run of store.listRuns()) {
		await reconcileRun(run, deps, live);
	}
	// SLO S4: one digest per window instead of a wake-up per notice, and an all-clear while work is in progress.
	flushDigest(store, deps.now().getTime(), sloFrom(deps.slo ?? store.readControl().supervise));
	await fireTriggers(deps, store.readControl().enabled);
	return { ternAvailable };
}

/** Work that keeps the daemon alive: runs in flight, triggers, requests, and every obligation the supervisor still
 *  owes (a scheduled retry, an undelivered digest, an unclosed tab). Without the last group a retry window could end
 *  with the daemon exiting, which is how a failed tab close used to be forgotten. */
export function hasWork(store: ClawStore): boolean {
	return store.listRuns().some(isActive) || store.listTriggers().some((t) => t.enabled) || store.listRequests().length > 0 || supervisionPending(store);
}

export async function runDaemon(deps: DaemonDeps, options: { tickMs?: number; idleExitMs?: number; log?: (line: string) => void; stopSignal?: AbortSignal } = {}): Promise<void> {
	const { store } = deps;
	const log = options.log ?? (() => undefined);
	let idleSince = deps.now().getTime();
	while (!options.stopSignal?.aborted) {
		if (!heartbeat(store)) { log("lock lost to another daemon; exiting"); return; }
		try {
			await tick(deps);
		} catch (error) {
			log(`tick failed: ${(error as Error).message}`);
		}
		if (hasWork(store)) idleSince = deps.now().getTime();
		else if (deps.now().getTime() - idleSince >= (options.idleExitMs ?? IDLE_EXIT_MS)) { releaseLock(store); log("idle; exiting"); return; }
		await new Promise((resolve) => setTimeout(resolve, options.tickMs ?? TICK_MS));
	}
}

/** Starts the daemon detached so it outlives the orchestrator. Losing the singleton claim just makes it exit. */
export function startDaemonProcess(workspace: string, store: ClawStore, daemonMain: string): void {
	const out = openSync(store.logPath, "a");
	const child = spawnChild(process.execPath, ["--experimental-strip-types", "--no-warnings", daemonMain, workspace], {
		cwd: workspace, detached: true, stdio: ["ignore", out, out], env: process.env,
	});
	child.unref();
}

