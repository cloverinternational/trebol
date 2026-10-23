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

// The command line itself, bounded. Tern ellipsizes a collapsed command target and wraps it expanded.
const MAX_COMMAND = 400;
const commandText = (args: unknown): string | undefined => {
	const command = rawArg(args, "command");
	return command !== undefined && command.trim() ? oneLine(command, MAX_COMMAND) : undefined;
};

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

/** How the terminal draws a step's `target`, as Tern's `tool` element defines it. */
export type StepTargetKind = "command" | "pattern" | "path" | "query" | "text";

/** The data head of one tool step: what the terminal draws, never a rendered row. */
export interface StepHead {
	/** Tern's icon name for the tool family (`bash`, `read`, `edit`, `grep`, `todo`, …). */
	name: string;
	/** The verb a user reads ("Bash", "Read", "Patch"). */
	verb: string;
	/** The primary argument, drawn once. */
	target?: string;
	targetKind?: StepTargetKind;
	/** The model's own intent for the step, when the tool carries one (a bash description). */
	intent?: string;
}

interface HeadSpec {
	name: string;
	verb: string;
	kind: StepTargetKind;
	target: (args: unknown) => string | undefined;
	intent?: (args: unknown) => string | undefined;
}

const intentOf = (args: unknown) => argText(args, "description");

// One table for the icon, verb and typed target of each known tool family. Only the argument the tool really
// carries is named; an unknown tool keeps its own name and shows no invented target.
const HEADS: Record<string, HeadSpec> = {
	bash: { name: "bash", verb: "Bash", kind: "command", target: commandText, intent: intentOf },
	Bash: { name: "bash", verb: "Bash", kind: "command", target: commandText, intent: intentOf },
	read: { name: "read", verb: "Read", kind: "path", target: pathTarget },
	Read: { name: "read", verb: "Read", kind: "path", target: pathTarget },
	write: { name: "write", verb: "Write", kind: "path", target: pathTarget },
	Write: { name: "write", verb: "Write", kind: "path", target: pathTarget },
	edit: { name: "edit", verb: "Edit", kind: "path", target: pathTarget },
	Edit: { name: "edit", verb: "Edit", kind: "path", target: pathTarget },
	apply_patch: { name: "edit", verb: "Patch", kind: "text", target: patchTarget },
	grep: { name: "grep", verb: "Search", kind: "pattern", target: searchTarget },
	Grep: { name: "grep", verb: "Search", kind: "pattern", target: searchTarget },
	search: { name: "grep", verb: "Search", kind: "pattern", target: searchTarget },
	Glob: { name: "glob", verb: "Glob", kind: "pattern", target: searchTarget },
	glob: { name: "glob", verb: "Glob", kind: "pattern", target: searchTarget },
	TaskManage: { name: "todo", verb: "Tasks", kind: "text", target: operationsTarget },
	Task: { name: "task", verb: "Agent", kind: "query", target: searchTarget },
	web_fetch: { name: "web", verb: "Fetch", kind: "query", target: searchTarget },
	deepwiki: { name: "globe", verb: "Docs", kind: "query", target: searchTarget },
	browser_get_page: { name: "globe", verb: "Page", kind: "query", target: searchTarget },
};

/** A tool name as a Tern icon/role name: lowercase, punctuation folded, bounded. */
const iconName = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "tool";

/** The head data for one step. Unknown tools keep their own name and make no claim about arguments. */
export function stepHead(name: string | undefined, args: unknown): StepHead {
	const raw = name ?? "tool";
	const spec = HEADS[raw];
	if (!spec) return { name: iconName(raw), verb: oneLine(raw, 40) };
	const target = spec.target(args);
	const intent = spec.intent?.(args);
	return {
		name: spec.name,
		verb: spec.verb,
		...(target !== undefined ? { target, targetKind: spec.kind } : {}),
		...(intent !== undefined ? { intent } : {}),
	};
}

/** The running steps' slice the compact activity panel shows. */
export const MAX_ACTIVE_STEPS = MAX_ACTIVE;

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

// The activity view's heading: the current task when one is known, else the bounded request. The turn card's head
// already shows the request, so its body does not repeat it; the pure view keeps it for non-card consumers.
function focusHeading(task: CurrentTask | undefined, request?: string): string | undefined {
	if (task) return currentTaskLine(task);
	return request?.trim() ? `Request · ${oneLine(request, MAX_REQUEST)}` : undefined;
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
	const heading = focusHeading(task, request);
	return {
		...(heading !== undefined ? { heading } : {}),
		active: shown,
		moreActive: running.length - shown.length,
		...(lastDone ? { latest: summarizeWorkStep(lastDone) } : {}),
		...(lastFailure ? { failed: { count: failures.length, last: summarizeWorkStep(lastFailure) } } : {}),
	};
}
