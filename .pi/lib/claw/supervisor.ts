/** Self-supervision for /claw: the daemon enforces written SLOs instead of the human prompting check-ups.
 *
 *  SLOs (docs/claw/slo-2026-10-22.md; every bound is a constant below and can be tightened per workspace):
 *  S1  Bound to a terminal state. A launch reaches `running` within launchMs; a worker tab that never reports
 *      `started` is named once and failed at launchMs; an `idle` run is reported stalled after idleNudgeMs and failed
 *      with a real reason after idleFailMs. No run is left non-terminal with no deadline.
 *  S2  No orphan tabs. Every terminal run's worker tab is closed within tabCloseSloMs, retried with jittered backoff
 *      (tabCloseBudget attempts) even when the Tern snapshot itself fails; when it still cannot be closed, one
 *      `run_tab_orphan` item says which block to close by hand. A `lost` run is closed when Tern confirms the block.
 *  S3  Act at most once per run per state. Each act is a remedy keyed `<action>:<state>` on the run with an attempt
 *      count, a jittered next-due time and a budget; the budget's end is reported once, never looped.
 *  S4  Silence means healthy. `run_started`/`run_idle` become notices folded into one `claw_digest` per digestMs; an
 *      all-clear `claw_heartbeat` at most once per heartbeatMs while work is in progress.
 *  S5  A decision is surfaced, not idled on. `awaiting_user` records awaitingSince, flags the worker tab, and reports
 *      what is needed and since when; reminders are bounded by needsUserReminderBudget. The worker-local ask modal is
 *      TREBOL-308's job; this only makes the run visible and bounded.
 *  S6  Recoverable faults are recovered. A launch that provably created no tab is retried once (same run, same Hoja
 *      issue); a `create_dispatched` lookup is retried with backoff and never re-sends the create; a failed tab close
 *      is retried. A worker with no `started` event is deliberately not relaunched: it may have executed the task
 *      without its claw extension, so duplicating it is unsafe.
 */
import { closeBlock, isBlockGone, renameTabOf, sendToBlock, type TernExec } from "./launcher.ts";
import { queueComment, type LaunchDeps } from "./spawn.ts";
import type { ClawStore, Notice, Run, RunStatus } from "./store.ts";
import { backoffMs, jitterFraction, recordAttempt, remedyDue, remedyKey } from "./remedy.ts";

export { backoffMs, jitterFraction, recordAttempt, remedyDue, remedyKey };

export type SloConfig = {
	/** A launching run older than this is failed with a reason (no worker ever reported started). */
	launchMs: number;
	/** A worker tab open this long with no `started` event is named once: the worker may have failed to load. */
	startedMs: number;
	/** An idle run this long after its last settle is reported stalled (once per episode). */
	idleNudgeMs: number;
	/** An idle run this long is failed by the supervisor with a real reason. `claw_send` resets the clock. */
	idleFailMs: number;
	/** `report` names the next command; `send` also types one nudge into the tab (off by default: a permission modal
	 *  may own the keyboard, and approving for a human is not the supervisor's decision). */
	idleAction: "report" | "send";
	/** Attempts before a worker tab is declared orphaned and reported. */
	tabCloseBudget: number;
	tabCloseBaseMs: number;
	tabCloseCapMs: number;
	/** One collapsed digest per window. */
	digestMs: number;
	/** At most one all-clear item per window while work is in progress. */
	heartbeatMs: number;
	/** How often a still-awaiting decision is repeated (inside a digest, never a wake-up per repeat). */
	needsUserReminderMs: number;
	needsUserReminderBudget: number;
};

export const DEFAULT_SLO: SloConfig = {
	launchMs: 5 * 60_000,
	startedMs: 90_000,
	idleNudgeMs: 10 * 60_000,
	idleFailMs: 60 * 60_000,
	idleAction: "report",
	tabCloseBudget: 5,
	tabCloseBaseMs: 2_000,
	tabCloseCapMs: 20_000,
	digestMs: 5 * 60_000,
	heartbeatMs: 30 * 60_000,
	needsUserReminderMs: 30 * 60_000,
	needsUserReminderBudget: 3,
};

/** Worker tabs of these runs are the daemon's to close. `lost` is included: its worker is gone, so whatever the tab
 *  shows is a corpse. Only blocks the daemon recorded itself are ever closed. */
export const CLOSE_ON_END: readonly RunStatus[] = ["completed", "cancelled", "failed", "lost"];

/** A per-workspace override from control.json `supervise`, validated so a typo cannot disable a bound. */
export function sloFrom(override: Record<string, unknown> | undefined): SloConfig {
	const slo = { ...DEFAULT_SLO };
	if (!override) return slo;
	for (const key of Object.keys(DEFAULT_SLO) as (keyof SloConfig)[]) {
		if (key === "idleAction") {
			const action = override.idleAction;
			if (action === "report" || action === "send") slo.idleAction = action;
			continue;
		}
		const value = (override as Record<string, unknown>)[key];
		if (typeof value === "number" && Number.isFinite(value) && value >= 0) (slo as Record<string, unknown>)[key] = value;
	}
	return slo;
}

/** Closes a run's worker tab once. A block Tern no longer has is already closed, not an error. Only blocks the daemon
 *  recorded from its own tab launch or run-id lookup ever reach this. */
export async function closeRunTab(run: Run, tern: TernExec): Promise<void> {
	if (run.block === undefined || run.tabClosedAt) return;
	try { await closeBlock(tern, run.block); }
	catch (error) { if (!isBlockGone(error)) throw error; }
	run.tabClosedAt = new Date().toISOString();
	run.tabCloseError = undefined;
}

const minutes = (ms: number) => Math.max(0, Math.round(ms / 60_000));
const clock = (iso: string | undefined) => (iso ? `${iso.slice(11, 16)}Z` : "unknown");
export const runName = (run: Run) => `${run.hoja?.identifier ?? run.id}${run.label ? ` ${run.label}` : ""}`.slice(0, 80);

export type SuperviseDeps = LaunchDeps & {
	now: () => Date;
	alive: (pid: number) => boolean;
	slo?: Partial<SloConfig>;
	/** Proves that no Tern block carries this run id, so a failed launch can be retried without duplicating a tab. */
	noTabCarries?: (runId: string) => Promise<boolean>;
	/** Restarts this run's launch (same run, same Hoja issue) after a failure that provably created no tab. */
	relaunch?: (run: Run, reason: string) => Promise<void>;
};

/** S2: close the tab, retry with backoff, and report an orphan once the budget is spent. Never gated on the Tern
 *  snapshot: a failed snapshot is exactly the case that used to leave the tab open with no notice. */
async function superviseTabClose(run: Run, deps: SuperviseDeps, live: Set<number> | undefined, nowMs: number, slo: SloConfig): Promise<void> {
	if (run.block === undefined || run.tabClosedAt) return;
	const key = remedyKey("tab-close");
	if (!remedyDue(run, key, nowMs)) return;
	try {
		await closeRunTab(run, deps.tern);
		if (run.remedies?.[key]) delete run.remedies[key];
		return;
	} catch (error) {
		run.tabCloseError = `tab close failed: ${(error as Error).message}`.slice(0, 300);
		const why = `the close failed ${1 + (run.remedies?.[key]?.attempts ?? 0)} time(s); last error: ${(error as Error).message.slice(0, 200)}`;
		const { attempts, exhausted } = recordAttempt(run, key, nowMs, { budget: slo.tabCloseBudget, baseMs: slo.tabCloseBaseMs, capMs: slo.tabCloseCapMs, note: why });
		if (!exhausted) return; // retried with backoff; no Hoja comment per attempt
		queueComment(run, `Claw: could not close the worker tab after ${attempts} attempts. ${run.tabCloseError}`);
		deps.store.appendInbox({
			kind: "run_tab_orphan", runId: run.id, key: `tab-orphan:${run.id}`,
			text: `${runName(run)} is ${run.status} but its worker tab (block ${run.block}) is still open after ${attempts} close attempts: ${(error as Error).message.slice(0, 200)}. Close it by hand: tern close ${run.block}`,
		});
	}
}

/** S1: a stuck idle run is named once, then failed with a reason. `claw_send` clears idleSince, which is the escape
 *  hatch for a worker a human wants to keep waiting. */
async function superviseIdle(run: Run, deps: SuperviseDeps, nowMs: number, slo: SloConfig): Promise<void> {
	const since = Date.parse(run.idleSince ?? run.updatedAt);
	const idleMs = nowMs - since;
	if (idleMs >= slo.idleFailMs) {
		const reason = `stalled: idle ${minutes(idleMs)}m with no claw_finish${run.stalledAt ? ` after a stall report at ${clock(run.stalledAt)}` : ""}; the supervisor ended it so the run cannot hang forever. Work is in ${run.sessionFile ?? "the worker's session"}`;
		run.status = "failed";
		run.failureClass = "stalled";
		run.error = reason.slice(0, 500);
		run.reconcileAt = undefined;
		queueComment(run, `Claw: ${run.error}. No completion is implied.`);
		deps.store.appendInbox({
			kind: "run_failed", runId: run.id, key: `fail:${run.id}`,
			text: `${runName(run)} failed: ${reason}. Not a completion; no Hoja state change.`,
		});
		return;
	}
	if (idleMs < slo.idleNudgeMs) return;
	if (!run.stalledAt) {
		run.stalledAt = new Date(nowMs).toISOString();
		deps.store.appendInbox({
			kind: "run_stalled", runId: run.id, key: `stall:${run.id}:${run.idleSince ?? run.updatedAt}`,
			text: `${runName(run)} stalled: idle ${minutes(idleMs)}m with no claw_finish (pid ${run.pid ?? "unknown"}, tab ${run.block === undefined ? "none" : run.block}). Needs a decision: claw_send ${run.id} "continue" to re-arm it, or claw_cancel ${run.id}. The supervisor fails it at ${new Date(Date.parse(run.idleSince ?? run.updatedAt) + slo.idleFailMs).toISOString().slice(11, 16)}Z.`,
		});
	}
	if (slo.idleAction !== "send") return;
	if (run.block === undefined) return;
	const key = remedyKey("idle-nudge", run.idleSince ?? run.updatedAt);
	if (!remedyDue(run, key, nowMs)) return;
	try {
		await sendToBlock(deps.tern, run.block, `Claw: you settled a turn ${minutes(idleMs)}m ago without calling claw_finish. Call claw_finish now (completed with evidence, failed, or needs_user), or state in one line what blocks you.`);
		recordAttempt(run, key, nowMs, { budget: 2, baseMs: 60_000, capMs: 300_000 });
	} catch (error) {
		const { exhausted } = recordAttempt(run, key, nowMs, { budget: 2, baseMs: 60_000, capMs: 300_000, note: (error as Error).message.slice(0, 200) });
		if (exhausted) deps.store.appendNotice({ kind: "run_stalled", runId: run.id, key: `stall-nudge-failed:${run.id}:${run.idleSince ?? run.updatedAt}`, text: `${runName(run)}: the supervisor could not nudge its tab (${(error as Error).message.slice(0, 160)}); the stall report above still applies` });
	}
}

/** S5: make a pending decision visible in the tab bar and repeat it in bounded digests. The in-tab ask modal is
 *  TREBOL-308's; this never types into a tab that may be showing one. */
async function superviseAwaitingUser(run: Run, deps: SuperviseDeps, nowMs: number, slo: SloConfig): Promise<void> {
	const since = run.awaitingSince ?? run.finish?.at;
	if (!since) return;
	const waitedMs = nowMs - Date.parse(since);
	if (run.block !== undefined && remedyDue(run, remedyKey("decision-flag", since), nowMs)) {
		const name = `! ${run.hoja?.identifier ?? run.label} decide`.slice(0, 40);
		try {
			await renameTabOf(deps.tern, run.block, name);
			recordAttempt(run, remedyKey("decision-flag", since), nowMs, { budget: 1, baseMs: 1_000, capMs: 1_000 });
		} catch (error) {
			const { exhausted } = recordAttempt(run, remedyKey("decision-flag", since), nowMs, { budget: 1, baseMs: 1_000, capMs: 1_000, note: (error as Error).message.slice(0, 160) });
			if (exhausted) deps.store.appendNotice({ kind: "run_needs_user", runId: run.id, key: `decision-flag-failed:${run.id}:${since}`, text: `${runName(run)}: could not flag its tab (${(error as Error).message.slice(0, 160)})` });
		}
	}
	const key = remedyKey("decision-remind", since);
	if (waitedMs < slo.needsUserReminderMs || !remedyDue(run, key, nowMs)) return;
	const { exhausted } = recordAttempt(run, key, nowMs, { budget: slo.needsUserReminderBudget, baseMs: slo.needsUserReminderMs, capMs: slo.needsUserReminderMs });
	const last = exhausted ? "" : " Further reminders stop after the budget; the run stays awaiting_user until answered.";
	deps.store.appendNotice({
		kind: "run_needs_user", runId: run.id, key: `decision-remind:${run.id}:${since}`,
		text: `${runName(run)} still needs your decision, waiting ${minutes(waitedMs)}m since ${clock(since)}: ${run.finish?.summary ?? "(no summary)"}. Answer with claw_send ${run.id} "<decision>" or claw_cancel ${run.id}.${last}`,
	});
}

/** Why this run can still be restarted, or undefined. Only cases where nothing observable was produced are recoverable:
 *  no reported result, no settled turn, and a phase whose side effects are known (an issue, never an ambiguous create). */
export function recoveryReason(run: Run, nowMs: number): { reason: string; expired: boolean } | undefined {
	if ((run.relaunchCount ?? 0) >= 1) return undefined;
	if (run.finish) return undefined;              // a reported result is final
	if (run.settles > 0) return undefined;         // the worker produced a turn; a retry could duplicate its work
	if (run.ask) return undefined;                 // it interacted with a human: that is a decision, not a retry
	const expired = run.deadline !== undefined && nowMs > Date.parse(run.deadline);
	// A launch step failed before any tab existed: nothing was executed, so the tab step is safe to redo.
	if (run.status === "failed" && run.failureClass === "launch" && run.phase === "issue_created") {
		return { reason: "the launch failed before any worker tab existed", expired };
	}
	// The worker died after its tab opened but before a single settled turn: its events prove no turn completed.
	if (run.status === "lost" && run.settles === 0 && run.phase === "tab_open") {
		return { reason: "the worker stopped before its first settled turn", expired };
	}
	return undefined;
}

/** S6: restart a run that provably produced nothing. Same run, same Hoja issue (no duplicate issue), one attempt.
 *  A run stuck past its own deadline is recovered too: the retry gets a fresh bound instead of being refused, and the
 *  extension is named in the recovery notice. When no restart is possible the reason is recorded once. */
async function superviseRecovery(run: Run, deps: SuperviseDeps, nowMs: number, slo: SloConfig): Promise<void> {
	const candidate = recoveryReason(run, nowMs);
	if (!candidate) return;
	const key = remedyKey("relaunch", "once");
	if (!remedyDue(run, key, nowMs)) return;
	// A run stuck past its own deadline is not restarted: no worker may start after the request expired. It is failed
	// with that reason (already on the run) and the spent recovery budget is recorded once, so it is never silent.
	if (candidate.expired) {
		const why = `the request's deadline (${run.deadline}) passed before the run could be restarted; no worker starts after expiry`;
		recordAttempt(run, key, nowMs, { budget: 1, baseMs: slo.tabCloseBaseMs, capMs: slo.tabCloseCapMs, note: why });
		recordBudgetSpent(deps, run, "relaunch", why);
		return;
	}
	if (!deps.noTabCarries || !deps.relaunch) return;
	let clear: boolean;
	try { clear = await deps.noTabCarries(run.id); }
	catch { return; } // Tern unreadable is not proof either way; try again on the next tick.
	if (!clear) {
		const why = "a Tern block still carries this run id, so a retry could duplicate the tab; inspect that tab instead";
		recordAttempt(run, key, nowMs, { budget: 1, baseMs: slo.tabCloseBaseMs, capMs: slo.tabCloseCapMs, note: why });
		recordBudgetSpent(deps, run, "relaunch", why);
		return;
	}
	recordAttempt(run, key, nowMs, { budget: 1, baseMs: slo.tabCloseBaseMs, capMs: slo.tabCloseCapMs, note: candidate.reason });
	await deps.relaunch(run, `${candidate.reason} and no block carries ${run.id}`);
}

/** A spent budget is a record, not a retry: one item naming the act, the reason and what a human can do. Deduped by act,
 *  so a run that keeps being evaluated never repeats it. */
function recordBudgetSpent(deps: SuperviseDeps, run: Run, action: string, reason: string): void {
	deps.store.appendInbox({
		kind: "run_budget_spent", runId: run.id, key: `budget:${action}:${run.id}`,
		text: `${runName(run)}: automatic ${action} stopped after its retry budget; ${reason}. The run stays ${run.status}${run.block !== undefined ? ` with tab ${run.block}` : ""}${run.sessionFile ? `; session ${run.sessionFile}` : ""}. Next step is a human decision, not another retry.`,
	});
}

/** One pass for one run. Pure decision logic over the persisted run plus the Tern snapshot; the daemon saves the run. */
export async function superviseRun(run: Run, deps: SuperviseDeps, live: Set<number> | undefined): Promise<void> {
	const slo = sloFrom(deps.slo);
	const now = deps.now();
	const nowMs = now.getTime();

	if (run.block !== undefined && !run.tabClosedAt && (CLOSE_ON_END.includes(run.status) || run.status === "lost")) {
		await superviseTabClose(run, deps, live, nowMs, slo);
	}
	if (run.status === "idle") await superviseIdle(run, deps, nowMs, slo);
	if (run.status === "awaiting_user") await superviseAwaitingUser(run, deps, nowMs, slo);
	if (run.status === "failed" || run.status === "lost") await superviseRecovery(run, deps, nowMs, slo);

	// S1: a tab that opened but never reported `started` is named once. It is not relaunched: the worker may have run
	// the task without its claw extension, so a second copy could duplicate side effects.
	const ageMs = nowMs - Date.parse(run.createdAt);
	if ((run.status === "launching" || run.status === "running") && run.phase === "tab_open" && run.block !== undefined && run.pid === undefined && run.settles === 0 && ageMs >= slo.startedMs) {
		deps.store.appendNotice({
			kind: "run_stalled", runId: run.id, key: `no-started:${run.id}`,
			text: `${runName(run)}: tab ${run.block} opened ${minutes(ageMs)}m ago but the worker never reported started (pid unknown); check the tab. The supervisor fails it at ${new Date(Date.parse(run.createdAt) + slo.launchMs).toISOString().slice(11, 16)}Z unless it starts.`,
		});
	}
	// A running worker whose tab disappeared is reported, never re-attached: pi cannot be moved into a new block.
	const active = !CLOSE_ON_END.includes(run.status) && run.status !== "lost";
	if (active && run.pid !== undefined && run.block !== undefined && live !== undefined && !live.has(run.block) && !run.tabMissingAt) {
		run.tabMissingAt = now.toISOString();
		deps.store.appendNotice({
			kind: "run_stalled", runId: run.id, key: `tab-missing:${run.id}`,
			text: `${runName(run)}: its worker tab (block ${run.block}) is gone while the worker (pid ${run.pid}) is still alive; output still lands in the run record. Use claw_send only if the tab exists, or claw_cancel to stop it.`,
		});
	}
}

/** S4: fold notices into one digest, and publish an all-clear only when there is work in progress. */
export function flushDigest(store: ClawStore, nowMs: number, slo: SloConfig): { digested: number; heartbeat: boolean } {
	const state = store.readSupervisor();
	const read = store.readNotices(state.noticesOffset);
	const nowIso = new Date(nowMs).toISOString();
	let digested = 0;
	if (read.items.length) {
		const first = read.items[0].id;
		digested = read.items.length;
		store.appendInbox({ kind: "claw_digest", key: `digest:${first}`, text: digestText(read.items, nowMs) });
		store.writeSupervisor({
			...state, noticesOffset: read.offset, lastDigestAt: nowIso,
			digests: state.digests + 1, notices: state.notices + digested, lastTickAt: nowIso,
		});
		return { digested, heartbeat: false };
	}
	const sinceHeartbeat = state.lastHeartbeatAt ? nowMs - Date.parse(state.lastHeartbeatAt) : Number.POSITIVE_INFINITY;
	const runs = store.listRuns();
	// Only a worker that is actually working warrants an all-clear: a pending decision is already reported, and an idle
	// run is the subject of a stall report, so repeating "healthy" over those would be the noise this SLO removes.
	const active = runs.filter((r) => r.status === "launching" || r.status === "running");
	const awaiting = runs.filter((r) => r.status === "awaiting_user");
	// The first window starts the heartbeat clock instead of firing immediately: a daemon start is not health news.
	if (!state.lastHeartbeatAt) {
		store.writeSupervisor({ ...state, lastTickAt: nowIso, lastHeartbeatAt: nowIso });
		return { digested: 0, heartbeat: false };
	}
	if (sinceHeartbeat < slo.heartbeatMs || active.length === 0) {
		store.writeSupervisor({ ...state, lastTickAt: nowIso });
		return { digested: 0, heartbeat: false };
	}
	store.appendInbox({
		kind: "claw_heartbeat", key: `heartbeat:${nowIso.slice(0, 16)}`,
		text: `claw healthy: ${active.length} working${awaiting.length ? `, ${awaiting.length} awaiting a decision` : ""}; no supervision anomalies since ${state.lastDigestAt ? clock(state.lastDigestAt) : "startup"}. Supervisor alive, ${state.digests} digest(s) so far.`,
	});
	store.writeSupervisor({ ...state, lastHeartbeatAt: nowIso, lastTickAt: nowIso });
	return { digested: 0, heartbeat: true };
}

/** One header of counts plus up to eight per-run lines; the rest is a count, so a busy window stays readable. */
export function digestText(notices: Notice[], nowMs: number): string {
	const counts: Record<string, number> = {};
	for (const n of notices) counts[n.kind] = (counts[n.kind] ?? 0) + 1;
	const groups = new Map<string, { label: string; kinds: Record<string, number> }>();
	for (const n of notices) {
		const key = n.runId ?? n.kind;
		const group = groups.get(key) ?? { label: n.text.split(":")[0].slice(0, 60), kinds: {} };
		const kind = n.kind.replace(/^run_/, "");
		group.kinds[kind] = (group.kinds[kind] ?? 0) + 1;
		groups.set(key, group);
	}
	const head = Object.entries(counts).map(([kind, n]) => `${n}× ${kind.replace(/^run_/, "")}`).join(", ");
	const lines = [...groups.values()].slice(0, 8).map((g) => `- ${g.label}: ${Object.entries(g.kinds).map(([kind, n]) => (n > 1 ? `${kind}×${n}` : kind)).join(", ")}`);
	const more = groups.size > 8 ? [`- and ${groups.size - 8} more run(s); claw_list has every row`] : [];
	return [`Claw digest ${new Date(nowMs).toISOString().slice(11, 16)}Z: ${notices.length} notice(s) — ${head}`, ...lines, ...more].join("\n");
}

/** Work the supervisor still owes: retries, unclosed tabs, undigested notices. Keeps the daemon alive across a retry
 *  window instead of exiting and forgetting, which is how retries used to be lost. */
export function supervisionPending(store: ClawStore): boolean {
	const state = store.readSupervisor();
	if (store.readNotices(state.noticesOffset).items.length > 0) return true;
	return store.listRuns().some((run) => {
		if (run.status === "awaiting_user") return run.block !== undefined && redeemable(run, "decision-flag") || redeemable(run, "decision-remind");
		if (run.block !== undefined && !run.tabClosedAt && (CLOSE_ON_END.includes(run.status) || run.status === "lost")) return redeemable(run, "tab-close");
		if (run.status === "idle") return true;
		if (run.status === "failed" && run.failureClass === "launch" && run.phase === "issue_created") return (run.relaunchCount ?? 0) < 1 && redeemable(run, "relaunch");
		return false;
	});
}

/** A remedy that may still run: never started, or budget left and scheduled. */
function redeemable(run: Run, action: string): boolean {
	const entries = Object.entries(run.remedies ?? {}).filter(([key]) => key === action || key.startsWith(`${action}:`));
	if (!entries.length) return true;
	return entries.some(([, remedy]) => !remedy.done && !remedy.exhausted);
}
