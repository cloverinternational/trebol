/** The always-on completion goal of a Claw worker.
 *
 *  Every run gets one. It is derived from the task the run was spawned for — its objective and the acceptance criteria
 *  stated in that task — and recorded on the run before the worker starts, so the condition is auditable and the worker
 *  never receives it as its launch prompt (a positional prompt beginning with `/` would be consumed as a command).
 *  There is no turn cap, no deadline and no expiry: the loop continues while the judge answers NOT_MET. Only semantic
 *  brakes end it — MET, IMPOSSIBLE, the worker's own claw_finish, cancellation, the worker's question, and any terminal
 *  run state — and each of them ends it exactly once.
 *
 *  This module is pure state and text handling. The daemon writes the goal spec, applies the worker's goal events and
 *  owns run.goal; the worker only establishes and clears the loop in its own process. */
import type { GoalVerdict } from "../tools/swarm-goal.ts";

/** Under the 4000-character limit the goal command enforces, leaving room for one widening. */
export const GOAL_CONDITION_MAX = 3500;
/** A goal that has run this long raises ONE warning notice. It is observability, never a deadline: nothing stops. */
export const GOAL_LONG_MS = 60 * 60_000;
export const MAX_CRITERIA = 8;

export type ClawGoalStatus = "pending" | "active" | "met" | "impossible" | "cleared" | "unavailable" | "error";
/** Why the loop ended. `finish` and `awaiting_decision` are the reasons the worker itself reports. */
export type ClawGoalEndReason = "met" | "impossible" | "cleared" | "finish" | "needs_user" | "cancel" | "awaiting_decision" | "terminal" | "error";
/** The run's goal as the daemon records it. `source` is `claw:<runId>`, so a restart can tell its own ended goal from a
 *  new one and can never establish a second loop for the same run. */
export type ClawGoal = {
	source: string;
	condition: string;
	criteria: string[];
	derivedAt: string;
	status: ClawGoalStatus;
	/** Present for `unavailable`: why no condition could be derived or the goal extension was missing. */
	reason?: string;
	establishedAt?: string;
	turns: number;
	judgeCalls: number;
	lastVerdict?: GoalVerdict;
	lastVerdictAt?: string;
	endedAt?: string;
	endReason?: ClawGoalEndReason;
	/** Set once, when the long-run warning notice was emitted. */
	warningAt?: string;
};
/** What the daemon writes for the worker to establish. Immutable for the life of the run. */
export type GoalSpec = { runId: string; source: string; condition: string; criteria: string[]; derivedAt: string };
/** What the worker reports back. Advisory: it never changes the verdict or the loop, only the run record and status. */
export type GoalEvent = {
	state: "established" | "widened" | "judged" | "met" | "impossible" | "cleared" | "unavailable" | "error";
	condition?: string;
	verdict?: GoalVerdict;
	turns?: number;
	judgeCalls?: number;
	reason?: string;
};

/** Statuses from which a goal never reopens: an ended goal is not resurrected, and a duplicate event is ignored. */
export const ENDED_GOAL: readonly ClawGoalStatus[] = ["met", "impossible", "cleared", "error"];
const END_REASONS: readonly ClawGoalEndReason[] = ["met", "impossible", "cleared", "finish", "needs_user", "cancel", "awaiting_decision", "terminal", "error"];
const ACTIVE_GOAL: readonly ClawGoalStatus[] = ["active", "pending"];

export const isGoalActive = (goal: ClawGoal | undefined): boolean => goal?.status === "active";

const clip = (text: string, limit: number) => (text.length > limit ? `${text.slice(0, limit).trimEnd()}…` : text);
const HEADER = /^#{1,6}\s+/;
const TASK_HEADER = /^#{1,6}\s+(?:task|objective|goal)\b/i;
const BULLET = /^\s{0,3}(?:[-*+]|\d+[.)])\s+(.*)$/;
/** Task-file scaffolding that is not part of the objective: the run header and any immutability boilerplate. */
const BOILERPLATE = /immutability notice|you are a worker started by the claw orchestrator|read and execute your claw task file/i;
const CRITERIA_HINT = /\b(must|must not|never|do not|don't|tests?|verify|verified|evidence|acceptance|report|run the|run \w+ suite|push|merge|open a pr|into main)\b/i;

function conditionText(objective: string, criteria: string[]): string {
	return [
		`Complete the task this Claw worker was started for, with the requested outcome actually achieved: ${objective}`,
		"",
		"Acceptance criteria:",
		...criteria.map((entry) => `- ${entry}`),
		"",
		"MET requires evidence in the transcript that every criterion was actually done: the files changed, the commands run, and their results. A plan, an intention, or an unverified claim is NOT_MET.",
	].join("\n");
}

/** Derives the goal condition from a task: the objective first, then the acceptance criteria it states.
 *  Deterministic (same task, same condition) and bounded well under the goal command's 4000-character limit.
 *  Returns undefined when the task carries no objective, so the run is recorded as `unavailable` rather than guessed. */
export function deriveGoal(task: string): { condition: string; objective: string; criteria: string[] } | undefined {
	const text = String(task ?? "").replace(/\r\n?/g, "\n").replace(/<!--[\s\S]*?-->/g, " ").trim();
	if (!text) return undefined;
	const paragraphs = text.split(/\n{2,}/).map((entry) => entry.trim()).filter(Boolean);
	// A "## Task" (or Objective/Goal) heading, when present, marks where the real task starts; everything before it is
	// context the spawner wrote. Without one the whole task is used.
	const start = paragraphs.findIndex((entry) => TASK_HEADER.test(entry.split("\n")[0].trim()));
	const body = (start >= 0 ? paragraphs.slice(start) : paragraphs)
		.filter((entry) => !BOILERPLATE.test(entry))
		.filter((entry) => entry.split("\n").some((line) => line.trim() && !HEADER.test(line.trim())));
	if (!body.length) return undefined;
	const objective = clip(body[0].split("\n").filter((line) => !HEADER.test(line.trim())).join(" ").replace(/\s+/g, " ").trim(), 900);
	if (!objective) return undefined;

	const criteria: string[] = [];
	const push = (raw: string) => {
		const value = clip(raw.replace(/\s+/g, " ").trim(), 240);
		if (!value || criteria.includes(value) || criteria.length >= MAX_CRITERIA) return;
		criteria.push(value);
	};
	// Stated constraints first: bullets and numbered items are explicit acceptance criteria.
	for (const paragraph of body) for (const line of paragraph.split("\n")) {
		const bullet = BULLET.exec(line);
		if (bullet) push(bullet[1]);
	}
	// Then the sentences that state a requirement, so a task written as prose still yields criteria.
	for (const paragraph of body) {
		if (!CRITERIA_HINT.test(paragraph)) continue;
		for (const sentence of paragraph.split(/(?<=[.!?])\s+/)) {
			if (!CRITERIA_HINT.test(sentence)) continue;
			if (sentence.replace(/\s+/g, " ").trim() === objective) continue;
			push(sentence);
		}
	}
	const must = criteria.length ? criteria : ["The task's stated outcome is achieved and verified with concrete evidence."];
	// Drop trailing criteria before clipping the objective, so a very long task still yields a coherent condition.
	let keep = must;
	let condition = conditionText(objective, keep);
	while (condition.length > GOAL_CONDITION_MAX && keep.length > 1) {
		keep = keep.slice(0, -1);
		condition = conditionText(objective, keep);
	}
	return { condition: clip(condition, GOAL_CONDITION_MAX), objective, criteria: keep };
}

/** The goal recorded on a run at spawn. `unavailable` (never active) is a safe near-miss: the worker is still a normal
 *  worker and still reports through claw_finish. */
export function startGoal(runId: string, task: string, at: string): ClawGoal {
	const source = `claw:${runId}`;
	const derived = deriveGoal(task);
	if (!derived) {
		return {
			source, condition: "", criteria: [], derivedAt: at, status: "unavailable", turns: 0, judgeCalls: 0,
			reason: "no goal condition could be derived from the task (it states no objective); the run relies on its own claw_finish report",
		};
	}
	return { source, condition: derived.condition, criteria: derived.criteria, derivedAt: at, status: "pending", turns: 0, judgeCalls: 0 };
}

export function goalSpecOf(runId: string, goal: ClawGoal): GoalSpec | undefined {
	if (goal.status === "unavailable" || !goal.condition) return undefined;
	return { runId, source: goal.source, condition: goal.condition, criteria: goal.criteria, derivedAt: goal.derivedAt };
}

type GoalCarrier = { goal?: ClawGoal };

/** Ends the goal exactly once. Returns false when there was nothing to end, so no second notice is ever emitted. */
export function endGoal(target: GoalCarrier, reason: ClawGoalEndReason, at: string): boolean {
	const goal = target.goal;
	if (!goal || !ACTIVE_GOAL.includes(goal.status)) return false;
	goal.status = reason === "met" ? "met" : reason === "impossible" ? "impossible" : reason === "error" ? "error" : "cleared";
	goal.endedAt = at;
	goal.endReason = reason;
	return true;
}

/** Applies one worker goal event. Late or duplicate events cannot reopen an ended goal or invent a verdict. */
export function applyGoalEvent(target: GoalCarrier, event: GoalEvent, at: string): boolean {
	const current = target.goal;
	const counters = (goal: ClawGoal) => {
		goal.turns = Math.max(goal.turns, Number.isFinite(event.turns) ? Number(event.turns) : 0);
		goal.judgeCalls = Math.max(goal.judgeCalls, Number.isFinite(event.judgeCalls) ? Number(event.judgeCalls) : 0);
	};
	if (event.state === "unavailable") {
		if (current) {
			if (current.status !== "pending") return false;
			current.status = "unavailable";
			current.reason = event.reason?.slice(0, 400);
			return true;
		}
		target.goal = { source: "", condition: "", criteria: [], derivedAt: at, status: "unavailable", turns: 0, judgeCalls: 0, reason: event.reason?.slice(0, 400) };
		return true;
	}
	if (event.state === "established" || event.state === "widened") {
		if (current && ENDED_GOAL.includes(current.status)) return false;
		if (!current) {
			target.goal = { source: "worker", condition: "", criteria: [], derivedAt: at, status: "active", turns: 0, judgeCalls: 0 };
		}
		const goal = target.goal!;
		goal.status = "active";
		if (event.condition) goal.condition = event.condition;
		goal.establishedAt ??= at;
		goal.reason = undefined;
		return true;
	}
	if (!current) return false;
	if (event.state === "judged") {
		if (current.status !== "active") return false;
		counters(current);
		current.lastVerdict = event.verdict ?? "NOT_MET";
		current.lastVerdictAt = at;
		return true;
	}
	if (event.state === "met" || event.state === "impossible") {
		if (current.status !== "active") return false;
		counters(current);
		current.lastVerdict = event.state === "met" ? "MET" : "IMPOSSIBLE";
		current.lastVerdictAt = at;
		return endGoal(target, event.state, at);
	}
	// cleared | error: the worker says why ("finish" from claw_finish, "awaiting_decision" from its own question).
	counters(current);
	const asked = event.reason && (END_REASONS as readonly string[]).includes(event.reason) ? (event.reason as ClawGoalEndReason) : undefined;
	return endGoal(target, event.state === "error" ? "error" : asked ?? "cleared", at);
}

/** One status row. `elapsedSeconds` is measured from establishment (or derivation) to the end, or to now while running. */
export function goalRow(goal: ClawGoal | undefined, nowMs: number) {
	if (!goal) return undefined;
	const startedAt = Date.parse(goal.establishedAt ?? goal.derivedAt);
	const endedAt = goal.endedAt ? Date.parse(goal.endedAt) : nowMs;
	return {
		status: goal.status,
		condition: goal.condition || undefined,
		source: goal.source || undefined,
		turns: goal.turns,
		judgeCalls: goal.judgeCalls,
		lastVerdict: goal.lastVerdict ?? null,
		elapsedSeconds: Number.isFinite(startedAt) ? Math.max(0, Math.round((endedAt - startedAt) / 1000)) : 0,
		endReason: goal.endReason,
		warning: Boolean(goal.warningAt),
		reason: goal.reason,
	};
}
