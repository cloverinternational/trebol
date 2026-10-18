// Pure grouping of transcript items into tool-work segments. No TUI or I/O imports.

export type StepStatus = "running" | "ok" | "error";

export interface GroupableStep {
	status?: StepStatus;
	cancelled?: boolean;
	// Set on every step of a turn the user aborted, even steps that finished before the abort.
	turnAborted?: boolean;
	startedAt?: number;
	took?: number;
}

export type GroupStatus = "running" | "done" | "failed" | "interrupted";

export interface GroupSummary {
	status: GroupStatus;
	active: number;
	durationMs?: number;
}

export type Segment<T> = { kind: "message"; item: T } | { kind: "tools"; items: T[] };

/** One tool segment per user turn: every tool call after a user message joins one group, placed at its first call. */
export function segmentTranscript<T extends { role: string }>(items: readonly T[]): Segment<T>[] {
	const out: Segment<T>[] = [];
	let turn: { kind: "tools"; items: T[] } | null = null;
	for (const item of items) {
		if (item.role === "user") turn = null;
		if (item.role !== "tool") {
			out.push({ kind: "message", item });
			continue;
		}
		if (!turn) {
			turn = { kind: "tools", items: [] };
			out.push(turn);
		}
		turn.items.push(item);
	}
	return out;
}

export function isActiveStep(step: GroupableStep): boolean {
	return step.status === "running" && step.cancelled !== true;
}

/**
 * True for an assistant message that ended because the user aborted the turn. Pi records it as
 * `stopReason: "aborted"`, or as `"error"` with the provider's abort message; both are persisted in JSONL.
 */
export function isAbortedAssistant(message: unknown): boolean {
	if (typeof message !== "object" || message === null) return false;
	const m = message as { role?: unknown; stopReason?: unknown; errorMessage?: unknown };
	if (m.role !== "assistant") return false;
	if (m.stopReason === "aborted") return true;
	return m.stopReason === "error" && typeof m.errorMessage === "string" && /\babort/i.test(m.errorMessage);
}

/** A tool error that reports the abort itself rather than a failure of the work. */
export function isCancellationError(text: string | undefined): boolean {
	return typeof text === "string" && /context canceled|operation was aborted|\baborted\b|cancell?ed/i.test(text);
}

/** The goal shown for a turn: the first non-empty line of the user's message, whitespace collapsed. */
export function goalLine(text: string): string {
	const line = text.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
	return line.replace(/\s+/g, " ");
}

/** The single live line. The count leads so an end-truncated line never loses it. */
export function liveLineText(goal: string, active: number): string {
	const state = active > 0 ? `${active} running` : "working";
	return goal ? `${state} · ${goal}` : state;
}

export const SETTLED_LABEL: Record<Exclude<GroupStatus, "running">, string> = { done: "Done", failed: "Failed", interrupted: "Interrupted" };

/**
 * The settled summary as one string, built only from data a session JSONL also carries (status, goal,
 * step count), so a restored turn reads exactly as it did live. Timing is deliberately not part of it.
 */
export function summaryText(status: Exclude<GroupStatus, "running">, goal: string, steps: number): string {
	return [SETTLED_LABEL[status], goal, steps === 1 ? "1 step" : `${steps} steps`].filter(Boolean).join(" · ");
}

/** Running beats interrupted, interrupted beats failed. An aborted turn is interrupted even if its steps finished. */
export function summarizeToolGroup(steps: readonly GroupableStep[]): GroupSummary {
	const active = steps.filter(isActiveStep).length;
	const interrupted = steps.some((step) => step.cancelled === true || step.turnAborted === true);
	const failed = steps.some((step) => step.status === "error" && step.cancelled !== true);
	const status: GroupStatus = active > 0 ? "running" : interrupted ? "interrupted" : failed ? "failed" : "done";
	let start: number | undefined;
	let end: number | undefined;
	for (const step of steps) {
		if (step.startedAt !== undefined) start = start === undefined ? step.startedAt : Math.min(start, step.startedAt);
		if (step.startedAt !== undefined && step.took !== undefined) {
			const stepEnd = step.startedAt + step.took;
			end = end === undefined ? stepEnd : Math.max(end, stepEnd);
		}
	}
	const durationMs = status === "running" || start === undefined || end === undefined ? undefined : Math.max(0, end - start);
	return { status, active, ...(durationMs !== undefined ? { durationMs } : {}) };
}
