// Pure grouping of transcript items into tool-work segments. No TUI or I/O imports.

export type StepStatus = "running" | "ok" | "error";

export interface GroupableStep {
	status?: StepStatus;
	cancelled?: boolean;
	// Set on every step of a turn the user aborted, even steps that finished before the abort.
	turnAborted?: boolean;
	// Set on every step of a turn that ended in an error (the final assistant message failed, not aborted).
	turnFailed?: boolean;
	startedAt?: number;
	took?: number;
}

export type GroupStatus = "running" | "done" | "failed" | "interrupted";

export interface GroupSummary {
	status: GroupStatus;
	active: number;
	// Steps whose own result was an error (not cancelled). The turn may still be Done: the agent recovered.
	failedSteps: number;
	durationMs?: number;
}

export type Segment<T> = { kind: "message"; item: T } | { kind: "tools"; items: T[] };

/** True for an item that starts a turn: the user's message, or a visible message that triggered a turn. */
export function isTurnBoundary(item: { role: string; turnStart?: boolean }): boolean {
	return item.role === "user" || item.turnStart === true;
}

/**
 * One work segment per turn. A turn runs from a boundary (see isTurnBoundary) to the next. Its tool calls,
 * and the assistant narration written before its last tool call (or in a message that calls tools), form one group placed where the first of
 * them appeared. Everything else (the boundary, notices, the answer after the last tool call) stays a message.
 */
export function segmentTranscript<T extends { role: string; turnStart?: boolean; callsTools?: boolean }>(items: readonly T[]): Segment<T>[] {
	const out: Segment<T>[] = [];
	const flush = (start: number, end: number) => {
		let lastTool = -1;
		for (let k = start; k < end; k++) if (items[k]!.role === "tool") lastTool = k;
		let group: { kind: "tools"; items: T[] } | null = null;
		for (let k = start; k < end; k++) {
			const item = items[k]!;
			const inWork = !isTurnBoundary(item) && (item.role === "tool" || (item.role === "assistant" && (k < lastTool || item.callsTools === true)));
			if (!inWork) {
				out.push({ kind: "message", item });
				continue;
			}
			if (!group) {
				group = { kind: "tools", items: [] };
				out.push(group);
			}
			group.items.push(item);
		}
	};
	let start = 0;
	items.forEach((item, k) => {
		if (k > start && isTurnBoundary(item)) {
			flush(start, k);
			start = k;
		}
	});
	flush(start, items.length);
	return out;
}

export function isActiveStep(step: GroupableStep): boolean {
	return step.status === "running" && step.cancelled !== true;
}

/** True for an assistant message that ended in an error other than the user's abort: the turn failed. */
export function isFailedAssistant(message: unknown): boolean {
	if (typeof message !== "object" || message === null) return false;
	const m = message as { role?: unknown; stopReason?: unknown };
	return m.role === "assistant" && m.stopReason === "error" && !isAbortedAssistant(message);
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

/**
 * The turn's outcome, not the worst step: running beats interrupted, interrupted beats failed. A turn is
 * interrupted when it was aborted or a step never finished, and failed only when the turn itself ended in an
 * error. A step error the agent went on from is counted in failedSteps; the turn still reads Done.
 */
export function summarizeToolGroup(steps: readonly GroupableStep[]): GroupSummary {
	const active = steps.filter(isActiveStep).length;
	const interrupted = steps.some((step) => step.cancelled === true || step.turnAborted === true);
	const failed = steps.some((step) => step.turnFailed === true);
	const failedSteps = steps.filter((step) => step.status === "error" && step.cancelled !== true).length;
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
	return { status, active, failedSteps, ...(durationMs !== undefined ? { durationMs } : {}) };
}
