import { modeFooter } from "../../.pi/lib/runtime/mode-footer.ts";
/** Hoja mode: read-only Hoja tools, coarse TaskManage → Hoja publication, and a rule that makes the agent check
 *  Hoja before advising on work. */
import { HojaClient, HojaRequestError } from "../../.pi/lib/claw/hoja.ts";
import { latestSessionModeEntry } from "../../.pi/lib/runtime/session-mode-entry.ts";
import { HOJA_GET_CONTRACT, HOJA_LIST_CONTRACT } from "../../.pi/lib/tools/swarm-hoja.contract.ts";
import {
	HOJA_TASK_ENTRY, publicationNote, publicationSummary, publishBatch, replayHojaRecords,
	type HojaRecords, type HojaTaskRecord, type HojaWriter, type PublishOutcome,
} from "./publish.ts";

export const HOJA_RULE = "Hoja mode: for any question about work, status, priority, or what to do next, call hoja_list (or hoja_get for one identifier) before answering. Automatic publication is on: TaskManage publishes one Hoja issue per coarse task — a task with no parent, or one marked metadata {\"hoja\":\"publish\"} — and keeps steps local with metadata {\"hoja\":\"local\"} (child tasks stay local unless promoted; a promoted child is created under its parent's issue and is deferred rather than filed as a root). Before starting, check the project and whether an issue already exists: run hoja_list with the project name to confirm it is visible, set metadata {\"hojaProject\":\"<exact project name>\"} for a non-default project, and {\"hojaIssue\":\"TREBOL-123\"} to reuse an existing issue. Publication is automatic, so read its outcome in the TaskManage result and act on it: a no_project skip creates nothing and is retried only when you set metadata.hojaProject on a later TaskManage update of that task, and an unconfirmed create is never repeated automatically. This mode never moves, closes or comments on an issue, including a reused or shared one; state the exact change and ask the user to confirm it in this conversation. /hoja off disables publication and this guidance for the chat; hoja_list and hoja_get stay read-only.";
export const HOJA_ENTRY = "hoja-mode";

/** Every Hoja read is one of these two constant documents. No caller-supplied GraphQL ever reaches the client:
 *  filters travel as typed variables (IssueFilter), which GraphQL parses as data, never as query text. */
export const HOJA_QUERIES = {
	list: `query ($first: Int!, $filter: IssueFilter) { issues(first: $first, filter: $filter) { nodes { identifier title priority createdAt updatedAt state { name } assignee { name } project { name } } } }`,
	get: `query ($first: Int!, $filter: IssueFilter, $comments: Int!) { issues(first: $first, filter: $filter) { nodes { identifier title description priority createdAt updatedAt url state { name type } team { key } assignee { name } project { name } comments(first: $comments) { nodes { body createdAt user { name } } } } } }`,
} as const;

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
				try {
					const wanted = String(params.identifier ?? "").trim().toUpperCase();
					if (!/^[A-Z0-9]+-\d+$/.test(wanted)) throw new Error(`identifier must look like TEAM-123, for example TREBOL-237 (got "${params.identifier ?? ""}")`);
					const requested = integer(params.comments, "comments", DEFAULT_COMMENTS, 1, MAX_COMMENTS);
					// Server-side lookup by identifier: works for any issue, however old, without paginating the board.
					const nodes = (await client.gql<{ issues: { nodes: IssueDetail[] } }>(HOJA_QUERIES.get, {
						first: 2, filter: { identifier: { eq: wanted } }, comments: requested,
					})).issues.nodes;
					// Never present a different issue as the answer if the server ignores the filter.
					const detail = nodes.find(i => i.identifier.toUpperCase() === wanted);
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
	/** Project used when a task names none; defaults to HOJA_PROJECT. */
	project?: string;
}

export function registerHojaMode(pi: any, client: Gql = new HojaClient(), options: HojaModeOptions = {}) {
	let enabled = true;
	let records: HojaRecords = {};
	/** Bumped on /hoja off, session start and shutdown. A batch captures it and stops before its next write when it
	 *  no longer matches, so a stale in-flight batch can never publish into a chat that is gone or turned off. */
	let generation = 0;
	/** Publication is serialized: one batch at a time, in order, so a second TaskManage call always sees the first
	 *  batch's associations instead of racing it into a duplicate issue. */
	let queue: Promise<unknown> = Promise.resolve();
	const footer = modeFooter("hoja", () => enabled);
	const writer = asWriter(client);
	const project = () => options.project ?? (process.env.HOJA_PROJECT?.trim() || undefined);
	const setEnabled = (next: boolean) => {
		enabled = next;
		generation += 1;
		pi.appendEntry?.(HOJA_ENTRY, { enabled });
	};
	for (const tool of hojaTools(client)) pi.registerTool(tool);
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
			ctx.ui?.notify?.(`Hoja mode ${enabled ? "on" : "off"}. ${enabled ? "Work questions check Hoja first; coarse TaskManage tasks publish to Hoja." : "Automatic publication and Hoja-first guidance disabled; read tools remain available."} Hoja tools are read-only and publication never moves or closes an issue. Saved per chat; kept across /reload, resume and fork.`, "info");
		},
	});
	// A new chat has no saved entry and starts on; a reloaded or resumed chat restores its own saved choice.
	pi.on("session_start", (_event: unknown, ctx: any) => {
		generation += 1;
		enabled = latestSessionModeEntry<{ enabled?: boolean }>(ctx, HOJA_ENTRY)?.enabled !== false;
		// Associations are journaled per chat, so a reload or resume can never publish the same task twice.
		records = replayHojaRecords(ctx?.sessionManager?.getBranch?.() ?? ctx?.sessionManager?.getEntries?.() ?? []);
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
		const sessionKey = String(ctx?.sessionManager?.getSessionId?.() ?? "session");
		const work = async () => {
			let outcome: PublishOutcome;
			try {
				outcome = await publishBatch(event.input, batch, {
					enabled: true, sessionKey, project: project(), writer, records,
					// The intent is journaled before the create request, so a crash mid-write leaves a durable trail.
					journal: (entry: HojaTaskRecord) => {
						if (startGeneration === generation) pi.appendEntry?.(HOJA_TASK_ENTRY, entry);
					},
					isActive: () => startGeneration === generation,
				});
			} catch {
				// A publication bug must never fail the TaskManage call that already succeeded.
				if (startGeneration === generation) ctx?.ui?.notify?.("Hoja publication did not run; task state is unaffected.", "warning");
				return undefined;
			}
			// The chat changed or the mode went off while this batch ran: its state belongs to the old chat.
			if (startGeneration !== generation) return undefined;
			records = outcome.applied;
			const summary = publicationSummary(outcome);
			if (summary) ctx?.ui?.notify?.(summary, outcome.records.every(r => r.state === "linked") && !outcome.blocked.length ? "info" : "warning");
			// The model, not the UI, has to learn the outcome: a notification is invisible to it, and a silent skip is
			// how an agent keeps believing work was filed when it was not.
			const note = publicationNote(outcome);
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
		? { systemPrompt: String(event.systemPrompt ?? "") + "\n" + HOJA_RULE }
		: undefined);
}

export default function hojaMode(pi: any) {
	registerHojaMode(pi);
}
