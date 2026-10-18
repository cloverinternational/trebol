// Pure grouping of transcript items into tool-work segments. No TUI or I/O imports.

export type StepStatus = "running" | "ok" | "error";

export interface GroupableStep {
	status?: StepStatus;
	cancelled?: boolean;
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

/** Status comes from step results only: running beats interrupted, interrupted beats failed. */
export function summarizeToolGroup(steps: readonly GroupableStep[]): GroupSummary {
	const active = steps.filter(isActiveStep).length;
	const interrupted = steps.some((step) => step.cancelled === true);
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
