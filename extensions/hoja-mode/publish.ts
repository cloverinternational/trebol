/** Coarse Hoja publication and lifecycle sync for TaskManage.
 *
 * A session's major work becomes one Hoja issue per top-level task; implementation steps stay local unless the
 * agent marks them. Publication creates or adopts an issue, reads it back, and records the association in the
 * session journal. Once linked, `lifecycle.ts` keeps that issue truthful: current questions and progress in one
 * bounded description block, one evidence comment on accepted completion, then Done.
 *
 * Only an issue this session provably owns (its description carries `hoja-task:<session>:<task>`) is ever written to.
 * A reused or shared issue is never moved, closed or commented on: the session's work becomes a sub-issue beneath it,
 * so linking to someone else's umbrella can never rewrite it.
 *
 * Retry safety has two halves and both are required:
 *   1. Intent before write. The `reconciling` record (marker, project, expected parent) is journaled *before* the
 *      create request leaves the process, so a crash or kill mid-request still leaves a durable trail.
 *   2. Never re-create an unconfirmed write. A `reconciling` task is reconciled by searching Hoja for its marker
 *      (server-side description filter) and validating the read-back. A marker miss is still ambiguous, not proof
 *      that nothing was created, so the task stays `reconciling` until a human resolves it by naming an issue.
 */
import { HojaProjectError, HojaRequestError, type HojaClient, type IssueRef, type IssueView, type Resolved } from "../../.pi/lib/claw/hoja.ts";
import {
	hasLinkMarker, lifecycleWriterOf, managedSection, syncTask, taskFacts,
	type LifecycleState, type TaskFacts,
} from "./lifecycle.ts";

/** Custom session entry type holding one association/attempt record per TaskManage task. */
export const HOJA_TASK_ENTRY = "hoja-task-link";
export const PUBLISH_VALUES = ["publish", "local"] as const;
export const DEFAULT_STATE_PENDING = "Todo";
export const DEFAULT_STATE_ACTIVE = "In Progress";
export const IDENTIFIER_PATTERN = /^[A-Z0-9]+-\d+$/;

export type HojaTaskState = "linked" | "reconciling" | "skipped" | "failed";

/** One durable fact about a task: either it is linked to an issue, or the last attempt's outcome.
 *
 * `projectId` and `expectedParentIssueId` are written with the pre-write intent so reconciliation can prove that a
 * marker hit is the issue this task meant to create, not merely text that contains the marker. */
export type HojaTaskRecord = {
	taskId: string;
	state: HojaTaskState;
	at: string;
	issueId?: string;
	identifier?: string;
	project?: string;
	projectId?: string;
	parentIdentifier?: string;
	expectedParentIssueId?: string;
	/** Set when the project a caller named could not be resolved and the repository's configured project was used
	 *  instead, so the model learns the issue landed somewhere other than where it asked. */
	substitutedFrom?: string;
	marker?: string;
	reason?: string;
	/** Proof of what this session may write to, plus the outcome of its last lifecycle pass. */
	lifecycle?: LifecycleState;
};
export type HojaRecords = Record<string, HojaTaskRecord>;

/** The subset of HojaClient publication needs. Structural, so a test double stays trivial. */
export type HojaWriter = Pick<HojaClient, "resolve" | "createIssue" | "readIssue" | "findIssueByMarker" | "findIssueByIdentifier">;

export interface PublishContext {
	enabled: boolean;
	/** Session identity, used only to keep markers unique across chats. */
	sessionKey: string;
	/** Project used when a task names none (`HOJA_PROJECT`). */
	project?: string;
	/** Repository-declared project (`.pi/config/hoja.json`). Tried after an explicit `metadata.hojaProject` and before
	 *  `project`, so an agent that never names a project — every delegated task — still registers its work. */
	fallbackProject?: string;
	/** Repository-declared assignee; `metadata.hojaAssignee`, else this, else the token's user. */
	fallbackAssignee?: string;
	writer?: HojaWriter;
	records: HojaRecords;
	now?: () => string;
	/** Durable journal write. Called for the pre-write intent *before* any create request, and for every outcome.
	 *  Without it the intent is only returned, which is not durable: pass it from the extension. */
	journal?: (record: HojaTaskRecord) => void;
	/** False once the session that started this batch is gone (off, switch, shutdown). Checked before every writer
	 *  call so a stale batch cannot start new writes; `publishBatch` then returns `stopped: true`. */
	isActive?: () => boolean;
}

export interface PublishOutcome {
	/** Records written in this attempt, in order (intent included). Already journaled when `journal` was supplied. */
	records: HojaTaskRecord[];
	/** Full association map after this attempt. */
	applied: HojaRecords;
	/** Tasks that were considered but could not be attempted, so the model learns what is still unresolved. */
	blocked: HojaTaskRecord[];
	/** True when the batch abandoned its work because its session went away; nothing after that point was written. */
	stopped: boolean;
}

export type PublishCandidate = {
	taskId: string;
	subject: string;
	description?: string;
	parentTaskId?: string;
	status: string;
	op: any;
	/** `sync` means "already linked, keep it current"; it never creates or re-adopts an issue. */
	kind: "publish" | "sync";
	facts: TaskFacts;
};

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** Markers are the only text publication adds to a search expression, so they are restricted to a safe alphabet. */
export function taskMarker(sessionKey: string, taskId: string): string {
	const session = String(sessionKey ?? "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64) || "session";
	const task = String(taskId ?? "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) || "task";
	return `hoja-task:${session}:${task}`;
}

export function issueDescription(input: { description?: string; taskId: string; sessionKey: string; marker: string; managed?: string }): string {
	const body = (input.description ?? "").trim();
	return [
		body,
		`Tracked by TaskManage task #${input.taskId} in session ${input.sessionKey.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 8)}.`,
		`Link marker: ${input.marker}`,
		input.managed ?? "",
	].filter(Boolean).join("\n\n");
}

/** Newest record per task wins; malformed entries are ignored rather than failing a session start. */
export function replayHojaRecords(entries: readonly unknown[]): HojaRecords {
	const records: HojaRecords = {};
	for (const entry of entries) {
		if (!isObject(entry) || entry.type !== "custom" || entry.customType !== HOJA_TASK_ENTRY) continue;
		const data = entry.data;
		if (!isObject(data) || typeof data.taskId !== "string" || !data.taskId) continue;
		if (!["linked", "reconciling", "skipped", "failed"].includes(String(data.state))) continue;
		records[data.taskId] = data as HojaTaskRecord;
	}
	return records;
}

/** Metadata is the explicit contract: `publish` marks major work, `local` keeps a task out of Hoja. */
function metadataOf(op: any): Record<string, unknown> | undefined {
	return isObject(op?.metadata) ? op.metadata as Record<string, unknown> : undefined;
}

function candidateFor(result: any, op: any, task: any, records: HojaRecords): { candidate?: PublishCandidate; rejected?: string } {
	const metadata = metadataOf(op);
	// TaskManage deletes a metadata key when its value is null, so null means "not set", never an invalid value.
	const flag = metadata?.hoja ?? undefined;
	if (flag !== undefined && !(PUBLISH_VALUES as readonly unknown[]).includes(flag))
		return { rejected: "invalid_hoja_metadata" };
	// `local` is absolute: a task the agent kept out of Hoja stays out, even when the same operation also names an
	// issue. Publishing it would contradict the instruction the agent just gave.
	if (flag === "local") return {};
	const namesIssue = metadata?.hojaIssue != null;
	// Any Hoja metadata on an update is a deliberate instruction (typically a corrected project after a skip), so it
	// is the only way an update retries without re-creating the task.
	const touchesHoja = !!metadata && ["hoja", "hojaIssue", "hojaProject", "hojaAssignee"].some((key) => metadata[key] != null);
	if (result.op === "update" && !touchesHoja) {
		// A plain update publishes nothing, but a task this chat already linked still owes its issue the current
		// questions, progress and completion. Without this, TREBOL-577 stayed Todo after its task completed.
		const existing = records[String(task.id)];
		if (existing?.state === "linked" && existing.issueId) return {
			candidate: {
				taskId: String(task.id),
				subject: String(task.subject ?? op.subject ?? "").trim(),
				parentTaskId: typeof task.parent_id === "string" && task.parent_id ? task.parent_id : undefined,
				status: String(task.status ?? "pending"),
				op,
				kind: "sync",
				facts: taskFacts(task),
			},
		};
		return {};
	}
	const parentTaskId = typeof task.parent_id === "string" && task.parent_id ? task.parent_id : undefined;
	// Coarse by default: top-level work publishes; child steps stay local unless promoted explicitly.
	// An update reaches this point only when it carries Hoja metadata, so an unmarked top-level update is deliberate.
	const major = flag === "publish" || (flag === undefined && !parentTaskId);
	if (!major && !namesIssue) return {};
	return {
		candidate: {
			taskId: String(task.id),
			subject: String(task.subject ?? op.subject ?? "").trim(),
			description: typeof op.description === "string" ? op.description : undefined,
			parentTaskId,
			status: String(task.status ?? "pending"),
			op,
			kind: "publish",
			facts: taskFacts(task),
		},
	};
}

/** Reads the TaskManage batch and the call's operations; no Hoja access happens here.
 *
 * Only `create` and `update` results may publish. `get` and `list` return `data.task`/`data.tasks` too, and treating
 * a read as a new piece of work would publish issues for tasks the agent merely looked at. */
export function publishCandidates(params: unknown, batch: unknown, records: HojaRecords = {}): { candidates: PublishCandidate[]; rejected: { taskId: string; reason: string }[] } {
	const results = isObject(batch) && Array.isArray(batch.results) ? batch.results : [];
	const operations = isObject(params) && Array.isArray(params.operations) ? params.operations : [];
	const byKey = new Map<string, any>();
	for (const op of operations) if (isObject(op) && typeof op.key === "string") byKey.set(op.key, op);
	const candidates: PublishCandidate[] = [];
	const rejected: { taskId: string; reason: string }[] = [];
	for (const result of results) {
		if (!isObject(result) || result.status !== "succeeded" || !isObject(result.data)) continue;
		if (result.op !== "create" && result.op !== "update") continue;
		const task = (result.data as any).task;
		if (!isObject(task) || typeof task.id !== "string" || !task.id) continue;
		const op = byKey.get(String(result.key)) ?? { key: result.key, op: result.op, metadata: undefined };
		const { candidate, rejected: reason } = candidateFor(result, op, task, records);
		if (reason) rejected.push({ taskId: task.id, reason });
		else if (candidate) candidates.push(candidate);
	}
	return { candidates, rejected };
}

const record = (taskId: string, state: HojaTaskState, at: string, extra: Partial<HojaTaskRecord> = {}): HojaTaskRecord =>
	({ taskId, state, at, ...extra });

function linkRecord(candidate: PublishCandidate, issue: IssueRef, project: string, at: string, parentIdentifier?: string, substitutedFrom?: string, scope: "owned" | "adopted" = "owned"): HojaTaskRecord {
	return record(candidate.taskId, "linked", at, {
		issueId: issue.id, identifier: issue.identifier, project,
		...(parentIdentifier ? { parentIdentifier } : {}),
		...(substitutedFrom ? { substitutedFrom } : {}),
		lifecycle: { scope },
	});
}

/** What a read-back must prove before an issue is adopted or recorded as this task's issue. A marker that another
 *  issue happens to contain, a different project, or a different parent all mean "not ours": the record stays
 *  `reconciling` and no second issue is created. */
export function readbackMismatch(view: IssueView, expected: { marker: string; projectId?: string; parentIssueId?: string }): string | undefined {
	// Exact `Link marker:` line, so task #1 can never adopt task #10's issue (`…:1` is a prefix of `…:10`).
	if (!hasLinkMarker(view.description, expected.marker)) return "marker_missing";
	if (expected.projectId && view.projectId !== expected.projectId) return "project_mismatch";
	if ((expected.parentIssueId || undefined) !== (view.parentId || undefined)) return "parent_mismatch";
	return undefined;
}

/**
 * Publish the batch's coarse tasks. Resolves with the records to persist; never throws, and never performs a write
 * for a task that already has an association.
 */
export async function publishBatch(params: unknown, batch: unknown, context: PublishContext): Promise<PublishOutcome> {
	const at = context.now ?? (() => new Date().toISOString());
	const applied: HojaRecords = { ...context.records };
	const changed: HojaTaskRecord[] = [];
	const blocked: HojaTaskRecord[] = [];
	const writer = context.writer;
	if (!context.enabled || !writer) return { records: [], applied, blocked: [], stopped: false };
	const active = () => context.isActive?.() !== false;
	const stopped = (): PublishOutcome => ({ records: changed, applied, blocked, stopped: true });
	const set = (next: HojaTaskRecord) => { applied[next.taskId] = next; changed.push(next); context.journal?.(next); };
	// Lifecycle writes journal their own pre-write intent, so their result is committed without a second journal write.
	const commit = (next: HojaTaskRecord) => { applied[next.taskId] = next; changed.push(next); };
	const block = (previous: HojaTaskRecord) => { if (!blocked.some(entry => entry.taskId === previous.taskId)) blocked.push(previous); };
	if (!active()) return stopped();
	const live = lifecycleWriterOf(writer);
	// One idempotent lifecycle pass over a linked issue. `stopped` means the chat went away mid-pass.
	const sync = async (linked: HojaTaskRecord, facts: TaskFacts) => live
		? syncTask({
			writer: live, record: linked, facts, marker: taskMarker(context.sessionKey, facts.taskId),
			sessionKey: context.sessionKey, project: linked.project ?? context.project,
			active, journal: (entry) => context.journal?.(entry), at,
		})
		: undefined;

	// 1. Resolve writes whose outcome is unknown before considering anything new. Only a validated read-back proves
	//    the earlier write landed; a marker miss stays ambiguous, because absence in a filtered search is not proof
	//    that nothing was created, and re-creating on that assumption is exactly how duplicates happen.
	for (const previous of Object.values(context.records)) {
		if (previous.state !== "reconciling" || !previous.marker) continue;
		if (!active()) return stopped();
		let hit: IssueRef | undefined;
		try {
			hit = await writer.findIssueByMarker(previous.marker);
		} catch {
			block(previous);
			continue;
		}
		if (!hit) {
			block(previous);
			continue;
		}
		if (!active()) return stopped();
		let view: IssueView;
		try {
			view = await writer.readIssue(hit.id);
		} catch {
			block(previous);
			continue;
		}
		if (readbackMismatch(view, { marker: previous.marker, projectId: previous.projectId, parentIssueId: previous.expectedParentIssueId })) {
			block(previous);
			continue;
		}
		set(record(previous.taskId, "linked", at(), {
			issueId: view.id, identifier: view.identifier, project: previous.project, marker: previous.marker,
			...(previous.projectId ? { projectId: previous.projectId } : {}),
			...(view.parentIdentifier ? { parentIdentifier: view.parentIdentifier } : {}),
		}));
	}

	const { candidates, rejected } = publishCandidates(params, batch, applied);
	if (!active()) return stopped();
	for (const entry of rejected) set(record(entry.taskId, "skipped", at(), { reason: entry.reason }));

	for (const candidate of candidates) {
		if (!active()) return stopped();
		const previous = applied[candidate.taskId];
		// 1b. An already-linked task keeps its issue current. This is the only path a plain update takes; it can
		//     never create or adopt an issue.
		if (candidate.kind === "sync") {
			if (previous?.state !== "linked" || !previous.issueId) continue;
			const synced = await sync(previous, candidate.facts);
			if (synced?.stopped) return stopped();
			// Only a pass that actually wrote something is reported; a sync with nothing to do must not look like a
			// fresh link in the summary or the model-facing note.
			if (synced && synced.record !== previous) commit(synced.record);
			continue;
		}
		// Already linked: a later operation (including a metadata-bearing retry, the normal backfill of an issue whose
		// lifecycle never ran) syncs the existing issue instead of creating another one.
		if (previous?.state === "linked") {
			const synced = await sync(previous, candidate.facts);
			if (synced?.stopped) return stopped();
			if (synced && synced.record !== previous) commit(synced.record);
			continue;
		}
		const metadata = metadataOf(candidate.op) ?? {};

		// 2. Adopt a named issue. The issue itself is never written to: lifecycle sync goes to a session sub-issue.
		if (metadata.hojaIssue != null) {
			const wanted = String(metadata.hojaIssue).trim().toUpperCase();
			if (!IDENTIFIER_PATTERN.test(wanted)) {
				set(record(candidate.taskId, "skipped", at(), { reason: "invalid_hoja_issue" }));
				continue;
			}
			let hit: IssueRef | undefined;
			try {
				hit = await writer.findIssueByIdentifier(wanted);
			} catch {
				set(record(candidate.taskId, "failed", at(), { reason: "lookup_failed", identifier: wanted }));
				continue;
			}
			if (!hit) {
				set(record(candidate.taskId, "failed", at(), { reason: "issue_not_found", identifier: wanted }));
				continue;
			}
			// Never link an identifier the caller did not name.
			if (hit.identifier.toUpperCase() !== wanted) {
				set(record(candidate.taskId, "failed", at(), { reason: "identifier_mismatch", identifier: wanted }));
				continue;
			}
			// The linked record remembers that this issue belongs to someone else, so no later pass can write to it.
			const adopted = record(candidate.taskId, "linked", at(), {
				issueId: hit.id, identifier: hit.identifier,
				project: typeof metadata.hojaProject === "string" ? metadata.hojaProject : undefined,
				lifecycle: { scope: "adopted" },
			});
			set(adopted);
			const syncedAdopted = await sync(adopted, candidate.facts);
			if (syncedAdopted?.stopped) return stopped();
			if (syncedAdopted) commit(syncedAdopted.record);
			continue;
		}
		// An unconfirmed write is never repeated for the same task: creating again could duplicate the issue. The only
		// way out is an explicit identifier (above), which is a deliberate human resolution.
		if (previous?.state === "reconciling") {
			block(previous);
			continue;
		}

		// 3. Create. Every project name here was declared by someone — the agent for this task, the repository, or the
		//    environment — and the server decides whether it exists. Names are never derived from the workspace path:
		//    a directory called "trebol" is not a project, and publishing into a guess is worse than not publishing.
		const named = typeof metadata.hojaProject === "string" && metadata.hojaProject.trim() ? metadata.hojaProject.trim() : undefined;
		// The chat's own target first (a project the user picked, or the environment), then the repository default: an
		// explicit per-chat choice must beat the checkout's declaration.
		const projects = [...new Set([named, context.project, context.fallbackProject]
			.map(value => value?.trim())
			.filter((value): value is string => !!value))];
		if (!projects.length) {
			set(record(candidate.taskId, "skipped", at(), { reason: "no_project" }));
			continue;
		}
		const assignee = typeof metadata.hojaAssignee === "string" && metadata.hojaAssignee.trim()
			? metadata.hojaAssignee.trim()
			: context.fallbackAssignee;
		let resolved: Resolved | undefined;
		for (const project of projects) {
			try {
				resolved = await writer.resolve(project, assignee);
				break;
			} catch (error) {
				// Only an unresolvable *project* falls through to the next declared name. An assignee that is not a team
				// member is a real configuration error and must not be hidden by publishing to another project.
				if (!(error instanceof HojaProjectError)) break;
				if (!active()) return stopped();
			}
		}
		if (!resolved) {
			set(record(candidate.taskId, "failed", at(), { reason: "project_unresolved", project: projects[0], ...(named && projects[1] ? { substitutedFrom: named } : {}) }));
			continue;
		}
		// The agent named a project that does not exist and the repository's project was used: say so in the record and
		// in the model-facing note, so a wrong name never passes silently.
		const substitutedFrom = named && resolved.project.trim().toLowerCase() !== named.toLowerCase() ? named : undefined;
		const state = candidate.status === "in_progress" ? DEFAULT_STATE_ACTIVE : DEFAULT_STATE_PENDING;
		if (!resolved.states[state.toLowerCase()]) {
			set(record(candidate.taskId, "skipped", at(), { reason: "state_unavailable", project: resolved.project }));
			continue;
		}
		const parent = candidate.parentTaskId ? applied[candidate.parentTaskId] : undefined;
		// A promoted step is never silently filed as a root issue. Without a published parent, the step is deferred and
		// retried on a later batch, once the parent has an issue of its own.
		if (candidate.parentTaskId && (parent?.state !== "linked" || !parent.issueId)) {
			set(record(candidate.taskId, "skipped", at(), { reason: "parent_unpublished", project: resolved.project }));
			continue;
		}
		const parentIssueId = parent?.state === "linked" ? parent.issueId : undefined;
		const marker = taskMarker(context.sessionKey, candidate.taskId);
		// The managed block is part of the create: acceptance questions are visible from the first read, with no
		// extra write and no separate issue per question.
		const description = issueDescription({
			description: candidate.description, taskId: candidate.taskId, sessionKey: context.sessionKey, marker,
			managed: managedSection(candidate.facts),
		});
		// Durable intent before the request leaves the process. A crash here leaves `reconciling` with everything
		// reconciliation needs (marker, project, expected parent), so the next run adopts instead of re-creating.
		set(record(candidate.taskId, "reconciling", at(), {
			reason: "write_in_flight", marker, project: resolved.project, projectId: resolved.projectId,
			...(parentIssueId ? { expectedParentIssueId: parentIssueId } : {}),
		}));
		if (!active()) return stopped();
		let created: IssueRef;
		try {
			created = await writer.createIssue(resolved, candidate.subject, description, state, parentIssueId ? { parentId: parentIssueId } : {});
		} catch (error) {
			// An ambiguous failure may have committed. Record the marker so the next attempt reconciles first.
			if (error instanceof HojaRequestError && error.ambiguous)
				set(record(candidate.taskId, "reconciling", at(), {
					reason: "ambiguous_write", marker, project: resolved.project, projectId: resolved.projectId,
					...(parentIssueId ? { expectedParentIssueId: parentIssueId } : {}),
				}));
			else set(record(candidate.taskId, "failed", at(), { reason: "create_failed", project: resolved.project }));
			continue;
		}
		// Past this point the issue exists. If the session went away we journal nothing more: the intent above already
		// marks the task unconfirmed, and the next run reconciles it by marker instead of creating a second issue.
		if (!active()) return stopped();
		let view: IssueView;
		try {
			view = await writer.readIssue(created.id);
		} catch {
			set(record(candidate.taskId, "reconciling", at(), {
				reason: "readback_unverified", issueId: created.id, identifier: created.identifier, marker,
				project: resolved.project, projectId: resolved.projectId,
				...(parentIssueId ? { expectedParentIssueId: parentIssueId } : {}),
			}));
			continue;
		}
		const mismatch = readbackMismatch(view, { marker, projectId: resolved.projectId, parentIssueId });
		if (mismatch) {
			set(record(candidate.taskId, "reconciling", at(), {
				reason: "readback_mismatch", issueId: created.id, identifier: created.identifier, marker,
				project: resolved.project, projectId: resolved.projectId,
				...(parentIssueId ? { expectedParentIssueId: parentIssueId } : {}),
			}));
			continue;
		}
		const linked = linkRecord(candidate, view, resolved.project, at(), view.parentIdentifier ?? parent?.identifier, substitutedFrom);
		set(linked);
		// First pass: completes the description from the authoritative task when it differs, and closes an issue whose
		// task was already completed before it was linked.
		const synced = await sync(linked, candidate.facts);
		if (synced?.stopped) return stopped();
		if (synced && synced.record !== linked) commit(synced.record);
	}
	return { records: changed, applied, blocked, stopped: false };
}

/** One record per task: the newest write in this attempt, so the pre-write intent is never reported as an outcome. */
function finalRecords(records: readonly HojaTaskRecord[]): HojaTaskRecord[] {
	const latest = new Map<string, HojaTaskRecord>();
	for (const record of records) latest.set(record.taskId, record);
	return [...latest.values()];
}

/** A one-line user-visible summary; no identifiers beyond what a notification needs. */
export function publicationSummary(outcome: Pick<PublishOutcome, "records" | "blocked">): string | undefined {
	const records = finalRecords(outcome.records);
	const linked = records.filter(r => r.state === "linked" && r.identifier);
	const closed = linked.filter(r => r.lifecycle?.closed);
	const failed = records.filter(r => r.state === "failed" || r.state === "reconciling");
	const skipped = records.filter(r => r.state === "skipped");
	const parts: string[] = [];
	if (linked.length) parts.push(`Hoja: ${linked.map(r => `${r.identifier} for task #${r.taskId}`).join(", ")}`);
	if (closed.length) parts.push(`Hoja closed ${closed.map(r => r.identifier).join(", ")}`);
	if (failed.length) parts.push(`Hoja not confirmed for task(s) ${failed.map(r => `#${r.taskId}`).join(", ")}`);
	// Configuration problems would otherwise be silent: nothing is published and nobody learns why.
	if (skipped.length) parts.push(`Hoja skipped task(s) ${skipped.map(r => `#${r.taskId} (${r.reason})`).join(", ")}`);
	const unresolved = outcome.blocked.filter(r => !records.some(c => c.taskId === r.taskId && c.state === "linked"));
	if (unresolved.length) parts.push(`Hoja unresolved for task(s) ${unresolved.map(r => `#${r.taskId} (${r.reason ?? r.state})`).join(", ")}`);
	return parts.length ? parts.join("; ") : undefined;
}

/** What went wrong, and what the agent can do about it. Publication is automatic, so the model has to learn the
 *  outcome from the tool result it just received: a UI notification is invisible to it. */
const REASON_GUIDANCE: Record<string, string> = {
	no_project:
		'no Hoja project is configured for this repository, so nothing was created. Add .pi/config/hoja.json with {"project":"<exact name>"} so every chat in this checkout files there, or call hoja_project action=list, then ask_user_question where to file the work; offer to create a project if none matches. Use hoja_project action=select or action=create for the user-chosen destination, then retry this task with metadata.hojaProject. The work is not blocked: bounded discovery already ran and its note lists the existing projects.',
	project_unresolved:
		'no declared Hoja project could be resolved (not found, hidden from this token, or its team did not resolve). Fix .pi/config/hoja.json, or call hoja_project action=list (hoja_list only lists issues), then ask_user_question where to file the work and offer a new project. Select/create the user-chosen destination and retry this same task with metadata.hojaProject. The work is not blocked; discovery ran and reports the existing projects.',
	state_unavailable:
		"the project's team has no Todo/In Progress workflow state, so nothing was created. Publication is skipped for this team.",
	invalid_hoja_metadata: 'metadata.hoja must be "publish" or "local".',
	invalid_hoja_issue: 'metadata.hojaIssue must look like TEAM-123.',
	issue_not_found: "the named issue does not exist or is not visible to this token. Check it with hoja_get, then fix or drop metadata.hojaIssue.",
	identifier_mismatch: "the lookup returned a different identifier than the one named, so nothing was linked. Re-check the identifier with hoja_get.",
	lookup_failed: "the issue lookup failed. A later TaskManage batch for this task retries it.",
	create_failed: "Hoja rejected the create, so nothing was created. A later TaskManage batch for this task retries it.",
	parent_unpublished:
		"its parent task has no Hoja issue in this chat, so it was NOT filed as a root issue. Publish the parent (metadata {\"hoja\":\"publish\"}) or link this task to an existing issue with metadata {\"hojaIssue\":\"TEAM-123\"}.",
};

/** Reasons that mean "the write may have landed and is unconfirmed", not "nothing happened". */
const UNCONFIRMED_REASONS = new Set(["write_in_flight", "ambiguous_write", "readback_unverified", "readback_mismatch"]);
const UNCONFIRMED =
	"an earlier Hoja create for this task is unconfirmed, so no second issue was created. Find it with hoja_list/hoja_get and link it explicitly with metadata {\"hojaIssue\":\"TEAM-123\"}; publication stays blocked on this task until then.";

/** Lifecycle failures the model must act on. A write it cannot confirm is never repeated automatically, so the
 *  guidance always names the read that resolves it. */
const LIFECYCLE_GUIDANCE: Record<string, string> = {
	sync_read_failed: "the linked issue could not be read back, so its questions, progress and status were not synchronized. A later TaskManage batch retries.",
	description_failed: "Hoja rejected the questions/progress update; the issue keeps its previous description. A later batch retries.",
	description_ambiguous: "the questions/progress update was ambiguous; it is idempotent (the managed block is recomputed from the live description), so a later batch safely retries it.",
	description_unverified: "the questions/progress write could not be proved by read-back (block missing, or human text changed), so nothing further was written. Check the issue with hoja_get.",
	completion_unaccepted: "the task is marked completed but at least one acceptance question has no answer, so the issue was NOT closed. Answer the question with evidence on the task, then complete it again.",
	comment_failed: "Hoja rejected the completion comment, so the issue was left open. A later batch retries it.",
	comment_ambiguous: "the completion comment may or may not have been posted. The issue was left open and the comment is never repeated automatically; check it with hoja_get.",
	comment_unverified: "the completion comment could not be read back after writing, so the issue was left open. Check it with hoja_get; the next batch reconciles by marker.",
	comment_unconfirmed: "an earlier completion comment is unconfirmed. No second comment was posted and the issue stays open; read its comments with hoja_get before deciding.",
	comment_pending: "an earlier completion comment was journaled but its outcome is unknown (the chat stopped mid-write). No second comment was posted; read the issue's comments with hoja_get before deciding.",
	state_failed: "Hoja rejected the workflow transition; the issue keeps its current state. A later batch retries.",
	state_ambiguous: "the workflow transition was ambiguous. Check the issue's state with hoja_get before retrying.",
	state_unverified: "the workflow transition could not be verified by read-back. Check the issue's state with hoja_get.",
	state_project_unknown: "the issue has no project to resolve workflow states from, so its state was left unchanged.",
	state_unresolved: "the project or team workflow states could not be resolved, so the issue's state was left unchanged.",
	state_target_mismatch: "the resolved project/team is not the issue's own team and project, so no state id was written.",
	shared_unowned:
		"this issue was not proven to belong to this task (its description lacks this session's marker), so nothing was written to it. Set metadata.hojaProject and let publication create a session issue, or link an issue this session owns.",
	shared_target_mismatch: "the shared issue's team differs from the resolved project's team, so no session sub-issue was created and nothing was written.",
	shared_project_unresolved: "a session sub-issue under the shared issue could not be created because the project did not resolve; the shared issue was left untouched.",
	subissue_failed: "the session sub-issue under the shared issue was rejected, so no lifecycle write was made to either issue.",
	subissue_ambiguous: "a session sub-issue under the shared issue may have been created but is unconfirmed; it is never repeated automatically. Find it with hoja_list and link it explicitly with metadata.hojaIssue.",
	subissue_unverified: "the session sub-issue could not be read back, so the shared issue was left untouched and no lifecycle write continues from here.",
	subissue_unconfirmed: "an earlier session sub-issue creation is unconfirmed; nothing was written to the shared issue and no second sub-issue was created. Find it with hoja_list and link it explicitly.",
	subissue_pending: "an earlier session sub-issue creation was journaled but its outcome is unknown (the chat stopped mid-write), so it is treated as ambiguous and never retried. Find it with hoja_list; do not expect an automatic retry.",
};

/** The model-facing outcome of one publication attempt, appended to the TaskManage result.
 *
 * The extension cannot rely on a notification: only tool result content reaches the model, and a silent skip is how
 * an agent keeps believing work was filed when it was not. */
export function publicationNote(outcome: Pick<PublishOutcome, "records" | "blocked" | "stopped">): string | undefined {
	const records = finalRecords(outcome.records);
	const linked = records.filter(r => r.state === "linked" && r.identifier);
	const lines: string[] = [];
	if (linked.length)
		lines.push(`Hoja publication: linked ${linked.map(r => `${r.identifier} (task #${r.taskId}${r.parentIdentifier ? `, child of ${r.parentIdentifier}` : ""})`).join(", ")}.`);
	// The agent named a project that does not exist and the repository's project was used instead: say so, so a wrong
	// name never passes as if it had been honoured.
	for (const record of linked) {
		if (record.substitutedFrom)
			lines.push(`Hoja publication: ${record.identifier} was filed in project "${record.project}" because "${record.substitutedFrom}" does not exist; the repository project was used (.pi/config/hoja.json).`);
	}
	// Lifecycle outcomes are only visible here: the model cannot see a notification, and "linked" alone does not say
	// whether the issue was kept current, commented on or closed.
	for (const record of records) {
		const reason = record.lifecycle?.error;
		if (!reason) continue;
		const where = record.identifier ? `${record.identifier} (task #${record.taskId})` : `task #${record.taskId}`;
		lines.push(`Hoja lifecycle: ${where} — ${LIFECYCLE_GUIDANCE[reason] ?? `reason: ${reason}.`}`);
	}
	for (const record of linked) {
		if (!record.lifecycle?.closed) continue;
		lines.push(`Hoja lifecycle: ${record.identifier} is Done — questions, progress and the evidence comment are written.`);
	}
	for (const record of records) {
		if (record.state === "linked") continue;
		if (UNCONFIRMED_REASONS.has(record.reason ?? "")) {
			lines.push(`Hoja publication: task #${record.taskId} — ${UNCONFIRMED}`);
			continue;
		}
		const guidance = REASON_GUIDANCE[record.reason ?? ""] ?? (record.reason ? `reason: ${record.reason}.` : undefined);
		lines.push(`Hoja publication: nothing was created for task #${record.taskId} — ${guidance ?? "the attempt did not complete."}`);
	}
	const reported = new Set(records.map(r => r.taskId));
	for (const record of outcome.blocked) {
		if (reported.has(record.taskId) || record.state === "linked") continue;
		lines.push(`Hoja publication: task #${record.taskId} — ${UNCONFIRMED}`);
	}
	if (!lines.length) return undefined;
	if (outcome.stopped)
		lines.push("Hoja publication stopped early because Hoja mode was turned off or the chat changed; no further writes were attempted.");
	return lines.join("\n");
}
