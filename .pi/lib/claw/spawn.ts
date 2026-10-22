/** Run lifecycle on the daemon side. A run is persisted before each side effect and moves through phases
 *  intent -> create_dispatched -> issue_created -> tab_opening -> tab_open.
 *  - intent: nothing has left the process. A Hoja create that is refused is a definitive failure; an expired deadline
 *    refuses the launch before any side effect.
 *  - create_dispatched: the Hoja create may have been applied (its answer may have been lost or late). This phase is
 *    reconciled only by the run marker and never re-sends the create, because absence of the marker is not proof that
 *    the create was not applied. Launch is blocked until the issue is found and verified.
 *  - tab_opening: the tab call may have created a tab, so it is never retried; it is reported instead.
 *  Liveness tradeoff: if a create never commits, the run stays unresolved until a human decides (see docs/claw). */
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import { HojaRequestError, type HojaClient, type IssueRef, type IssueView, type Resolved } from "./hoja.ts";
import { clawSession, findRunBlock, launchTab, tabLabel, type TernExec } from "./launcher.ts";
import { describePlan, type LaunchPlan } from "./launch-plan.ts";
import { TERMINAL, type ClawStore, type Run, type SpawnInput, type OutboxOp } from "./store.ts";

export const MAX_INTENT_ATTEMPTS = 5;
export const RECONCILE_MS = 15_000;
export const HOJA_START_STATE = "In Progress";
export type ClawHoja = Pick<HojaClient, "resolve" | "createIssue" | "readIssue" | "findIssueByMarker" | "comment" | "setState">;
/** `planLaunch` decides how the worker loads extensions; absent means Pi's own package discovery. */
export type LaunchDeps = { store: ClawStore; hoja: ClawHoja; tern: TernExec; workspace: string; now?: () => Date; planLaunch?: (cwd: string) => LaunchPlan };

/** The worker's model choice. Both unset means pi's configured default. pi's --provider only searches for --model, so a provider needs one. */
export function workerModel(input: { provider?: string; model?: string }): { provider?: string; model?: string } {
	const provider = input.provider?.trim() || undefined;
	const model = input.model?.trim() || undefined;
	if (provider && !model) throw new Error("provider needs model: pass model too, for example provider anthropic with model claude-opus-5-5");
	for (const value of [provider, model]) {
		if (value !== undefined && !/^[\w./:-]+$/.test(value)) throw new Error(`provider and model must be plain identifiers: ${value}`);
	}
	return { provider, model };
}

export const runMarker = (runId: string) => `<!-- claw-run:${runId} -->`;
export const opMarker = (opId: string) => `<!-- claw-op:${opId} -->`;

/** A run's id derives from its request id, so the caller holds a stable handle before the daemon has acted. */
export const runIdFor = (requestId: string) => `run-${createHash("sha256").update(requestId).digest("hex").slice(0, 20)}`;

/** The worker tab name: the Hoja identifier first, so the tab says which issue it works on. Known once the issue exists. */
export const tabNameFor = (run: Pick<Run, "label" | "hoja">): string => tabLabel(`${run.hoja?.identifier ?? ""} ${run.label}`.trim());

export function defaultLabel(task: string, cwd: string, workspace: string): string {
	if (resolve(cwd) !== resolve(workspace)) return tabLabel(basename(cwd));
	const words = task.replace(/[^\p{L}\p{N}\s-]/gu, " ").split(/\s+/).filter(Boolean).slice(0, 5).join(" ");
	return tabLabel(words);
}

export function taskFile(run: Run): string {
	const h = run.hoja ?? { identifier: "(pending)", teamKey: "?", project: run.project, assignee: run.assignee ?? "?" };
	return `# Claw worker — run ${run.id}

You are a worker started by the Claw orchestrator. Your Hoja issue is **${h.identifier}** (team ${h.teamKey}, project "${h.project}", assignee ${h.assignee}).
Do not start other workers, triggers or schedules. You are a depth-1 worker: agent-spawning tools are blocked.
Never move ${h.identifier} to Done; a human decides that.

## Task

${run.task}

## When you need a decision

You have your own \`ask_user_question\` tool and your own tab, and the user answers in this tab. Do not route a decision
through the orchestrator.

1. Before ending a turn that needs a decision, call \`ask_user_question\` with one short question set: the concrete
   options and why each one matters.
2. This turn is suspended until the user answers or cancels the modal in this tab. An answer returns to you as the tool
   result; continue the same run with it. Do not start another run and do not ask the orchestrator to relay the answer.
3. If the modal is cancelled, unavailable (no interactive terminal), or \`ask_user_question\` is missing: do not ask
   again in a loop and do not invent a question. Call \`claw_finish\` with outcome "needs_user" and a summary that states
   the exact question, the options, and what you will do with each answer. The user can answer in this tab and this same
   run continues here.

## Finish (required)

When the work is finished, call the \`claw_finish\` tool exactly once:
- \`outcome\`: "completed" only when the task is done and verified; "failed" when it cannot be done; "needs_user" when you need a decision.
- \`summary\`: what you did and what remains.
- \`evidence\`: concrete references (commands run and their results, files changed, URLs, identifiers). Required for "completed".

Ending a turn without calling \`claw_finish\` is reported to the orchestrator as idle, not as done.
`;
}

export function issueDescription(run: Run, mark: string): string {
	return `Created by Claw run \`${run.id}\`${run.trigger ? ` (trigger \`${run.trigger}\`)` : ""}.\n\n**Working directory:** \`${run.cwd}\`\n\n## Task\n\n${run.task}\n\n${mark}`;
}

/** Verifies the issue as the server stored it, not as the request described it. */
export function verifyIssue(view: IssueView, resolved: Resolved, mark: string): void {
	const problems: string[] = [];
	if (view.teamId !== resolved.teamId) problems.push("team");
	if (view.projectId !== resolved.projectId) problems.push("project");
	if (view.assigneeId !== resolved.assigneeId) problems.push("assignee");
	if (!view.description.includes(mark)) problems.push("run marker");
	if (view.state.toLowerCase() !== HOJA_START_STATE.toLowerCase()) problems.push(`state "${view.state}"`);
	if (problems.length) throw new Error(`Hoja read-back mismatch on ${view.identifier}: ${problems.join(", ")}`);
}

export function queueComment(run: Run, text: string): void {
	const id = `${run.id}:c${run.outbox.length + 1}`;
	run.outbox.push({ id, kind: "comment", body: `${text}\n\n${opMarker(id)}`, done: false } as OutboxOp);
}

export function queueState(run: Run, state: string): void {
	run.outbox.push({ id: `${run.id}:s:${state.toLowerCase().replace(/\s+/g, "-")}`, kind: "state", state, done: false });
}

export function findByKey(store: ClawStore, key: { requestId?: string; fireKey?: string }): Run | undefined {
	return store.listRuns().find((r) => (key.requestId && r.requestId === key.requestId) || (key.fireKey && r.fireKey === key.fireKey));
}

/** Only a definitive server answer (GraphQL rejection, or a local check) proves nothing was committed. */
export const isAmbiguous = (error: unknown): boolean => error instanceof HojaRequestError && error.ambiguous;

const now = (deps: LaunchDeps) => (deps.now ? deps.now() : new Date());
const pastDeadline = (run: Run, deps: LaunchDeps) => run.deadline !== undefined && now(deps).getTime() > Date.parse(run.deadline);

export function failRun(run: Run, deps: LaunchDeps, error: string): Run {
	const { store } = deps;
	run.status = "failed";
	run.error = error.slice(0, 500);
	run.reconcileAt = undefined;
	queueComment(run, `Claw: ${run.error}`);
	store.saveRun(run);
	store.appendInbox({ kind: "run_failed", runId: run.id, text: `${run.id} failed: ${run.error}`, key: `fail:${run.id}` });
	return run;
}

/** Validates, persists the intent, then drives the run forward. Returns the run as it stands after this attempt. */
export async function startRun(input: SpawnInput, deps: LaunchDeps, key: { requestId?: string; fireKey?: string; trigger?: string; deadline?: string } = {}): Promise<Run> {
	const prior = findByKey(deps.store, key);
	if (prior) return prior;
	const task = input.task?.trim();
	if (!task) throw new Error("task is required");
	if (!input.project?.trim()) throw new Error("project is required (Hoja project name; it decides the team)");
	const cwd = input.cwd ? (isAbsolute(input.cwd) ? input.cwd : resolve(deps.workspace, input.cwd)) : deps.workspace;
	const label = tabLabel(input.label ?? defaultLabel(task, cwd, deps.workspace));
	const { provider, model } = workerModel(input);
	// Validation only: no run and no side effect exists yet if this throws.
	await deps.hoja.resolve(input.project, input.assignee);
	const at = now(deps).toISOString();
	const run: Run = {
		id: key.requestId ? runIdFor(key.requestId) : deps.store.newId("run"), label, task, cwd, status: "launching", phase: "intent", createdAt: at, updatedAt: at,
		project: input.project.trim(), requestedAssignee: input.assignee ?? "me", provider, model,
		requestId: key.requestId, fireKey: key.fireKey, trigger: key.trigger, deadline: key.deadline,
		eventsOffset: 0, settles: 0, attempts: 0, outbox: [], seen: [],
	};
	deps.store.saveRun(run);
	return continueRun(run, deps);
}

/** Where a possibly-created worker tab is, by run id. Never retries: it only reports, so an operator can decide. */
async function locateTab(run: Run, tern: TernExec): Promise<string> {
	try {
		const found = await findRunBlock(tern, run.id);
		if (!found) return "No Tern block carries this run id, so no worker tab was created.";
		run.tab = found.tab;
		run.block = found.block;
		return `Tern tab ${found.tab} (block ${found.block}) carries this run id and may be live; check it before relaunching.`;
	} catch {
		return "Tern could not be queried to locate a tab for this run id.";
	}
}

/** intent: the only way to reach the Hoja create. The phase is persisted before the request leaves. */
async function dispatchCreate(run: Run, deps: LaunchDeps): Promise<Run> {
	const { store, hoja } = deps;
	if (pastDeadline(run, deps)) return failRun(run, deps, "request expired before dispatch; not started (no Hoja issue was created)");
	let resolved: Resolved;
	try {
		resolved = await hoja.resolve(run.project, run.requestedAssignee);
	} catch (error) {
		run.attempts++;
		run.error = `Hoja: ${(error as Error).message}`.slice(0, 500);
		if (run.attempts >= MAX_INTENT_ATTEMPTS) return failRun(run, deps, `${run.error}; gave up after ${run.attempts} attempts; not started`);
		store.saveRun(run);
		return run;
	}
	const mark = runMarker(run.id);
	// Read-only guard before any write: an issue may already carry this run's marker (for example one persisted by an older daemon).
	let existing: IssueRef | undefined;
	try {
		existing = await hoja.findIssueByMarker(mark);
	} catch (error) {
		// Nothing was sent: the run stays in intent and the lookup is retried later.
		run.error = `Hoja lookup pending: ${(error as Error).message}`.slice(0, 500);
		run.reconcileAt = new Date(now(deps).getTime() + RECONCILE_MS).toISOString();
		store.saveRun(run);
		return run;
	}
	run.target = resolved;
	run.error = undefined;
	run.reconcileAt = undefined;
	if (existing) {
		run.phase = "create_dispatched";
		run.hoja = { issueId: existing.id, identifier: existing.identifier, teamKey: resolved.teamKey, project: resolved.project, assignee: resolved.assignee };
		store.saveRun(run);
		return reconcileCreate(run, deps);
	}
	// Persist the create intent BEFORE the request leaves: from here on the outcome may be unknown.
	run.phase = "create_dispatched";
	store.saveRun(run);
	let ref: IssueRef;
	try {
		ref = await hoja.createIssue(resolved, `[claw] ${run.label}: ${run.task.split("\n")[0].slice(0, 140)}`, issueDescription(run, mark), HOJA_START_STATE);
	} catch (error) {
		if (!isAmbiguous(error)) return failRun(run, deps, `Hoja rejected the create; nothing was committed: ${(error as Error).message}`);
		run.reconcileAt = now(deps).toISOString();
		run.error = `Hoja create outcome unknown (${(error as Error).message}). Not re-sent; reconciling by run marker.`.slice(0, 500);
		store.saveRun(run);
		return run;
	}
	run.hoja = { issueId: ref.id, identifier: ref.identifier, teamKey: resolved.teamKey, project: resolved.project, assignee: resolved.assignee };
	store.saveRun(run);
	return reconcileCreate(run, deps);
}

/** create_dispatched: find the issue by id (if known) or by marker, verify it, and only then move on. Never creates. */
async function reconcileCreate(run: Run, deps: LaunchDeps): Promise<Run> {
	const { store, hoja } = deps;
	if (!run.target) return failRun(run, deps, "internal: create dispatched without a resolved target");
	const mark = runMarker(run.id);
	const retryLater = () => {
		run.reconcileAt = new Date(now(deps).getTime() + RECONCILE_MS).toISOString();
		store.saveRun(run);
		return run;
	};
	let ref: IssueRef | undefined;
	try {
		ref = run.hoja ? { id: run.hoja.issueId, identifier: run.hoja.identifier } : await hoja.findIssueByMarker(mark);
	} catch (error) {
		run.error = `Hoja reconcile pending: ${(error as Error).message}`.slice(0, 500);
		return retryLater();
	}
	if (!ref) {
		run.error = "Hoja create outcome unknown: no issue carries this run's marker yet. Not re-created, because a late commit may still appear. Still reconciling; a human must resolve it if it never appears.";
		return retryLater();
	}
	let view: IssueView;
	try {
		view = await hoja.readIssue(ref.id);
	} catch (error) {
		run.error = `Hoja reconcile pending: ${(error as Error).message}`.slice(0, 500);
		return retryLater();
	}
	try {
		verifyIssue(view, run.target, mark);
	} catch (error) {
		return failRun(run, deps, `${(error as Error).message}; issue ${ref.identifier} exists and was not launched`);
	}
	run.hoja = { issueId: ref.id, identifier: ref.identifier, teamKey: run.target.teamKey, project: run.target.project, assignee: run.target.assignee };
	run.phase = "issue_created";
	run.error = undefined;
	run.reconcileAt = undefined;
	store.saveRun(run);
	writeFileSync(store.taskPath(run.id), taskFile(run));
	return run;
}

/** Redo only what is safe. Idempotent: callable again after any crash. */
export async function continueRun(run: Run, deps: LaunchDeps): Promise<Run> {
	const { store, tern } = deps;
	if (TERMINAL.includes(run.status)) return run;
	if (run.phase === "intent") return dispatchCreate(run, deps);
	if (run.phase === "create_dispatched") return reconcileCreate(run, deps);
	if (run.phase === "tab_opening") {
		// The tab call was in flight when the process stopped; it may have created a tab. Never retry blindly.
		run.status = "failed";
		run.error = `tab open was interrupted; not retried automatically. ${await locateTab(run, tern)}`;
		queueComment(run, `Claw: ${run.error}`);
		store.saveRun(run);
		store.appendInbox({ kind: "run_failed", runId: run.id, text: `${run.id} failed: ${run.error}`, key: `fail:${run.id}` });
		return run;
	}
	if (run.phase === "issue_created") {
		// Once the Hoja issue exists, the launch is still refused if its deadline passed: no worker starts after expiry.
		if (pastDeadline(run, deps)) return failRun(run, deps, `deadline passed before the worker tab; not launched. Hoja ${run.hoja?.identifier} remains In Progress and needs a human decision`);
		let session: number;
		try {
			session = await clawSession(tern, store.readControl().pane);
		} catch (error) {
			// No tab call was made, so the attempt is safe to repeat.
			run.attempts++;
			run.error = `Tern: ${(error as Error).message}`.slice(0, 500);
			store.saveRun(run);
			return run;
		}
		run.phase = "tab_opening";
		store.saveRun(run);
		try {
			// A configured package and a cwd-local package that name the same repository load every extension twice
			// and pi exits on the tool conflicts. The plan keeps one copy, preferring this worker's own checkout.
			const plan = deps.planLaunch?.(run.cwd) ?? { mode: "discovery" as const };
			const prompt = `Read and execute your Claw task file in full: ${store.taskPath(run.id)}`;
			const { tab, block, named } = await launchTab(tern, {
				session, cwd: run.cwd, label: tabNameFor(run), runId: run.id, clawDir: store.dir, prompt, provider: run.provider, model: run.model,
				plan, logPath: store.workerLogPath(run.id),
			});
			run.tab = tab;
			run.block = block;
			run.phase = "tab_open";
			run.error = undefined;
			run.launchNote = describePlan(plan);
			run.tabWarning = named ? undefined : `worker tab is open but could not be renamed to "${tabNameFor(run)}"`;
			store.saveRun(run);
		} catch (error) {
			run.status = "failed";
			run.error = `tab open failed (not retried): ${(error as Error).message}. ${await locateTab(run, tern)}`.slice(0, 500);
			queueComment(run, `Claw could not open the worker tab: ${run.error}`);
			store.saveRun(run);
			store.appendInbox({ kind: "run_failed", runId: run.id, text: `${run.id} failed: ${run.error}`, key: `fail:${run.id}` });
		}
	}
	return run;
}
