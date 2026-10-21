// Pure, factual one-line summaries of tool steps and the live activity view. No TUI or I/O imports.
// Only recognized argument keys are read, targets are bounded to one line, and unknown tools keep their names.

export interface WorkStep {
	id: string;
	name?: string;
	args?: unknown;
	status?: "running" | "ok" | "error";
	cancelled?: boolean;
	timedOut?: boolean;
	exit?: number;
	took?: number;
	// Completion order among finished steps (1-based). "Latest" means last to finish, not last called.
	doneSeq?: number;
}

export type WorkTone = "pending" | "success" | "error" | "warning" | "muted";

export interface WorkRow {
	id: string;
	label: string;
	target?: string;
	result: string;
	tone: WorkTone;
}

export interface CurrentTask {
	id: string;
	subject: string;
}

const MAX_TARGET = 80;
const MAX_ACTIVE = 3;
const MAX_REQUEST = 120;
const MAX_PATCH_FILES = 2;

const oneLine = (text: string, max: number): string => {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

const rawArg = (args: unknown, key: string): string | undefined => {
	const value = typeof args === "object" && args !== null ? (args as Record<string, unknown>)[key] : undefined;
	return typeof value === "string" ? value : undefined;
};

const argText = (args: unknown, key: string): string | undefined => {
	const value = rawArg(args, key);
	return value !== undefined && value.trim() ? oneLine(value, MAX_TARGET) : undefined;
};

const pathTarget = (args: unknown) => argText(args, "path") ?? argText(args, "file_path") ?? argText(args, "filePath");
const searchTarget = (args: unknown) => argText(args, "pattern") ?? argText(args, "query");
const operationsTarget = (args: unknown): string | undefined => {
	const ops = typeof args === "object" && args !== null ? (args as { operations?: unknown }).operations : undefined;
	return Array.isArray(ops) ? `${ops.length} op${ops.length === 1 ? "" : "s"}` : undefined;
};

// apply_patch names the files its headers change. The patch body itself is never shown.
const patchTarget = (args: unknown): string | undefined => {
	const input = rawArg(args, "input") ?? rawArg(args, "patch");
	if (input === undefined) return undefined;
	const files = [...new Set([...input.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)].map((m) => m[1]!.trim()).filter(Boolean))];
	if (files.length === 0) return undefined;
	const shown = files.slice(0, MAX_PATCH_FILES).join(", ");
	const more = files.length > MAX_PATCH_FILES ? ` +${files.length - MAX_PATCH_FILES} more` : "";
	return oneLine(shown + more, MAX_TARGET);
};

// Only the executable's name, never its arguments. The first token must be a plain word: a leading KEY=value
// assignment, quoting, or expansion makes the command unidentifiable, so nothing is shown rather than a fragment.
const commandIdentity = (args: unknown): string | undefined => {
	const command = rawArg(args, "command");
	if (command === undefined) return undefined;
	const first = command.trim().split(/\s+/)[0] ?? "";
	if (!/^[A-Za-z0-9._+\/-]+$/.test(first)) return undefined;
	const name = first.split("/").pop() ?? "";
	return /^[A-Za-z0-9._+-]{1,40}$/.test(name) ? name : undefined;
};

const bashTarget = (args: unknown) => argText(args, "description") ?? commandIdentity(args);

const KNOWN: Record<string, { label: string; target: (args: unknown) => string | undefined }> = {
	read: { label: "Read", target: pathTarget },
	Read: { label: "Read", target: pathTarget },
	write: { label: "Write", target: pathTarget },
	Write: { label: "Write", target: pathTarget },
	edit: { label: "Edit", target: pathTarget },
	Edit: { label: "Edit", target: pathTarget },
	apply_patch: { label: "Patch", target: patchTarget },
	bash: { label: "Run", target: bashTarget },
	Bash: { label: "Run", target: bashTarget },
	grep: { label: "Search", target: searchTarget },
	Grep: { label: "Search", target: searchTarget },
	search: { label: "Search", target: searchTarget },
	TaskManage: { label: "Tasks", target: operationsTarget },
};

const formatMs = (ms: number): string => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);

function resultOf(step: WorkStep): { text: string; tone: WorkTone } {
	if (step.cancelled === true) return { text: "Cancelled", tone: "muted" };
	if (step.status === "running") return { text: "Running", tone: "pending" };
	const took = step.took !== undefined ? formatMs(step.took) : undefined;
	const parts = (...xs: Array<string | undefined>) => xs.filter((x): x is string => x !== undefined).join(" · ");
	if (step.status === "ok") return { text: parts("Done", took), tone: "success" };
	if (step.timedOut === true) return { text: parts("Timed out", took), tone: "warning" };
	return { text: parts("Failed", step.exit !== undefined ? `exit ${step.exit}` : undefined, took), tone: "error" };
}

/** One factual row for a tool step: plain action, a recognized target, and the explicit result. */
export function summarizeWorkStep(step: WorkStep): WorkRow {
	const name = step.name ?? "tool";
	const known = KNOWN[name];
	const target = known?.target(step.args);
	const { text, tone } = resultOf(step);
	return {
		id: step.id,
		label: known?.label ?? name,
		...(target !== undefined ? { target } : {}),
		result: text,
		tone,
	};
}

/** The authoritative current task, labelled as such. Callers pass it only for the active work group. */
export function currentTaskLine(task: CurrentTask): string {
	return `Current task · #${task.id} ${oneLine(task.subject, 120)}`;
}

/** A row as one line of text: "Run · Build · Failed · exit 1". */
export function rowLine(row: WorkRow): string {
	return [row.label, row.target, row.result].filter((part): part is string => part !== undefined && part !== "").join(" · ");
}

export interface ActivityView {
	/** Authoritative current task, else the bounded user request. Never an invented title. */
	heading?: string;
	/** Up to three running steps, in call order. */
	active: WorkRow[];
	/** Running steps beyond the shown three. */
	moreActive: number;
	/** The step that finished most recently, by completion order. */
	latest?: WorkRow;
	/** Persistent: every failed step so far, with the most recent failure named. */
	failed?: { count: number; last: WorkRow };
}

/** Projects the live group's steps (given in call order) into the bounded activity panel. */
export function activityView(steps: readonly WorkStep[], task?: CurrentTask, request?: string): ActivityView {
	const running = steps.filter((step) => step.status === "running");
	const shown = running.slice(0, MAX_ACTIVE).map(summarizeWorkStep);
	const finished = steps.filter((step) => step.status !== "running" && step.cancelled !== true && step.doneSeq !== undefined);
	const lastDone = finished.reduce<WorkStep | undefined>((best, step) => (best === undefined || step.doneSeq! > best.doneSeq! ? step : best), undefined);
	const failures = steps.filter((step) => step.status === "error" && step.cancelled !== true);
	const lastFailure = failures.reduce<WorkStep | undefined>((best, step) => (best === undefined || (step.doneSeq ?? 0) > (best.doneSeq ?? 0) ? step : best), undefined);
	const heading = task ? currentTaskLine(task) : request?.trim() ? `Request · ${oneLine(request, MAX_REQUEST)}` : undefined;
	return {
		...(heading !== undefined ? { heading } : {}),
		active: shown,
		moreActive: running.length - shown.length,
		...(lastDone ? { latest: summarizeWorkStep(lastDone) } : {}),
		...(lastFailure ? { failed: { count: failures.length, last: summarizeWorkStep(lastFailure) } } : {}),
	};
}
