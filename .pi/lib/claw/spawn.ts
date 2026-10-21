/** Run lifecycle on the daemon side. A run is persisted before each side effect and moves through phases
 *  intent -> issue_created -> tab_opening -> tab_open. A restart redoes only the phases that are safe to redo:
 *  intent reconciles by marker before creating a Hoja issue; tab_opening is ambiguous (the tab may exist), so it
 *  is never retried and is reported instead. */
import { writeFileSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import type { HojaClient, IssueRef, IssueView, Resolved } from "./hoja.ts";
import { clawSession, launchTab, tabLabel, type TernExec } from "./launcher.ts";
import { TERMINAL, type ClawStore, type Run, type SpawnInput, type OutboxOp } from "./store.ts";

export const MAX_INTENT_ATTEMPTS = 5;
export const HOJA_START_STATE = "In Progress";
export type ClawHoja = Pick<HojaClient, "resolve" | "createIssue" | "readIssue" | "findIssueByMarker" | "comment" | "setState">;
export type LaunchDeps = { store: ClawStore; hoja: ClawHoja; tern: TernExec; workspace: string };

export const runMarker = (runId: string) => `<!-- claw-run:${runId} -->`;
export const opMarker = (opId: string) => `<!-- claw-op:${opId} -->`;

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

/** Validates, persists the intent, then drives the run forward. Returns the run as it stands after this attempt. */
export async function startRun(input: SpawnInput, deps: LaunchDeps, key: { requestId?: string; fireKey?: string; trigger?: string } = {}): Promise<Run> {
	const prior = findByKey(deps.store, key);
	if (prior) return prior;
	const task = input.task?.trim();
	if (!task) throw new Error("task is required");
	if (!input.project?.trim()) throw new Error("project is required (Hoja project name; it decides the team)");
	const cwd = input.cwd ? (isAbsolute(input.cwd) ? input.cwd : resolve(deps.workspace, input.cwd)) : deps.workspace;
	const label = tabLabel(input.label ?? defaultLabel(task, cwd, deps.workspace));
	// Validation only: no run and no side effect exists yet if this throws.
	const resolved = await deps.hoja.resolve(input.project, input.assignee);
	const now = new Date().toISOString();
	const run: Run = {
		id: deps.store.newId("run"), label, task, cwd, status: "launching", phase: "intent", createdAt: now, updatedAt: now,
		project: resolved.project, assignee: resolved.assignee, requestedAssignee: input.assignee ?? "me",
		requestId: key.requestId, fireKey: key.fireKey, trigger: key.trigger,
		eventsOffset: 0, settles: 0, attempts: 0, outbox: [], seen: [],
	};
	deps.store.saveRun(run);
	return continueRun(run, deps);
}

/** Redo only what is safe. Idempotent: callable again after any crash. */
export async function continueRun(run: Run, deps: LaunchDeps): Promise<Run> {
	const { store, hoja, tern } = deps;
	if (TERMINAL.includes(run.status)) return run;
	if (run.phase === "tab_opening") {
		// The tab call was in flight when the process stopped; it may have created a tab. Never retry blindly.
		run.status = "failed";
		run.error = `tab open was interrupted; not retried automatically — check Tern for a tab named "${run.label}" before relaunching`;
		queueComment(run, `Claw: ${run.error}`);
		store.saveRun(run);
		store.appendInbox({ kind: "run_failed", runId: run.id, text: `${run.id} failed: ${run.error}`, key: `fail:${run.id}` });
		return run;
	}
	if (run.phase === "intent") {
		try {
			const resolved = await hoja.resolve(run.project, run.requestedAssignee);
			const mark = runMarker(run.id);
			const ref: IssueRef = (await hoja.findIssueByMarker(mark)) ?? (await hoja.createIssue(resolved, `[claw] ${run.label}: ${run.task.split("\n")[0].slice(0, 140)}`, issueDescription(run, mark), HOJA_START_STATE));
			verifyIssue(await hoja.readIssue(ref.id), resolved, mark);
			run.hoja = { issueId: ref.id, identifier: ref.identifier, teamKey: resolved.teamKey, project: resolved.project, assignee: resolved.assignee };
			run.phase = "issue_created";
			run.error = undefined;
			store.saveRun(run);
			writeFileSync(store.taskPath(run.id), taskFile(run));
		} catch (error) {
			run.attempts++;
			run.error = `Hoja: ${(error as Error).message}`.slice(0, 500);
			if (run.attempts >= MAX_INTENT_ATTEMPTS) {
				run.status = "failed";
				run.error += `; gave up after ${run.attempts} attempts`;
				store.appendInbox({ kind: "run_failed", runId: run.id, text: `${run.id} failed before a Hoja issue existed: ${run.error}`, key: `fail:${run.id}` });
			}
			store.saveRun(run);
			return run;
		}
	}
	if (run.phase === "issue_created") {
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
			const prompt = `Read and execute your Claw task file in full: ${store.taskPath(run.id)}`;
			const { tab, block, named } = await launchTab(tern, { session, cwd: run.cwd, label: run.label, runId: run.id, clawDir: store.dir, prompt });
			run.tab = tab;
			run.block = block;
			run.phase = "tab_open";
			run.error = undefined;
			run.tabWarning = named ? undefined : `worker tab is open but could not be renamed to "${run.label}"`;
			store.saveRun(run);
		} catch (error) {
			run.status = "failed";
			run.error = `tab open failed; a tab may exist, check Tern for "${run.label}": ${(error as Error).message}`.slice(0, 500);
			queueComment(run, `Claw could not open the worker tab: ${run.error}`);
			store.saveRun(run);
			store.appendInbox({ kind: "run_failed", runId: run.id, text: `${run.id} failed: ${run.error}`, key: `fail:${run.id}` });
		}
	}
	return run;
}
