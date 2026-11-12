import { modeFooter } from "../../.pi/lib/runtime/mode-footer.ts";
import { PROJECT_CATALOG, projectTool, type ProjectCatalog } from "./projects.ts";
import { taskFacts } from "./lifecycle.ts";
import { HOJA_CONFIG_PATH, readHojaConfigForRepository, writeHojaProjectMapping, type HojaProjectConfig } from "./project.ts";
/** Hoja mode: read-only Hoja tools, coarse TaskManage → Hoja publication, and a rule that makes the agent check
 *  Hoja before advising on work. */
import { HojaClient, HojaRequestError } from "../../.pi/lib/claw/hoja.ts";
import { latestSessionModeEntry } from "../../.pi/lib/runtime/session-mode-entry.ts";
import { HOJA_GET_CONTRACT, HOJA_LIST_CONTRACT } from "../../.pi/lib/tools/swarm-hoja.contract.ts";
import {
	HOJA_TASK_ENTRY, publicationNote, publicationSummary, publishBatch, replayHojaRecords,
	type HojaRecords, type HojaTaskRecord, type HojaWriter, type PublishOutcome,
} from "./publish.ts";

export const HOJA_RULE = "Hoja mode: for any question about work, status, priority, or what to do next, call hoja_list (or hoja_get for one identifier) before answering. Automatic publication is on: TaskManage publishes one Hoja issue per coarse task — a task with no parent, or one marked metadata {\"hoja\":\"publish\"} — and keeps steps local with metadata {\"hoja\":\"local\"} (child tasks stay local unless promoted; a promoted child is created under its parent's issue and is deferred rather than filed as a root). Acceptance questions live in the issue description, never as separate issues. The project is resolved without you naming one: this chat's hoja_project selection, else the repository\u2019s .pi/config/hoja.json. Before starting, check whether an issue already exists (hoja_list), set metadata {\"hojaProject\":\"<exact project name>\"} only for a project other than the repository\u2019s own, and {\"hojaIssue\":\"TREBOL-123\"} to reuse an existing issue. After an issue is linked, every TaskManage update keeps it current: questions and progress are rewritten inside one managed description block, and an accepted completion — every acceptance question answered with evidence — posts one evidence-bearing comment and moves the owned issue to Done. A reused or shared issue is never moved, closed or commented on: the session's work becomes a sub-issue beneath it, and for any other change to a shared issue, state it and ask the user to confirm in this conversation. Publication is automatic, so read its outcome in the TaskManage result and act on it: a no_project skip creates nothing and records the task as unfiled; the extension then runs a bounded catalog discovery and reports existing projects, and the task is retried automatically once a project is selected or named. Missing filing never blocks your work, and an unconfirmed create or completion comment is never repeated automatically. /hoja off disables publication and this guidance for the chat; hoja_list and hoja_get stay read-only.";
export const HOJA_ENTRY = "hoja-mode";
/** Lifecycle-owned recovery state, journaled per chat: bounded discovery attempts, the tasks already told about, and
 *  the authoritative snapshots of tasks that could not be filed, so a reload neither rediscovers forever nor loses a
 *  queued task before a mapping exists. */
export const HOJA_RECOVERY_ENTRY = "hoja-recovery";
export const MAX_RECOVERY_ATTEMPTS = 2;
export const MAX_RECOVERY_CANDIDATES = 12;
export const MAX_PENDING_TASKS = 10;
export const MAX_PROJECT_DESCRIPTION = 160;
export type PendingTask = {
	taskId: string; subject: string; description?: string; parentTaskId?: string; status: string;
	questions: { id: string; text: string; answer?: string | null; evidence?: string | null }[];
};
export type HojaRecovery = { attempts: number; reported: string[]; pending: PendingTask[]; overflow?: number };
type ProjectDiscovery = { projects: { name: string; description?: string; teams: string[] }[] } | { error: string };

/** Records whose project could not be resolved in this attempt, newest per task. */
function unresolvedProjectRecords(outcome: PublishOutcome): HojaTaskRecord[] {
	const latest = new Map<string, HojaTaskRecord>();
	for (const record of outcome.records) latest.set(record.taskId, record);
	return [...latest.values()].filter(record =>
		record.state !== "linked" && (record.reason === "no_project" || record.reason === "project_unresolved"));
}

/** Successful create/update results in this batch, keyed by task id. A failed or read result never becomes queued
 *  work, and a task the agent deleted or marked `hoja:"local"` is dropped rather than retried. */
type BatchTaskUpdate = { drop: true } | { drop: false; snapshot: PendingTask };
function batchTaskUpdates(params: unknown, batch: unknown): Map<string, BatchTaskUpdate> {
	const operations = Array.isArray((params as any)?.operations) ? (params as any).operations : [];
	const byKey = new Map<string, any>();
	for (const operation of operations) if (operation && typeof operation.key === "string") byKey.set(operation.key, operation);
	const updates = new Map<string, BatchTaskUpdate>();
	const results = (batch as { results?: unknown })?.results;
	for (const result of Array.isArray(results) ? results : []) {
		const entry = result as any;
		if (entry?.status !== "succeeded" || (entry.op !== "create" && entry.op !== "update")) continue;
		const task = entry?.data?.task;
		if (!task || typeof task.id !== "string" || !task.id) continue;
		const metadata = byKey.get(String(entry.key))?.metadata;
		if (metadata?.hoja === "local" || String(task.status ?? "") === "deleted") {
			updates.set(task.id, { drop: true });
			continue;
		}
		// taskFacts is authoritative: canonical `answers` carry answer and evidence even when the questions array does not.
		const facts = taskFacts(task);
		updates.set(task.id, {
			drop: false,
			snapshot: {
				taskId: facts.taskId,
				subject: facts.subject,
				...(facts.description ? { description: facts.description } : {}),
				...(typeof task.parent_id === "string" && task.parent_id ? { parentTaskId: task.parent_id } : {}),
				status: facts.status,
				questions: facts.questions.map(question => ({
					id: question.id, text: question.text,
					...(question.answer ? { answer: question.answer } : {}),
					...(question.evidence ? { evidence: question.evidence } : {}),
				})),
			},
		});
	}
	return updates;
}

/** Authoritative snapshots for the given tasks in this batch, so recovery does not depend on the model later repeating
 *  hidden metadata. Only succeeded create/update results qualify. */
export function pendingFromBatch(batch: unknown, taskIds: readonly string[], params?: unknown): PendingTask[] {
	const wanted = new Set(taskIds.map(String));
	return [...batchTaskUpdates(params, batch).entries()]
		.filter(([taskId, update]) => wanted.has(taskId) && !update.drop)
		.map(([, update]) => (update as { drop: false; snapshot: PendingTask }).snapshot);
}

/** Refresh queued snapshots from EVERY successful mutation in this batch BEFORE any retry, and drop deleted or local
 *  work. A plain update of a still-unfiled task produces no publication record at all, so without this the queue would
 *  retry a stale status/answers (for example a task that has since completed). */
export function refreshPending(existing: readonly PendingTask[], batch: unknown, params: unknown): { pending: PendingTask[]; overflow: number } {
	const updates = batchTaskUpdates(params, batch);
	const kept: PendingTask[] = [];
	for (const task of existing) {
		const update = updates.get(task.taskId);
		if (update?.drop) continue;
		kept.push(update && !update.drop ? update.snapshot : task);
	}
	return { pending: kept.slice(-MAX_PENDING_TASKS), overflow: Math.max(0, kept.length - MAX_PENDING_TASKS) };
}

/** Newest snapshot per task, bounded. Overflow is returned explicitly: the oldest unfiled tasks are not silently
 *  forgotten, they are re-queued from their authoritative task on the next successful update. */
export function mergePending(existing: readonly PendingTask[], incoming: readonly PendingTask[]): { pending: PendingTask[]; overflow: number } {
	const byTask = new Map<string, PendingTask>();
	for (const task of existing) byTask.set(task.taskId, task);
	for (const task of incoming) byTask.set(task.taskId, task);
	const all = [...byTask.values()];
	return { pending: all.slice(-MAX_PENDING_TASKS), overflow: Math.max(0, all.length - MAX_PENDING_TASKS) };
}

/** Describe one candidate within a fixed budget; the description is evidence, not decoration. */
function candidateLine(project: { name: string; description?: string; teams: string[] }): string {
	const teams = project.teams.length ? ` (${project.teams.join(", ")})` : "";
	const description = project.description?.replace(/\s+/g, " ").trim().slice(0, MAX_PROJECT_DESCRIPTION);
	return `${project.name}${teams}${description ? ` — ${description}` : ""}`;
}

/** The bounded, actionable recovery text. It supplies evidence and stops there: it never names a destination. */
function recoveryNote(discovery: ProjectDiscovery, taskIds: string[]): string {
	const tasks = taskIds.map(id => `#${id}`).join(", ");
	if ("error" in discovery)
		return `Hoja recovery: project discovery is unavailable right now (${discovery.error}), so filing could not be repaired automatically. ${tasks || "The task"} stays queued and is retried after the next TaskManage result; your work is not blocked.`;
	const candidates = discovery.projects.slice(0, MAX_RECOVERY_CANDIDATES).map(candidateLine);
	if (!candidates.length)
		return `Hoja recovery: no project is mapped for this chat or repository and none exist yet, so ${tasks || "the task"} is queued. Ask the user where this work belongs and offer hoja_project action=create (host confirmation required). Work continues; nothing is blocked.`;
	return [
		`Hoja recovery: no project is mapped for this chat or repository, so ${tasks || "the task"} was queued rather than filed.`,
		"Resolve ownership from evidence first — the project descriptions below, this repository\'s docs/remote, and mappings already confirmed in this chat. Do not pick by position or name similarity.",
		`Candidates: ${candidates.join(" · ")}.`,
		"If exactly one project clearly owns this work, call hoja_project action=select with that exact name; queued tasks are retried automatically. Pass remember:true only when the user explicitly agrees to persist it for the repository. Ask the user only when the evidence is genuinely ambiguous or a new project is needed. Work continues; nothing is blocked.",
	].join("\n");
}

/** Every Hoja read is one of these two constant documents. No caller-supplied GraphQL ever reaches the client:
 *  filters travel as typed variables (IssueFilter), which GraphQL parses as data, never as query text. */
export const HOJA_QUERIES = {
	list: `query ($first: Int!, $filter: IssueFilter) { issues(first: $first, filter: $filter) { nodes { identifier title priority createdAt updatedAt state { name } assignee { name } project { name } } } }`,
	// One issue by identifier or id. This is the resolver that consults the alias
	// ledger, so a retired flat identifier (HOJA-8) answers with the issue under
	// its current recursive identifier. Asking the *list* filter instead meant a
	// second lookup path with different semantics: the two diverged, and every
	// renumbered issue read as missing through this tool (HOJA-523, trebol#457).
	get: `query ($id: String!, $comments: Int!) { task(id: $id) { identifier title description priority createdAt updatedAt url state { name type } team { key } assignee { name } project { name } comments(first: $comments) { nodes { body createdAt user { name } } } } }`,
} as const;

/**
 * TEAM-123, or the recursive TEAM-123-A-1 / TEAM-123-A-1-a-1 the HOJA-472 migration
 * issues. Slots are case-significant (lowercased at odd depths), so only the team
 * key is uppercased; upper-casing the whole identifier made every depth>=2 issue
 * unresolvable by its own canonical text.
 */
// Grammar from HOJA-472: TEAM "-" number, then zero or more "-" slot "-" number.
// The tail alternates letters/digits, which is what separates a real recursive id
// from arbitrary hyphenated text such as "not-an-issue".
export const IDENTIFIER_PATTERN = /^[A-Za-z][A-Za-z0-9_]*-[0-9]+(?:-[A-Za-z]+-[0-9]+)*$/;

export function normalizeIdentifier(raw: unknown): string {
	const shown = String(raw ?? "").trim();
	if (!IDENTIFIER_PATTERN.test(shown)) {
		throw new Error(`identifier must look like TEAM-123 or TEAM-123-A-1, for example TREBOL-237 (got "${shown}")`);
	}
	const [team, ...rest] = shown.split("-");
	// rest is number, slot, number, slot, ... . A slot's case is fixed by the
	// grammar (uppercase for an even-depth parent, lowercase for an odd one), so
	// canonicalise it rather than making a pasted lowercase id look missing.
	const canonical = rest.map((segment, index) => {
		if (index < 1 || index % 2 === 0) return segment;
		const slot = (index + 1) / 2;
		return slot % 2 === 1 ? segment.toUpperCase() : segment.toLowerCase();
	});
	return [team.toUpperCase(), ...canonical].join("-");
}

/** Workflow state groups: these two types are what "closed" means in Hoja. */
export const CLOSED_STATE_TYPES = ["completed", "canceled"] as const;
/** The four-plus-one workflow state types the API reports, verified by introspection (WorkflowStateFilter.type). */
export const STATE_TYPES = ["backlog", "unstarted", "started", "completed", "canceled"] as const;
export const DEFAULT_LIMIT = 100;
export const MAX_LIMIT = 200;
export const DEFAULT_COMMENTS = 10;
export const MAX_COMMENTS = 50;
export const COMMENT_BODY_LIMIT = 1_200;

/** hoja_list parameters. Every value becomes a filter variable; none is ever concatenated into a query. */
export type ListQuery = {
	state?: string; assignee?: string; project?: string; team?: string;
	updatedSince?: string; updatedBefore?: string; createdSince?: string; createdBefore?: string; limit?: number;
};
export type GetQuery = { identifier: string; comments?: number };

type Issue = {
	identifier: string; title: string; priority: number | null;
	createdAt: string | null; updatedAt: string | null;
	state: { name: string } | null; assignee: { name: string } | null; project: { name: string } | null;
};
type IssueDetail = Issue & {
	description: string | null; url: string | null;
	state: { name: string; type: string } | null; team: { key: string } | null;
	comments: { nodes: { body: string; createdAt: string | null; user: { name: string } | null }[] } | null;
};
type Gql = Pick<HojaClient, "gql">;

const text = (value: unknown, isError = false) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], details: {}, ...(isError ? { isError: true } : {}) });

/** A date is either a full ISO timestamp or a bare date, which means UTC midnight. Anything else is refused
 *  locally so a typo cannot turn into a silently wrong window. */
function instant(value: string, field: string): string {
	const raw = value.trim();
	const ms = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T00:00:00.000Z` : raw);
	if (!Number.isFinite(ms)) throw new Error(`${field} must be an ISO date (YYYY-MM-DD) or an ISO timestamp`);
	return new Date(ms).toISOString();
}

function integer(raw: unknown, name: string, fallback: number, min: number, max: number): number {
	if (raw === undefined || raw === null || raw === "") return fallback;
	const value = Number(raw);
	if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer between ${min} and ${max}`);
	return value;
}

/** Builds the server-side IssueFilter. State defaults to open, exactly as the tool always did. */
export function buildIssueFilter(params: ListQuery = {}): Record<string, unknown> {
	const clauses: Record<string, unknown>[] = [];
	const state = params.state?.trim();
	const lowered = state?.toLowerCase();
	if (!state || lowered === "open") clauses.push({ state: { type: { nin: [...CLOSED_STATE_TYPES] } } });
	else if (lowered === "all") { /* every state: no state clause */ }
	else if (lowered === "closed") clauses.push({ state: { type: { in: [...CLOSED_STATE_TYPES] } } });
	else if ((STATE_TYPES as readonly string[]).includes(lowered!)) clauses.push({ state: { type: { eq: lowered } } });
	else clauses.push({ state: { name: { eqIgnoreCase: state } } });
	if (params.assignee?.trim()) clauses.push({ assignee: { name: { containsIgnoreCase: params.assignee.trim() } } });
	if (params.project?.trim()) clauses.push({ project: { name: { eqIgnoreCase: params.project.trim() } } });
	if (params.team?.trim()) clauses.push({ team: { key: { eq: params.team.trim().toUpperCase() } } });
	if (params.updatedSince) clauses.push({ updatedAt: { gte: instant(params.updatedSince, "updatedSince") } });
	if (params.updatedBefore) clauses.push({ updatedAt: { lt: instant(params.updatedBefore, "updatedBefore") } });
	if (params.createdSince) clauses.push({ createdAt: { gte: instant(params.createdSince, "createdSince") } });
	if (params.createdBefore) clauses.push({ createdAt: { lt: instant(params.createdBefore, "createdBefore") } });
	return clauses.length === 0 ? {} : clauses.length === 1 ? clauses[0] : { and: clauses };
}

const clip = (value: string | null | undefined, limit: number) => {
	const body = value ?? "";
	return body.length <= limit ? body : `${body.slice(0, limit)}… [truncated: ${body.length - limit} more characters]`;
};

export function hojaTools(client: Gql) {
	const error = (e: unknown) => text({ error: e instanceof HojaRequestError ? e.message : "Hoja lookup failed; no raw error details exposed." }, true);
	return [
		{
			name: "hoja_list",
			label: "Hoja list",
			...HOJA_LIST_CONTRACT,
			async execute(_id: string, params: ListQuery = {}) {
				try {
					const limit = integer(params.limit, "limit", DEFAULT_LIMIT, 1, MAX_LIMIT);
					const filter = buildIssueFilter(params);
					// One sentinel record detects a partial list without depending on pageInfo support.
					const nodes = (await client.gql<{ issues: { nodes: Issue[] } }>(HOJA_QUERIES.list, { first: limit + 1, filter })).issues.nodes;
					const issues = nodes.slice(0, limit);
					const truncated = nodes.length > limit;
					return text({
						issues, returnedCount: issues.length, truncated, appliedFilter: filter,
						note: truncated
							? `Partial list: more than ${limit} issues match these filters. Narrow them or raise limit (max ${MAX_LIMIT}); returnedCount is not the total.`
							: issues.length === 0
								? "No issues match these filters. project and state names match exactly (case-insensitive) and assignee is a substring; check appliedFilter."
								: "Complete list for these filters.",
					});
				} catch (e) { return error(e); }
			},
		},
		{
			name: "hoja_get",
			label: "Hoja get",
			...HOJA_GET_CONTRACT,
			async execute(_id: string, params: GetQuery) {
				// Shown verbatim: a rejected identifier is the caller's input, not a
				// secret, and the redacted generic failure made a typo indistinguishable
				// from an outage (trebol#458).
				let wanted: string;
				try { wanted = normalizeIdentifier(params.identifier); }
				catch (e) { return text({ error: e instanceof Error ? e.message : String(e) }, true); }
				try {
					const requested = integer(params.comments, "comments", DEFAULT_COMMENTS, 1, MAX_COMMENTS);
					// One issue by identifier or id. The server resolves live identifiers,
					// retired aliases and raw ids through the same clause, so this tool
					// cannot drift from the rest of the API.
					const detail = (await client.gql<{ task: IssueDetail | null }>(HOJA_QUERIES.get, {
						id: wanted, comments: requested,
					})).task ?? null;
					if (!detail) return text({ error: `issue ${wanted} not found. Check the identifier (TEAM-NUMBER).` }, true);
					const { comments: rawComments, ...issue } = detail;
					const comments = (rawComments?.nodes ?? []).map(c => ({ author: c.user?.name ?? "unknown", createdAt: c.createdAt, body: clip(c.body, COMMENT_BODY_LIMIT) }));
					return text({
						...issue, comments, commentsReturned: comments.length, commentsRequested: requested,
						...(comments.length === requested ? { commentsNote: `Only the ${requested} most recent comments were requested; older ones may exist.` } : {}),
					});
				} catch (e) { return error(e); }
			},
		},
	];
}

/** Publication needs the write surface; a client registered for reads only (or a read-only double) simply skips it. */
const asWriter = (client: unknown): HojaWriter | undefined => {
	const candidate = client as Partial<HojaWriter> | undefined;
	const methods = ["resolve", "createIssue", "readIssue", "findIssueByMarker", "findIssueByIdentifier"] as const;
	return candidate && methods.every((method) => typeof candidate[method] === "function") ? candidate as HojaWriter : undefined;
};

export interface HojaModeOptions {
	/** Project used when a task names none; defaults to the repository's `.pi/config/hoja.json`, then HOJA_PROJECT. */
	project?: string;
	/** Repository project lookup. Injectable so a test can prove the unconfigured case without a real checkout. */
	config?: () => HojaProjectConfig;
	/** Persist an explicitly user-confirmed project (the same `.pi/config/hoja.json` the reader uses). Injectable so a
	 *  test never writes the checkout's config. */
	persist?: (name: string) => unknown;
}

export function registerHojaMode(pi: any, client: Gql = new HojaClient(), options: HojaModeOptions = {}) {
	let enabled = true;
	let selectedProject: string | undefined;
	let projectAttempts: { name: string; teamId: string }[] = [];
	let records: HojaRecords = {};
	/** Bounded recovery state for this chat, replayed on resume so discovery does not repeat forever. */
	let recovery: HojaRecovery = { attempts: 0, reported: [], pending: [], overflow: 0 };
	/** Bumped on /hoja off, session start and shutdown. A batch captures it and stops before its next write when it
	 *  no longer matches, so a stale in-flight batch can never publish into a chat that is gone or turned off. */
	let generation = 0;
	/** Publication is serialized: one batch at a time, in order, so a second TaskManage call always sees the first
	 *  batch's associations instead of racing it into a duplicate issue. */
	let queue: Promise<unknown> = Promise.resolve();
	const footer = modeFooter("hoja", () => enabled);
	const writer = asWriter(client);
	/** Where this chat's work is filed. A project the user picked in this chat wins, then an explicit host option, then
	 *  the repository's own declaration — so an ordinary delegated task registers without knowing a project name — and
	 *  only then the environment. Nothing here is derived from the workspace directory name. */
	/** Repository mapping is read from the checkout root, so a chat started in a subdirectory inherits it. */
	const config = options.config ?? (() => readHojaConfigForRepository());
	/** Repository-wide persistence is opt-in and host-confirmed; the writer itself refuses unsafe targets. */
	const persistMapping = options.persist ?? ((name: string) => writeHojaProjectMapping(name));
	let sessionKey = "session";
	const project = () => selectedProject ?? (options.project?.trim() || undefined) ?? config().project ?? (process.env.HOJA_PROJECT?.trim() || undefined);
	const setEnabled = (next: boolean) => {
		enabled = next;
		generation += 1;
		pi.appendEntry?.(HOJA_ENTRY, { enabled });
	};
	/** Retry tasks queued while no project was mapped, from their authoritative snapshots. This is the recovery the
	 *  user asked for: selecting a project (or the next plain TaskManage update) files them without the model having to
	 *  repeat hidden metadata. Publication's own record guard keeps it duplicate-free. */
	const retryQueued = async (projectName: string, scopedGeneration: number, ctx: any) => {
		if (!writer || !recovery.pending.length) return { linked: [] as string[], outcome: undefined as PublishOutcome | undefined };
		const queued = recovery.pending.slice(0, MAX_PENDING_TASKS);
		const operations = queued.map(task => ({
			key: `queued-${task.taskId}`, op: "update", metadata: { hojaProject: projectName },
			...(task.description ? { description: task.description } : {}),
		}));
		const results = queued.map(task => ({
			key: `queued-${task.taskId}`, op: "update", status: "succeeded",
			data: { task: { id: task.taskId, subject: task.subject, status: task.status, parent_id: task.parentTaskId ?? "", questions: task.questions } },
		}));
		let outcome: PublishOutcome;
		try {
			outcome = await publishBatch({ operations }, { results }, {
				enabled: true, sessionKey, project: projectName, writer, records,
				fallbackProject: config().project, fallbackAssignee: config().assignee,
				journal: (entry: HojaTaskRecord) => { if (scopedGeneration === generation) pi.appendEntry?.(HOJA_TASK_ENTRY, entry); },
				isActive: () => scopedGeneration === generation,
			});
		} catch {
			return { linked: [] as string[], outcome: undefined as PublishOutcome | undefined };
		}
		if (scopedGeneration !== generation) return { linked: [] as string[], outcome: undefined as PublishOutcome | undefined };
		records = outcome.applied;
		const linked = outcome.records.filter(record => record.state === "linked" && record.identifier).map(record => String(record.identifier));
		const linkedIds = new Set(outcome.records.filter(record => record.state === "linked").map(record => record.taskId));
		recovery = { ...recovery, pending: recovery.pending.filter(task => !linkedIds.has(task.taskId)) };
		pi.appendEntry?.(HOJA_RECOVERY_ENTRY, recovery);
		if (linked.length) ctx?.ui?.notify?.(`Hoja: queued task(s) filed as ${linked.join(", ")}.`, "info");
		return { linked, outcome };
	};
	for (const tool of hojaTools(client)) pi.registerTool(tool);
	pi.registerTool(projectTool(client, {
		enabled: () => enabled, current: project, epoch: () => generation,
		select: async (name) => {
			const scoped = generation;
			pi.appendEntry("hoja-project", { name });
			selectedProject = name;
			(client as Partial<HojaClient>).invalidateCatalog?.();
			// Chain the queued retry into the SAME queue as publications: two selects, or a select and a batch, must not
			// both read the record map and create twice. The generation is re-checked before reporting anything.
			const job = queue.then(() => retryQueued(name, scoped, undefined), () => retryQueued(name, scoped, undefined));
			queue = job.then(() => undefined, () => undefined);
			const retried = await job;
			if (scoped !== generation) return undefined;
			return retried.linked.length ? { linked: retried.linked } : undefined;
		},
		persist: (name) => { try { return persistMapping(name); } catch { return false; } },
		attempt: (name, teamId) => { pi.appendEntry("hoja-project-attempt", { name, teamId }); projectAttempts.push({ name, teamId }); },
		pending: (name, teamId) => projectAttempts.some(p => p.name.toLowerCase() === name.toLowerCase() && p.teamId === teamId),
	}));
	pi.registerCommand("hoja", {
		description: "Hoja work mode: /hoja on|off|status (publishes coarse tasks; session-local)",
		handler: async (args: string, ctx: any) => {
			const action = args.trim().toLowerCase() || "status";
			if (action === "on") setEnabled(true);
			else if (action === "off") setEnabled(false);
			else if (action !== "status") {
				ctx.ui?.notify?.("Usage: /hoja on|off|status", "warning");
				return;
			}
			footer.refresh(ctx);
			ctx.ui?.notify?.(`Hoja mode ${enabled ? "on" : "off"}. ${enabled ? `Work questions check Hoja first; coarse TaskManage tasks publish to ${project() ?? `no project (set ${HOJA_CONFIG_PATH})`}.` : "Automatic publication and Hoja-first guidance disabled; read tools remain available."} An owned issue keeps current questions and progress and closes only after an accepted completion; a reused or shared issue is never written to. Saved per chat; kept across /reload, resume and fork.`, "info");
		},
	});
	// A new chat has no saved entry and starts on; a reloaded or resumed chat restores its own saved choice.
	pi.on("session_start", (_event: unknown, ctx: any) => {
		generation += 1;
		enabled = latestSessionModeEntry<{ enabled?: boolean }>(ctx, HOJA_ENTRY)?.enabled !== false;
		// Associations are journaled per chat, so a reload or resume can never publish the same task twice.
		records = replayHojaRecords(ctx?.sessionManager?.getBranch?.() ?? ctx?.sessionManager?.getEntries?.() ?? []);
		selectedProject = latestSessionModeEntry<{ name?: string }>(ctx, "hoja-project")?.name;
		projectAttempts = (ctx?.sessionManager?.getBranch?.() ?? ctx?.sessionManager?.getEntries?.() ?? [])
			.filter((e: any) => e.type === "custom" && e.customType === "hoja-project-attempt" && typeof e.data?.name === "string" && typeof e.data?.teamId === "string")
			.map((e: any) => e.data);
		sessionKey = String(ctx?.sessionManager?.getSessionId?.() ?? sessionKey);
		const saved = latestSessionModeEntry<Partial<HojaRecovery>>(ctx, HOJA_RECOVERY_ENTRY);
		recovery = {
			attempts: typeof saved?.attempts === "number" && Number.isFinite(saved.attempts) ? saved.attempts : 0,
			reported: Array.isArray(saved?.reported) ? saved.reported.filter((id) => typeof id === "string") : [],
			// The queue survives reload: a task filed nowhere is never silently forgotten.
			pending: Array.isArray(saved?.pending)
				? saved.pending.filter((task): task is PendingTask => !!task && typeof task.taskId === "string" && typeof task.subject === "string" && typeof task.status === "string" && Array.isArray(task.questions)).slice(-MAX_PENDING_TASKS)
				: [],
			overflow: typeof saved?.overflow === "number" && Number.isFinite(saved.overflow) ? Math.max(0, saved.overflow) : 0,
		};
		footer.refresh(ctx);
	});
	pi.on("session_shutdown", (_event: unknown, ctx: any) => {
		generation += 1;
		footer.clear(ctx);
	});
	// Publication reacts to TaskManage results only. No other tool can create a Hoja issue.
	pi.on("tool_result", (event: any, ctx: any) => {
		if (!enabled || event?.toolName !== "TaskManage" || !writer) return;
		// `details.batch` is the structured envelope TaskManage already emits; `details` alone is its legacy shape.
		const batch = event?.details?.batch ?? event?.details;
		if (!batch || !Array.isArray(batch.results)) return;
		const startGeneration = generation;
		sessionKey = String(ctx?.sessionManager?.getSessionId?.() ?? sessionKey);
		const attempt = (recordsForAttempt: HojaRecords) => publishBatch(event.input, batch, {
			enabled: true, sessionKey, project: project(), writer, records: recordsForAttempt,
			// An agent that names a project which does not exist falls back to the repository's project instead of
			// failing the registration, and the note tells it the name it used was not the one that landed.
			fallbackProject: config().project,
			fallbackAssignee: config().assignee,
			// The intent is journaled before the create request, so a crash mid-write leaves a durable trail.
			journal: (entry: HojaTaskRecord) => {
				if (startGeneration === generation) pi.appendEntry?.(HOJA_TASK_ENTRY, entry);
			},
			isActive: () => startGeneration === generation,
		});
		/** Read-only catalogue discovery. It reports candidates with their descriptions; it never chooses one. */
		const discover = async (): Promise<ProjectDiscovery> => {
			const catalog = await client.gql<ProjectCatalog>(PROJECT_CATALOG);
			// The real client caches its catalogue. Without this invalidation a retry keeps resolving against the stale
			// list even though discovery just proved the project exists; a fake that never caches cannot catch that.
			(client as Partial<HojaClient>).invalidateCatalog?.();
			return {
				projects: catalog.projects.nodes.map(project => ({
					name: project.name,
					...(typeof project.description === "string" && project.description.trim() ? { description: project.description.trim() } : {}),
					teams: project.teams.nodes.map(team => team.key),
				})),
			};
		};
		const work = async () => {
			let outcome: PublishOutcome;
			try {
				outcome = await attempt(records);
			} catch {
				// A publication bug must never fail the TaskManage call that already succeeded.
				if (startGeneration === generation) ctx?.ui?.notify?.("Hoja publication did not run; task state is unaffected.", "warning");
				return undefined;
			}
			// The chat changed or the mode went off while this batch ran: its state belongs to the old chat.
			if (startGeneration !== generation) return undefined;
			records = outcome.applied;

			// 1. Refresh queued snapshots from EVERY successful mutation in this batch before any retry: a plain update of
			//    an unfiled task produces no publication record, so a completed or deleted task must not be retried with
			//    stale status/answers, and `hoja:"local"` or a delete removes it from the queue entirely.
			const previousOverflow = recovery.overflow ?? 0;
			const refreshed = refreshPending(recovery.pending, batch, event.input);
			let overflow = refreshed.overflow;
			// 2. Re-queue tasks whose record is still unfiled, even when this plain update produced no record at all.
			const unfiledIds = Object.values(records)
				.filter(record => record.state !== "linked" && (record.reason === "no_project" || record.reason === "project_unresolved"))
				.map(record => record.taskId);
			const requeued = mergePending(refreshed.pending, pendingFromBatch(batch, unfiledIds, event.input));
			overflow = Math.max(overflow, requeued.overflow);
			recovery = { ...recovery, pending: requeued.pending, overflow };
			pi.appendEntry?.(HOJA_RECOVERY_ENTRY, recovery);

			// 3. Retry the queue as soon as a destination exists. This is the plain-update path: no hidden metadata is
			//    required from the model.
			const declared = project();
			if (declared && recovery.pending.length && startGeneration === generation) {
				const retried = await retryQueued(declared, startGeneration, ctx);
				if (startGeneration !== generation) return undefined;
				if (retried.outcome) {
					// Keep this batch's own records in the report as well; the applied map already holds both.
					outcome = { ...retried.outcome, records: [...outcome.records, ...retried.outcome.records] };
				}
			}

			let unresolved = unresolvedProjectRecords(outcome);
			let discovery: ProjectDiscovery | undefined;
			if (unresolved.length && recovery.attempts < MAX_RECOVERY_ATTEMPTS && startGeneration === generation) {
				recovery = { ...recovery, attempts: recovery.attempts + 1 };
				pi.appendEntry?.(HOJA_RECOVERY_ENTRY, recovery);
				try {
					discovery = await discover();
				} catch (error) {
					discovery = { error: error instanceof HojaRequestError ? error.message : "Hoja request failed" };
				}
				if (startGeneration !== generation) return undefined;
				// A declared mapping that failed to resolve may have hit a transient catalogue failure. Retry the same
				// task once now that the catalogue is reachable; unconfirmed creates are never repeated by the record guard.
				if (!("error" in discovery) && declared && unresolved.some(record => record.reason === "project_unresolved")) {
					try {
						outcome = await attempt(outcome.applied);
						if (startGeneration !== generation) return undefined;
						unresolved = unresolvedProjectRecords(outcome);
					} catch {
						// Keep the previous outcome; the note reports the unresolved registration honestly.
					}
				}
			}

			// 4. Drop whatever filed successfully; everything else stays queued from its latest authoritative snapshot.
			const linked = new Set(outcome.records.filter(record => record.state === "linked").map(record => record.taskId));
			if (linked.size) {
				recovery = { ...recovery, pending: recovery.pending.filter(task => !linked.has(task.taskId)) };
				pi.appendEntry?.(HOJA_RECOVERY_ENTRY, recovery);
			}

			records = outcome.applied;
			const summary = publicationSummary(outcome);
			if (summary) ctx?.ui?.notify?.(summary, outcome.records.every(r => r.state === "linked") && !outcome.blocked.length ? "info" : "warning");
			// The model, not the UI, has to learn the outcome: a notification is invisible to it, and a silent skip is
			// how an agent keeps believing work was filed when it was not.
			const parts = [publicationNote(outcome) ?? ""];
			// Overflow is reported once when it grows; the dropped tasks are re-queued from their own next update.
			if (overflow > previousOverflow)
				parts.push(`Hoja recovery: the queue holds ${MAX_PENDING_TASKS} unfiled task(s) and ${overflow} more are not queued. Each is re-queued from its authoritative task on its next successful update; none is treated as filed.`);
			// One bounded, actionable note per task: discovery supplies evidence, it never makes the choice, and it
			// never blocks the work. Repeating it on every batch would be a nag, so reported tasks are remembered.
			const fresh = unresolved.filter(record => !recovery.reported.includes(record.taskId));
			if (discovery && fresh.length) {
				parts.push(recoveryNote(discovery, fresh.map(record => record.taskId)));
				recovery = { ...recovery, reported: [...recovery.reported, ...fresh.map(record => record.taskId)] };
				pi.appendEntry?.(HOJA_RECOVERY_ENTRY, recovery);
			}
			const note = parts.filter(Boolean).join("\n");
			if (!note) return undefined;
			const content = Array.isArray(event.content)
				? event.content
				: typeof event.content === "string" ? [{ type: "text" as const, text: event.content }] : [];
			return { content: [...content, { type: "text" as const, text: note }] };
		};
		const queued = queue.then(work, work);
		queue = queued.then(() => undefined, () => undefined);
		return queued;
	});
	pi.on("before_agent_start", (event: any) => enabled
		? { systemPrompt: String(event.systemPrompt ?? "") + "\n" + HOJA_RULE + '\nUse hoja_project action=list to discover real projects including empty ones; hoja_list is NOT a project catalog. Resolve ownership from evidence first: the candidate descriptions reported in the TaskManage result, this repository\'s docs/remote, and mappings already confirmed in this chat. Call hoja_project action=select with the one project that clearly owns the work; queued tasks are then retried automatically, and plain TaskManage updates retry them too. Pass remember:true only when the user explicitly agrees to persist it for the whole repository (host confirmation required). Ask the user with ask_user_question only when the evidence is genuinely ambiguous or a new project is needed, and use hoja_project action=create after confirmation. Never pick by position or name similarity, and never make a replacement task. A missing filing never blocks work and is reported honestly at completion.' }
		: undefined);
}

export default function hojaMode(pi: any) {
	registerHojaMode(pi);
}
