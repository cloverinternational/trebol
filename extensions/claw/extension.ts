import { modeFooter } from "../../.pi/lib/runtime/mode-footer.ts";
/** /claw v1. Orchestrator session: /claw on|off|status, claw_* tools, and a durable inbox pump that wakes the
 *  owning session. Worker session (PI_CLAW_RUN set): emits started/settled events plus its own ask modal lifecycle and
 *  resumed turns, registers the explicit claw_finish tool, and applies the depth-1 tool gate. Run and trigger state
 *  lives in the daemon (.pi/lib/claw/daemon.ts). */
import { ClawStore, type RequestBody } from "../../.pi/lib/claw/store.ts";
import { ensureDaemon, request, runListing, statusSummary } from "../../.pi/lib/claw/orchestrator.ts";
import { pidAlive } from "../../.pi/lib/claw/daemon.ts";
import { refreshDaemon } from "../../.pi/lib/claw/lifecycle.ts";
import { deliveredInboxIds, pumpInbox } from "../../.pi/lib/claw/inbox.ts";
import { nameClawTab, ownPaneBlock, ternExec, CLAW_TAB, type TernExec } from "../../.pi/lib/claw/launcher.ts";
import { WORKER_BLOCKED_TOOLS, askFromCompleted, askFromStarted, recordAsk, recordFinish, recordGoal, recordResumed, recordSettled, recordStarted, validateFinish, workerIdentity } from "../../.pi/lib/claw/child.ts";
import { clearGoal, establishGoal, goalHostForSession, type GoalHost } from "../../.pi/lib/tools/swarm-goal.ts";
import { onAgentSettled } from "../../.pi/lib/runtime/agent-settled.ts";
import { createSessionWakeup } from "../../.pi/lib/runtime/session-wakeup.ts";
import { latestSessionModeEntry } from "../../.pi/lib/runtime/session-mode-entry.ts";
import { CLAW_EXCLUDED_TOOLS, clawModeOn, clawRoutedTools, savedClawTools, setClawAgentRoute, setClawMode, withoutOrchestratorTools } from "../../.pi/lib/claw/mode.ts";

const text = (value: unknown) => ({ content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }], details: {} });
const sessionIdOf = (pi: any, ctx: any): string => String(ctx?.sessionManager?.getSessionId?.() ?? ctx?.sessionId ?? pi.getSessionId?.() ?? pi.sessionId ?? "");

/** This chat's Claw mode, persisted as a session entry. savedTools is the pre-Claw tool set that /claw off restores. */
export const CLAW_ENTRY = "claw-mode";
type ClawModeEntry = { on: boolean; savedTools?: string[] };

/** pi-ask's local lifecycle events (extensions/ask-user/docs/remote-events.md). Read by name, not by import, so the
 *  worker still starts and still reports `needs_user` when the ask-user extension is not installed. */
export const PI_ASK_STARTED_EVENT = "@eko24ive/pi-ask:started";
export const PI_ASK_COMPLETED_EVENT = "@eko24ive/pi-ask:completed";

/** Model-facing schema of the single Agent tool while Claw is on. The legacy schema is restored when it goes off. */
export const CLAW_AGENT_PARAMETERS = { type: "object", required: ["task", "project"], additionalProperties: false, properties: {
	task: { type: "string", description: "The work for the worker. Self-contained: the worker sees only this and its Hoja issue." },
	project: { type: "string", description: "Exact Hoja project name; it decides the team." },
	assignee: { type: "string", description: "'me' (default), an exact email, or a name in the project's team." },
	label: { type: "string", description: "Tab name; defaults to a short form of the task." },
	provider: { type: "string", description: "Pi provider for this worker, for example anthropic. Needs model. Default: pi's configured provider." },
	model: { type: "string", description: "Pi model for this worker, for example claude-opus-5-5 or provider/id. Default: pi's configured model." },
	cwd: { type: "string", description: "Working directory for the worker; defaults to this workspace." },
	keepOpen: { type: "boolean", description: "Keep the worker tab open when the run ends, so the human can keep working in it. Default false (closed on a terminal state); release later with claw_close." },
} } as const;
export const CLAW_AGENT_DESCRIPTION = "Start a visible worker tab that runs pi on the task, with a Hoja issue in the project's team. This is the only way to delegate work while Claw is on. Completion is reported to you by the inbox after the worker calls claw_finish. Pass keepOpen for a long task whose conversation a human will keep using: the tab then survives the run's end, and claw_resume brings any finished run back on its own session.";

/** Replaces the Agent tool's advertised description and schema in a provider payload (OpenAI or Anthropic shape). */
export function overlayClawAgent<T extends { tools?: unknown }>(payload: T): T | undefined {
	const tools = payload?.tools;
	if (!Array.isArray(tools)) return undefined;
	let changed = false;
	const next = tools.map((tool: any) => {
		if (tool?.function?.name === "Agent") { changed = true; return { ...tool, function: { ...tool.function, description: CLAW_AGENT_DESCRIPTION, parameters: structuredClone(CLAW_AGENT_PARAMETERS) } }; }
		if (tool?.name === "Agent" && "input_schema" in tool) { changed = true; return { ...tool, description: CLAW_AGENT_DESCRIPTION, input_schema: structuredClone(CLAW_AGENT_PARAMETERS) }; }
		return tool;
	});
	return changed ? { ...payload, tools: next } : undefined;
}

export function registerWorker(pi: any, identity: { runId: string; clawDir: string }) {
	const store = new ClawStore(identity.clawDir);
	/** True between this worker's own claw_finish and its next turn: that next turn resumes the same run in this tab. */
	let reported = false;
	/** The goal this run was started with, written by the daemon before the tab opened. */
	const goalSpec = store.readGoalSpec(identity.runId);
	/** One report at most per reason, so an unavailable goal never floods the run's event file. */
	const reportedGoalProblems = new Set<string>();
	let observedGoal = false;
	/** The goal loop of this worker's own session. Pi gives each extension its own API object, so it is resolved by
	 *  session, not by module state (see goalHostForSession). */
	let host: GoalHost | undefined;
	/** True once this worker's session started: without it there is no session to resolve a goal host for. */
	let sessionStarted = false;
	const reportGoal = (event: Parameters<typeof recordGoal>[2]) => recordGoal(store, identity.runId, event);
	/** Report this worker's own completion loop to the daemon. It changes nothing about the loop or its verdicts. */
	const observeGoal = (): boolean => {
		if (observedGoal) return true;
		if (!host) return false;
		observedGoal = true;
		host.observe((event) => {
			if (event.kind === "established" || event.kind === "widened") reportGoal({ state: event.kind, condition: event.condition });
			else if (event.kind === "verdict") reportGoal({ state: "judged", verdict: event.verdict, turns: event.turns, judgeCalls: event.judgeCalls });
			else reportGoal({ state: event.status, reason: event.reason, condition: event.condition, turns: event.turns, judgeCalls: event.judgeCalls });
		});
		return true;
	};
	const goalProblem = (reason: string) => {
		if (reportedGoalProblems.has(reason)) return;
		reportedGoalProblems.add(reason);
		reportGoal({ state: "unavailable", reason });
	};
	/** Establish the always-on completion goal this run was started with, after launch and in this process.
	 *  Idempotent: any goal state this session already carries (ours, ended, or a human's) is left untouched, so a
	 *  restart resumes the persisted goal and never duplicates or re-arms it. */
	const ensureGoal = (ctx: any) => {
		if (!host && sessionStarted) host = goalHostForSession(ctx);
		if (!observeGoal()) return goalProblem("the goal extension is not loaded in this worker, so the always-on completion loop cannot run");
		if (!goalSpec) return goalProblem("this run has no goal spec (no condition was derivable from its task), so no completion loop runs");
		const state = host?.status();
		if (state) return;
		try { establishGoal(host, { condition: goalSpec.condition, source: goalSpec.source }); }
		catch (error) { goalProblem(`goal not established: ${(error as Error).message}`); }
	};
	pi.on?.("session_start", (_event: unknown, ctx: any) => {
		sessionStarted = true;
		recordStarted(store, identity.runId, process.pid, ctx?.sessionManager?.getSessionFile?.() ?? undefined);
	});
	pi.on?.("before_agent_start", (_event: unknown, ctx: any) => {
		ensureGoal(ctx);
		if (!reported) return;
		reported = false;
		recordResumed(store, identity.runId);
	});
	onAgentSettled(pi, (event: any) => recordSettled(store, identity.runId, event?.messages));
	// Worker-local clarification: the modal opens and resolves in this worker's own tab, and the run state follows it.
	// No answer content is recorded here; only the lifecycle and the question ids.
	pi.events?.on?.(PI_ASK_STARTED_EVENT, (event: unknown) => {
		const ask = askFromStarted(event);
		if (!ask) return;
		recordAsk(store, identity.runId, ask);
		// A question is a semantic brake: the loop ends while a human decides, so no judge call is paid for waiting.
		clearGoal(host, "awaiting_decision");
	});
	pi.events?.on?.(PI_ASK_COMPLETED_EVENT, (event: unknown) => {
		const ask = askFromCompleted(event);
		if (ask) recordAsk(store, identity.runId, ask);
	});
	pi.on?.("tool_call", (event: any) => {
		if (!WORKER_BLOCKED_TOOLS.includes(event?.toolName)) return undefined;
		return { block: true, reason: `${event.toolName} is blocked for a Claw worker (depth 1). Finish the task yourself and call claw_finish.` };
	});
	pi.registerTool({
		name: "claw_finish",
		label: "Claw finish",
		description: "Report this worker's outcome exactly once. outcome: completed (verified, needs evidence), failed, or needs_user (only when a decision could not be asked in your own tab: call ask_user_question first, and report needs_user if the modal was unavailable or cancelled). Summary says what was done and what remains; evidence lists commands run, files changed, outputs checked.",
		parameters: {
			type: "object", required: ["outcome", "summary"], additionalProperties: false,
			properties: {
				outcome: { type: "string", enum: ["completed", "failed", "needs_user"] },
				summary: { type: "string" },
				evidence: { type: "array", items: { type: "string" } },
			},
		},
		async execute(_id: string, params: { outcome: string; summary: string; evidence?: string[] }) {
			const finish = validateFinish(params);
			// Clear the always-on goal BEFORE reporting: the settle that follows this turn must start no further
			// judge call, which is the measured zombie-loop defect this ordering fixes.
			clearGoal(host, finish.outcome === "needs_user" ? "needs_user" : "finish");
			recordFinish(store, identity.runId, finish);
			reported = true;
			return text(`Recorded ${finish.outcome} for ${identity.runId}. The orchestrator will be notified; Hoja Done is never set automatically.`);
		},
	});
	// The goal is always on and cannot be removed from the worker side. This surface lets a task add criteria it needs
	// (widening) and read the exact condition it is judged against.
	pi.registerTool({
		name: "claw_goal",
		label: "Claw goal",
		description: "Read this worker's always-on completion goal, or widen it with extra acceptance criteria. The goal cannot be removed: it ends when the judge returns MET or IMPOSSIBLE, when you call claw_finish, or when the run is stopped.",
		parameters: {
			type: "object", required: ["action"], additionalProperties: false,
			properties: {
				action: { type: "string", enum: ["status", "widen"] },
				criteria: { type: "string", description: "Acceptance criteria to add. Widening only: nothing can shorten or remove the condition." },
			},
		},
		async execute(_id: string, params: { action: string; criteria?: string }) {
			observeGoal();
			if (params.action === "status") return text({ goal: host?.status() ?? null, source: goalSpec?.source ?? null, criteria: goalSpec?.criteria ?? [] });
			if (params.action !== "widen") throw new Error("action must be status or widen");
			if (!host) throw new Error("no completion goal is active in this session (the goal extension is not loaded)");
			const criteria = typeof params.criteria === "string" ? params.criteria.trim() : "";
			if (!criteria) throw new Error("criteria is required to widen the goal");
			return text(host.widen(criteria));
		},
	});
}

export type OrchestratorOptions = {
	tern?: TernExec;
	env?: NodeJS.ProcessEnv;
	ensure?: (store: ClawStore, workspace: string) => number | undefined;
};

/** Records which orchestrator session asked for a run and which Tern pane it lives in, on every request that can
 *  start one (spawn, and the spawn action of a trigger), so the run's inbox items and worker tabs stay with that
 *  session. An empty session id stamps nothing (the run is then shared, as before). */
export function stampOrigin(body: RequestBody, session: string, pane: number | undefined): RequestBody {
	if (!session) return body;
	const origin = { owner: session, ...(pane !== undefined ? { pane } : {}) };
	if (body.kind === "spawn") return { ...body, input: { ...body.input, ...origin } };
	if (body.kind === "trigger_add") {
		return { ...body, ...origin, action: body.action.kind === "spawn" ? { ...body.action, ...origin } : body.action };
	}
	return body;
}

export function registerOrchestrator(pi: any, options: OrchestratorOptions = {}) {
	const workspace = pi.getCwd?.() ?? process.cwd();
	const store = ClawStore.forWorkspace(workspace);
	const tern = options.tern ?? ternExec;
	const env = options.env ?? process.env;
	const ensure = options.ensure ?? ensureDaemon;
	const wake = createSessionWakeup(pi);
	const footer = modeFooter("claw", clawModeOn);
	let timer: ReturnType<typeof setInterval> | undefined;
	let session = "";
	let live: { ctx: any; valid: () => boolean } | undefined;

	/** Registers this session's own inbox cursor. Never takes anything from another session: each Claw session in this
	 *  workspace receives only the runs it started (see .pi/lib/claw/inbox.ts). */
	const claim = () => { store.registerSession(session, process.pid, pidAlive); };
	/** A supervisor that could not be stopped or started is not a silent failure: it is shown in this session and kept
	 *  in the store's inbox, so `/claw status` and the next session still see it. */
	const reportLifecycle = (note: string, ctx?: any) => {
		try { (ctx ?? live?.ctx)?.ui?.notify?.(`Claw daemon: ${note}`, "error"); } catch { /* the session may already be gone */ }
		try { store.appendInbox({ kind: "error", text: `claw daemon: ${note}`, key: `daemon:${Date.now()}` }); } catch { /* a read-only store must not break shutdown */ }
	};
	/** Compares the supervisor's recorded code with the code on disk. Stops a stale one; never starts or signals on a
	 *  guess. Workers are separate processes in their own tabs and are not touched. */
	const checkDaemonCode = async (ctx: any, start = false) => {
		try {
			const outcome = await refreshDaemon(store, workspace, { start });
			if (outcome.blocked) reportLifecycle(outcome.note, ctx);
			return outcome;
		} catch (error) {
			reportLifecycle(`code check failed: ${(error as Error).message}`, ctx);
			return undefined;
		}
	};
	/** Persist-before-ack delivery into this session's own transcript; see .pi/lib/claw/inbox.ts. */
	const pump = async () => {
		if (!live || !live.valid() || !clawModeOn()) return;
		const current = live;
		await pumpInbox({
			store, session, now: () => Date.now(),
			delivered: () => deliveredInboxIds(current.ctx.sessionManager.getBranch()),
			send: (message) => wake.send(message, current.valid),
		});
	};
	const start = (ctx: any) => {
		session = sessionIdOf(pi, ctx);
		live = { ctx, valid: wake.capture() };
		// Restore this chat's saved mode only. Restoring routing never starts the daemon, renames tabs or writes store control.
		const saved = latestSessionModeEntry<ClawModeEntry>(ctx, CLAW_ENTRY);
		if (saved?.on === true) activate(saved.savedTools);
		else hideWhileOff();
		footer.refresh(ctx);
		// A chat that had Claw on keeps receiving its own runs after a restart or reload: same session, same cursor.
		if (clawModeOn() && store.readControl().enabled) claim();
		if (timer) clearInterval(timer);
		timer = setInterval(() => { void pump().catch(() => undefined); }, 3000);
		timer.unref?.();
		void pump().catch(() => undefined);
		// A daemon left behind by another session, an earlier branch or a merge is replaced before it supervises
		// anything in this session. Starting one here is /claw on's job; this only stops what runs older code.
		void checkDaemonCode(ctx);
	};
	pi.on?.("session_start", (_event: unknown, ctx: any) => start(ctx));
	pi.on?.("session_shutdown", async (event: any, ctx: any) => {
		if (timer) clearInterval(timer); timer = undefined; live = undefined; deactivate(); footer.clear(ctx);
		// Pi fires this with reason "reload" on the OLD extension instance before it loads the new code
		// (@earendil-works/pi-coding-agent dist/core/agent-session.js AgentSession.reload). A detached daemon would keep
		// running the code this instance loaded, so a supervisor from other sources is stopped here; the next Claw call
		// starts one from the current code. A quit/new/resume/fork leaves it detached on purpose (triggers keep firing),
		// and the daemon's own code check plus the next request cover a branch switch afterwards.
		if (event?.reason === "reload") await checkDaemonCode(ctx);
	});
	// Persist this chat's choice. Shutdown (reload, resume, new) does not persist: the next session_start restores it.
	const persistMode = (on: boolean, savedTools?: string[]) => { pi.appendEntry?.(CLAW_ENTRY, on ? { on, savedTools } : { on }); };

	const call = async (body: RequestBody) => {
		claim();
		return request(store, workspace, stampOrigin(body, session, ownPaneBlock(env)));
	};
	const str = (v: unknown, name: string): string => {
		if (typeof v !== "string" || !v.trim()) throw new Error(`${name} is required`);
		return v;
	};

	// Claw routing for this session: one Agent tool (routed), alternate spawners hidden and refused. The tool set
	// captured at activation is restored on off and on session shutdown; the store control is not touched there.
	// `saved` is the pre-Claw tool set persisted by an earlier activation in this chat; restore passes it back.
	const activate = (saved?: string[]) => {
		if (clawModeOn()) return;
		const current = withoutOrchestratorTools(pi.getActiveTools?.() ?? []);
		setClawMode(true, saved ?? current);
		const available: string[] = (pi.getAllTools?.() ?? []).map((tool: any) => tool.name);
		pi.setActiveTools?.(clawRoutedTools(current, available));
		setClawAgentRoute(async (input: any) => call({ kind: "spawn", input: { task: str(input?.task, "task"), project: str(input?.project, "project"), assignee: input?.assignee, label: input?.label, cwd: input?.cwd, provider: input?.provider, model: input?.model, keepOpen: input?.keepOpen === true } }));
	};
	const deactivate = () => {
		if (!clawModeOn()) return;
		const saved = savedClawTools();
		setClawMode(false);
		setClawAgentRoute(undefined);
		if (saved) pi.setActiveTools?.(saved);
	};
	// Orchestrator tools are visible only while Claw is on (Pi activates registered tools by default).
	const hideWhileOff = () => { if (!clawModeOn()) pi.setActiveTools?.(withoutOrchestratorTools(pi.getActiveTools?.() ?? [])); };
	pi.on?.("tool_call", (event: any) => {
		if (!clawModeOn() || !CLAW_EXCLUDED_TOOLS.includes(event?.toolName)) return undefined;
		return { block: true, reason: `${event.toolName} is disabled while Claw is on. Use Agent: it starts a Claw worker with a Hoja issue.` };
	});
	pi.on?.("before_provider_request", (event: any) => (clawModeOn() ? overlayClawAgent(event.payload) : undefined));

	const tools = [
		{
			name: "claw_spawn",
			label: "Claw spawn",
			description: "Start a visible worker tab that runs pi on a task. Creates a Hoja issue in the project's team, assigned to the assignee (default: you). Completion is only reported through the worker's claw_finish. Returns state: done (run id and Hoja identifier), not_started (nothing started; safe to retry), or pending (may still start: do not submit again; read claw_read on runId or claw_list).",
			parameters: { type: "object", required: ["task", "project"], additionalProperties: false, properties: {
				task: { type: "string" }, project: { type: "string", description: "Exact Hoja project name; it decides the team." },
				assignee: { type: "string", description: "'me' (default), an exact email, or a name in the project's team." },
				label: { type: "string", description: "Tab name; defaults to a short form of the task." }, cwd: { type: "string" },
				provider: { type: "string", description: "Pi provider for this worker, for example anthropic. Needs model. Default: pi's configured provider." },
				model: { type: "string", description: "Pi model for this worker, for example claude-opus-5-5 or provider/id. Default: pi's configured model." },
				keepOpen: { type: "boolean", description: "Keep the worker tab open after the run ends, so the human can keep working in it. Default false; release it with claw_close." },
			} },
			execute: async (_id: string, p: any) => text(await call({ kind: "spawn", input: { task: str(p.task, "task"), project: str(p.project, "project"), assignee: p.assignee, label: p.label, cwd: p.cwd, provider: p.provider, model: p.model, keepOpen: p.keepOpen === true } })),
		},
		{
			name: "claw_list",
			label: "Claw list",
			description: "List Claw runs and triggers with status, Hoja identifiers, and daemon state. Read-only.",
			parameters: { type: "object", additionalProperties: false, properties: {} },
			execute: async () => text({ ...statusSummary(store), runs: runListing(store.listRuns(), Date.now()) }),
		},
		{
			name: "claw_read",
			label: "Claw read",
			description: "Read one run: status, Hoja identifier, final text of the last settled turn, finish report if any, and the most recent events. Read-only.",
			parameters: { type: "object", required: ["run_id"], additionalProperties: false, properties: { run_id: { type: "string" }, events: { type: "integer", minimum: 1, maximum: 50 } } },
			execute: async (_id: string, p: any) => {
				const run = store.getRun(str(p.run_id, "run_id"));
				if (!run) throw new Error(`no run ${p.run_id}`);
				const events = store.readEvents(run.id, 0).items.slice(-(p.events ?? 10)).map((e) => ({ type: e.type, at: e.at, pid: e.pid, outcome: e.outcome, summary: e.summary, text: e.text?.slice(0, 600) }));
				return text({ ...run, task: undefined, outbox: run.outbox.map((o) => ({ id: o.id, kind: o.kind, done: o.done })), seen: undefined, events });
			},
		},
		{
			name: "claw_send",
			label: "Claw send",
			description: "Type a message into an active worker's tab (not a completion; the worker still has to call claw_finish). Refused while the worker has its own question open: the user answers that in the worker's tab, and the same run continues.",
			parameters: { type: "object", required: ["run_id", "text"], additionalProperties: false, properties: { run_id: { type: "string" }, text: { type: "string" } } },
			execute: async (_id: string, p: any) => text(await call({ kind: "send", runId: str(p.run_id, "run_id"), text: str(p.text, "text") })),
		},
		{
			name: "claw_cancel",
			label: "Claw cancel",
			description: "Stop one run: terminate its worker and close its tab. Records cancelled, never completed.",
			parameters: { type: "object", required: ["run_id"], additionalProperties: false, properties: { run_id: { type: "string" } } },
			execute: async (_id: string, p: any) => text(await call({ kind: "cancel", runId: str(p.run_id, "run_id") })),
		},
		{
			name: "claw_resume",
			label: "Claw resume",
			description: "Bring one run back so the human can keep working with it: relaunch its worker tab on the session file it recorded, so the agent keeps its history and context. Same run, same Hoja issue, never a second issue or a duplicate run. Works for a dead worker, a closed tab, a completed run and a run whose daemon restarted. Refused with the reason when the run is already alive, its session file is missing, a resume is already in flight, its Hoja issue was deleted, or its resume budget is spent.",
			parameters: { type: "object", required: ["run_id"], additionalProperties: false, properties: { run_id: { type: "string" } } },
			execute: async (_id: string, p: any) => text(await call({ kind: "resume", runId: str(p.run_id, "run_id") })),
		},
		{
			name: "claw_close",
			label: "Claw close",
			description: "Close one run's worker tab by hand and release keepOpen, so it is not reopened. Use it to hand a kept tab back to the supervisor.",
			parameters: { type: "object", required: ["run_id"], additionalProperties: false, properties: { run_id: { type: "string" } } },
			execute: async (_id: string, p: any) => text(await call({ kind: "close", runId: str(p.run_id, "run_id") })),
		},
		{
			name: "claw_set_keep",
			label: "Claw set keep",
			description: "Keep a run's worker tab open when the run ends (keep=true), or release it so the supervisor closes it on the next tick (keep=false). Persisted on the run, so it survives a daemon restart.",
			parameters: { type: "object", required: ["run_id", "keep"], additionalProperties: false, properties: { run_id: { type: "string" }, keep: { type: "boolean" } } },
			execute: async (_id: string, p: any) => {
				if (typeof p.keep !== "boolean") throw new Error("keep is required and must be true or false");
				return text(await call({ kind: "keep", runId: str(p.run_id, "run_id"), keep: p.keep }));
			},
		},
		{
			name: "claw_trigger",
			label: "Claw trigger",
			description: "Manage durable triggers that keep firing after this session closes. op add: when = {kind:cron,cron} | {kind:at,at:ISO} | {kind:on_exit,run_id,on?:[status]}; action = {kind:spawn,task,project,assignee?,label?,cwd?} | {kind:notify,message}. op list reads; op remove deletes by id. Triggers do not fire while /claw is off.",
			parameters: { type: "object", required: ["op"], additionalProperties: false, properties: {
				op: { type: "string", enum: ["add", "list", "remove"] }, id: { type: "string" },
				when: { type: "object" }, action: { type: "object" }, once: { type: "boolean" },
			} },
			execute: async (_id: string, p: any) => {
				if (p.op === "list") return text(store.listTriggers());
				if (p.op === "remove") return text(await call({ kind: "trigger_remove", triggerId: str(p.id, "id") }));
				const w = p.when ?? {};
				const when = w.kind === "cron" ? { kind: "cron" as const, cron: str(w.cron, "when.cron") }
					: w.kind === "at" ? { kind: "at" as const, at: str(w.at, "when.at") }
					: w.kind === "on_exit" ? { kind: "on_exit" as const, runId: str(w.run_id, "when.run_id"), on: w.on }
					: (() => { throw new Error("when.kind must be cron, at or on_exit"); })();
				const a = p.action ?? {};
				const action = a.kind === "notify" ? { kind: "notify" as const, message: str(a.message, "action.message") }
					: a.kind === "spawn" ? { kind: "spawn" as const, task: str(a.task, "action.task"), project: str(a.project, "action.project"), assignee: a.assignee, label: a.label, cwd: a.cwd }
					: (() => { throw new Error("action.kind must be spawn or notify"); })();
				return text(await call({ kind: "trigger_add", when, action, once: p.once ?? (when.kind !== "cron") }));
			},
		},
	];
	for (const tool of tools) pi.registerTool(tool);

	pi.registerCommand("claw", {
		description: "Claw orchestrator: /claw on | off | status",
		handler: async (args: string, ctx: any) => {
			const sub = (args ?? "").trim().toLowerCase() || "status";
			const notify = (msg: string, level = "info") => ctx?.ui?.notify?.(msg, level);
			if (sub === "on") {
				claim();
				const pane = ownPaneBlock(env);
				// Only this process's own pane is renamed, and only after Tern confirms the pane is live.
				let tabNote: string;
				if (pane === undefined) tabNote = `Tab not named: this session is not in a Tern pane (TERN_PANE unset). Name its tab "${CLAW_TAB}" yourself.`;
				else {
					try {
						const r = await nameClawTab(tern, pane);
						tabNote = r.renamed ? `Tab named "${CLAW_TAB}".` : `Tab already named "${CLAW_TAB}".`;
					} catch (error) {
						tabNote = `Tab not named: ${(error as Error).message}. Name it "${CLAW_TAB}" yourself.`;
					}
				}
				store.writeControl(true, pane);
				activate();
				persistMode(true, savedClawTools());
				footer.refresh(ctx);
				// Never hand new work to a daemon from other sources: replace it first, then start if none is left.
				const freshness = await checkDaemonCode(ctx);
				if (freshness?.blocked) return notify(`Claw on, but the daemon could not be replaced: ${freshness.note}`, "error");
				const pid = ensure(store, workspace);
				const daemonNote = pid
					? `Daemon already running (pid ${pid}, current code).`
					: freshness?.action === "stopped" ? "Daemon from older code stopped; starting one from the current code." : "Daemon starting.";
				return notify(`Claw on. ${daemonNote} ${tabNote}`, tabNote.startsWith("Tab not named") ? "warning" : "info");
			}
			if (sub === "off") {
				store.writeControl(false, store.readControl().pane);
				deactivate();
				persistMode(false);
				footer.refresh(ctx);
				return notify("Claw off: triggers and new runs are suspended, and the normal tool set is restored. Running workers keep running and are still reconciled.");
			}
			if (sub === "status") return notify(JSON.stringify(statusSummary(store), null, 2));
			return notify("Usage: /claw on | off | status", "warning");
		},
	});
}

export default function clawExtension(pi: any) {
	const identity = workerIdentity();
	if (identity) registerWorker(pi, identity);
	else registerOrchestrator(pi);
}
