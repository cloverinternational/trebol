/** Keep a finished run reachable: resume it into the same conversation instead of losing it when its tab closes.
 *
 *  A Claw run owns one pi session file (the worker wrote it in its `started` event). A resume reopens exactly that file
 *  (`pi --session <path>`, see launcher.ts) in a new worker tab, so the agent keeps its history and context, while the
 *  run, its Hoja issue and its event stream stay the same: no second issue, no duplicate run.
 *
 *  Refusals are explicit and come before any side effect: a live worker is never signalled or shadowed, a run with no
 *  session file (or one whose file is gone) is refused with a fresh-relaunch instruction, a resume already in flight is
 *  not repeated, a run whose Hoja issue was deleted is not continued, and the retry ledger (remedy.ts) stops a
 *  repeatedly failing resume with one recorded reason instead of looping.
 *
 *  Always-on goal: a terminal run's goal ended with it (goal.ts endGoal). A resume arms the next generation of that same
 *  goal — same condition, one run record, the ended generation kept in its history — and writes the spec before the tab
 *  opens. Keep-open never revives or extends a goal: it only leaves the tab for a human. */
import { existsSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { rearmGoal } from "./goal.ts";
import { clawSession, launchTab } from "./launcher.ts";
import { describePlan } from "./launch-plan.ts";
import { preflightLaunch } from "./preflight.ts";
import { recordAttempt, remedyKey } from "./remedy.ts";
import { queueComment, tabNameFor, type LaunchDeps } from "./spawn.ts";
import type { Run } from "./store.ts";
import { bootedAfter, type ProcessIdentity } from "./process.ts";

/** A resume whose tab call has not finished within this window is stale (the daemon died mid-resume) and may be retried. */
export const RESUME_INFLIGHT_MS = 120_000;
/** Resume attempts before the ledger records the reason and stops retrying. */
export const RESUME_BUDGET = 3;

/** The run field name the resume ledger uses: `<action>:<state>`, exactly like every other bounded act. */
export const RESUME_KEY = remedyKey("resume");

export type ResumeFacts = {
	/** Is this worker pid a live process? */
	alive: (pid: number) => boolean;
	/** The pid's identity (start token and argv). Absent means it cannot be read, never that the process is gone. */
	identity?: (pid: number) => ProcessIdentity | undefined;
	/** When this host booted (epoch ms). A worker that reported before the boot is provably gone, whatever its pid does now. */
	bootedAt?: number;
	/** Blocks Tern reports as live, when the caller has a snapshot. Undefined means "not known", never "dead". */
	live?: Set<number>;
	sessionExists: (path: string) => boolean;
	nowMs: number;
};

export type ResumeDeps = LaunchDeps & {
	alive: (pid: number) => boolean;
	identity?: (pid: number) => ProcessIdentity | undefined;
	bootedAt?: number;
	now: () => Date;
	sessionExists?: (path: string) => boolean;
	/** Tern's live blocks, when the caller already has a snapshot. Undefined means "not known", never "nothing alive". */
	live?: Set<number>;
};

const fileExists = (path: string) => existsSync(path);

/** Statuses in which a worker may still own this run's conversation. A resume of one of these has to prove the worker is
 *  gone first, because two processes on one session file would fork the same history. */
const ACTIVE_STATUSES: readonly Run["status"][] = ["launching", "running", "idle", "awaiting_decision"];

/** One verdict about one run's worker: `alive`, `dead`, or `unknown` (which is never treated as dead). Both `claw_list`
 *  and `claw_resume` must use this function — two liveness answers for one run is the defect behind TREBOL-388. */
export type RunLiveness = { state: "alive" | "dead" | "unknown"; why: string };

/** Is the worker that owns this run running right now?
 *
 *  A recorded pid is authoritative when identity can be checked: a different kernel start token, a different argv, or
 *  a worker recorded on an earlier host boot all mean the number now belongs to somebody else (or to nobody). A live
 *  Tern block is only evidence for a run that never recorded a pid, because a restored or recycled block says nothing
 *  about the process that used to own it. */
export function runLiveness(run: Run, facts: Omit<ResumeFacts, "sessionExists">): RunLiveness {
	const pid = run.pid;
	if (pid !== undefined) {
		const worker = run.worker;
		// Decisive and cheap: a worker that reported before this host booted cannot be running, whatever this pid is
		// doing now. This is the reboot case, and it also covers records written before identity was stored.
		const lastSeen = worker?.seenAt ?? run.lastResumeAt ?? run.launchStartedAt ?? run.createdAt;
		if (bootedAfter(facts.bootedAt, lastSeen)) return { state: "dead", why: `the host rebooted at ${new Date(facts.bootedAt!).toISOString()} after pid ${pid} last reported (${lastSeen})` };
		if (!facts.alive(pid)) return { state: "dead", why: `pid ${pid} is not running` };
		// No identity probe in this caller: the pid and the boot check above are all the evidence there is, which is the
		// behaviour every call site had before identity existed. Production always supplies one (daemon-main.ts).
		if (!facts.identity) return { state: "alive", why: `pid ${pid} is running` };
		// A run recorded before identity was stored: same boot, live pid, no start token to compare. Trust the pid (the
		// boot check already ruled out the reboot case); inventing "dead" here would strand every older run.
		if (!worker) return { state: "alive", why: `pid ${pid} is running (this run has no recorded start token; it predates process identity)` };
		const current = facts.identity?.(pid);
		if (current === undefined) return { state: "unknown", why: `pid ${pid} is alive but its start time and command cannot be read` };
		if (worker.start !== undefined && current.start !== worker.start) {
			return { state: "dead", why: `pid ${pid} was reused: the live process has start ${current.start}, the worker had ${worker.start}` };
		}
		if (worker.commandHash !== undefined && current.commandHash !== undefined && worker.commandHash !== current.commandHash) {
			return { state: "dead", why: `pid ${pid} was reused: it is running another command (${(current.command ?? "").slice(0, 120)})` };
		}
		if (worker.start === undefined && worker.commandHash === undefined) return { state: "unknown", why: `run ${run.id} recorded no process identity for pid ${pid}` };
		return { state: "alive", why: `pid ${pid} is this run's worker (start ${current.start})` };
	}
	if (run.block === undefined) return { state: "unknown", why: "no worker process and no worker tab is recorded" };
	if (facts.live === undefined) return { state: "unknown", why: "the Tern snapshot is unavailable, so its tab cannot be checked" };
	if (facts.live.has(run.block)) return { state: "alive", why: `tab block ${run.block} is open` };
	return { state: "dead", why: `tab block ${run.block} is gone` };
}

/** Why this run cannot be resumed, or undefined when it can. Pure: no side effect, no throw, usable by a read-only
 *  listing as well as by the daemon. Order matters: a live run is refused before anything else. */
export function resumeRefusal(run: Run, facts: ResumeFacts): string | undefined {
	if (run.resumingAt !== undefined && facts.nowMs - Date.parse(run.resumingAt) < RESUME_INFLIGHT_MS) {
		return `a resume of ${run.id} is already in flight (started ${run.resumingAt.slice(11, 19)}Z); read claw_read ${run.id} instead of starting a second one`;
	}
	const liveness = runLiveness(run, facts);
	if (liveness.state === "alive") {
		const where = run.pid !== undefined ? `pid ${run.pid}` : `tab block ${run.block}`;
		return `run ${run.id} is still running (${where}), so a resume would start a second worker on the same session; use claw_send ${run.id} "<message>" to continue it, or claw_close ${run.id} / claw_cancel ${run.id} first`;
	}
	// Not proven gone is not the same as gone. Refusing here is what keeps a resume from forking a live conversation when
	// Tern cannot be asked (an unreadable snapshot used to be treated as "no live blocks").
	if (ACTIVE_STATUSES.includes(run.status) && liveness.state === "unknown") {
		const why = run.pid === undefined && facts.live === undefined ? "the Tern snapshot is unavailable" : liveness.why;
		return `run ${run.id} is ${run.status} and its worker cannot be proven gone (${why}), so a resume could start a second worker on the same session; close its tab with claw_close ${run.id}, or end the run with claw_cancel ${run.id}, then resume it`;
	}
	const remedy = run.remedies?.[RESUME_KEY];
	if (remedy?.exhausted) {
		return `automatic resume of ${run.id} stopped after ${remedy.attempts} attempt(s): ${remedy.note ?? "no reason recorded"}. The work is in ${run.sessionFile ?? "no recorded session file"}; a human decision is needed, not another retry`;
	}
	if (!run.sessionFile) {
		return `run ${run.id} recorded no session file (its worker never reported started), so there is no conversation to continue; relaunch it fresh with claw_spawn and the same task${run.finish?.summary ? ` (its last report: ${run.finish.summary})` : ""}`;
	}
	if (!facts.sessionExists(run.sessionFile)) {
		return `run ${run.id}'s session file ${run.sessionFile} is missing, so a resume would start with no history; relaunch it fresh with claw_spawn and the same task${run.finish?.summary ? ` (its last report: ${run.finish.summary})` : ""}`;
	}
	return undefined;
}

/** The run as it must look while the new tab opens: not terminal, no corpse, no old tab. Kept in one place so a crash
 *  between any two steps leaves a record the next tick can read instead of a run that looks healthy and is not. */
function beginResume(run: Run, at: string): void {
	// A terminal report is history now, not this run's outcome: keep it, so the previous result is not erased by a resume.
	if (run.finish) run.finishHistory = [...(run.finishHistory ?? []), run.finish].slice(-5);
	run.finish = undefined;
	run.status = "launching";
	// No phase from the launch sequence: `tick` drives issue_created/tab_opening through continueRun, which would open a
	// second tab with the original task prompt. The resume path owns its own launch.
	run.phase = "tab_open";
	run.error = undefined;
	run.failureClass = undefined;
	run.awaitingSince = undefined;
	run.idleSince = undefined;
	run.stalledAt = undefined;
	run.tabMissingAt = undefined;
	run.tabClosedAt = undefined;
	run.tabCloseError = undefined;
	run.tab = undefined;
	run.block = undefined;
	// The dead worker's identity must not survive: the supervisor reads a stale pid as a corpse and would close the fresh
	// tab, and the aliveness guard would refuse the very resume that just happened.
	run.pid = undefined;
	run.worker = undefined;
	// A modal lived in the old process. Its answer can never arrive, so it must not be presented as still waiting.
	if (run.ask?.state === "open") run.ask = { ...run.ask, state: "unresolved", closedAt: at };
	run.resumingAt = at;
	run.launchStartedAt = at;
	run.resumeFrom = run.eventsOffset;
}

/** Puts the run back into a truthful state after a failed resume: it is not launching, and it says why. */
function failResume(run: Run, priorStatus: Run["status"], reason: string): void {
	run.status = priorStatus;
	run.resumingAt = undefined;
	run.resumeError = reason.slice(0, 500);
	run.error = reason.slice(0, 500);
	run.block = undefined;
	run.tab = undefined;
	run.pid = undefined;
	run.worker = undefined;
}

/**
 * Relaunch this run's worker tab on its recorded session file. Same run, same Hoja issue, same history.
 * Throws a caller-facing Error for every refusal and for a failed launch; the run record always says what happened.
 */
export async function resumeRun(run: Run, deps: ResumeDeps): Promise<Run> {
	const { store, hoja } = deps;
	const sessionExists = deps.sessionExists ?? fileExists;
	const facts = { alive: deps.alive, identity: deps.identity, bootedAt: deps.bootedAt, live: deps.live, nowMs: deps.now().getTime() };
	const refusal = resumeRefusal(run, { ...facts, sessionExists });
	if (refusal) throw new Error(refusal);
	// The issue is this run's identity: continuing a run whose issue was deleted would report work nobody can see.
	try {
		await hoja.readIssue(run.hoja!.issueId);
	} catch (error) {
		const missing = /not found/i.test((error as Error).message);
		throw new Error(missing
			? `run ${run.id}'s Hoja issue ${run.hoja!.identifier} no longer exists, so the resumed work would have nowhere to report; spawn a new run instead`
			: `could not confirm run ${run.id}'s Hoja issue ${run.hoja!.identifier} is still there (${(error as Error).message}); resume refused until Hoja answers`);
	}
	const sessionFile = run.sessionFile!;
	const priorStatus = run.status;
	const at = deps.now().toISOString();
	// The goal was ended by the terminal state that made this run resumable. A resume continues the same work under the
	// same condition, so it is armed again here — exactly one generation, exactly one spec, and only after this point can
	// the worker read it (it reads the spec while it registers, so the file must exist before the tab opens).
	const priorGoal = run.goal ? structuredClone(run.goal) : undefined;
	beginResume(run, at);
	const rearmed = rearmGoal(run, run.id, at);
	if (rearmed) store.writeGoalSpec(rearmed.spec);
	store.saveRun(run);
	const failed = (reason: string): Error => {
		const step = recordAttempt(run, RESUME_KEY, deps.now().getTime(), { budget: RESUME_BUDGET, baseMs: 5_000, capMs: 60_000, note: reason.slice(0, 300) });
		failResume(run, priorStatus, `resume failed: ${reason}`);
		// Nothing was launched, so the goal must not stay armed for a generation that never ran: restore the record and
		// withdraw the spec, exactly as the terminal state had left them.
		if (rearmed && priorGoal) { run.goal = priorGoal; store.removeGoalSpec(run.id); }
		if (step.exhausted) {
			store.appendInbox({
				kind: "run_budget_spent", runId: run.id, key: `budget:resume:${run.id}`,
				text: `${run.hoja?.identifier ?? run.id}: automatic resume stopped after ${step.attempts} attempt(s); ${reason.slice(0, 300)}. The conversation is in ${sessionFile}. Next step is a human decision, not another retry.`,
			});
		}
		store.saveRun(run);
		return new Error(`could not resume run ${run.id}: ${reason}${step.exhausted ? ` (resume budget spent after ${step.attempts} attempts; the reason is recorded)` : ""}`);
	};
	// The launch gate: a half-written extension source kills a tab before any event exists. Resuming deliberately skips
	// the "checkout moved since creation" comparison (a resume after a merge is the normal case); it still refuses a
	// source that would not load today.
	const gate = await preflightLaunch({ cwd: run.cwd, workspace: deps.workspace }, { check: deps.preflight, sleep: deps.sleep, random: deps.random });
	if (!gate.ok) throw failed(`the launch gate refused the worker tab: ${gate.error}`);
	run.launchWarning = gate.warnings.length ? gate.warnings.join("; ").slice(0, 400) : undefined;
	let session: number;
	try {
		session = await clawSession(deps.tern, run.pane ?? store.readControl().pane);
	} catch (error) {
		throw failed(`Tern: ${(error as Error).message}`);
	}
	const plan = deps.planLaunch?.(run.cwd) ?? { mode: "discovery" as const };
	// The previous worker's stderr is already quoted on the run; a fresh file means a startup failure names THIS attempt.
	rmSync(store.workerLogPath(run.id), { force: true });
	try {
		const { tab, block, named } = await launchTab(deps.tern, {
			session, cwd: run.cwd, label: tabNameFor(run), runId: run.id, clawDir: store.dir,
			sessionFile, provider: run.provider, model: run.model, plan, logPath: store.workerLogPath(run.id),
		});
		run.tab = tab;
		run.block = block;
		run.phase = "tab_open";
		run.status = "running";
		run.resumingAt = undefined;
		run.resumeError = undefined;
		run.resumeCount = (run.resumeCount ?? 0) + 1;
		run.lastResumeAt = at;
		run.launchNote = describePlan(plan);
		run.tabWarning = named ? undefined : `worker tab is open but could not be renamed to "${tabNameFor(run)}"`;
		delete run.remedies?.[RESUME_KEY];
	} catch (error) {
		throw failed(`tab open failed: ${(error as Error).message}`);
	}
	// The same run continues: no new issue, no new run, one normal run event so a human sees the resume.
	store.appendEvent({ eid: `evt-resume-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`, type: "resumed", at, runId: run.id });
	const goalNote = rearmed ? ` Its completion goal was re-armed as generation ${rearmed.generation} under the same condition.` : "";
	queueComment(run, `Claw: worker tab resumed in the same session (${run.sessionFile}); no new run and no new issue.${goalNote}`);
	store.saveRun(run);
	return run;
}

/** "Is this run still reachable?" for status pages: kept open, resumable, and why not when it is not. */
export function reachability(run: Run, facts: ResumeFacts): { keepOpen: boolean; resumable: boolean; reason: string } {
	const refusal = resumeRefusal(run, facts);
	return {
		keepOpen: run.keepOpen === true,
		resumable: refusal === undefined,
		reason: refusal ?? `claw_resume ${run.id} reopens its worker tab in the same session`,
	};
}
