/** Lifecycle synchronization for a Hoja issue this session owns.
 *
 * Publication creates or links an issue; this module keeps that issue truthful afterwards: current acceptance
 * questions and progress live in one bounded description block, and an accepted local completion posts exactly one
 * answer comment and then moves the issue to Done.
 *
 * Ownership is proved, not assumed. A write is allowed only when the issue description carries this session's exact
 * `hoja-task:<session>:<task>` marker. A reused or shared issue does not, so it is never moved, commented on or
 * closed: the session's work becomes one sub-issue beneath it, and the shared issue is left byte-for-byte untouched.
 *
 * Every write is idempotent by construction:
 *   - the managed block is computed from the live description and written only when it differs;
 *   - the completion comment carries a stable answer marker that is looked up before the write, so resume and
 *     repeated completions never post twice;
 *   - a comment whose outcome is unknown is recorded `unconfirmed` and is never repeated blindly — the next attempt
 *     reports it instead of writing again.
 */
import { HojaRequestError, type IssueRef, type IssueView, type Resolved } from "../../.pi/lib/claw/hoja.ts";
import type { HojaTaskRecord } from "./publish.ts";

/** Bounded block ownership: text outside these markers belongs to humans and is preserved verbatim. */
export const MANAGED_START = "<!-- hoja-managed:start -->";
export const MANAGED_END = "<!-- hoja-managed:end -->";
/** The only state this module sets; a team that lacks it records a failure instead of guessing another. */
export const DONE_STATE = "Done";

export type TaskQuestion = { id: string; text: string; answer?: string; evidence?: string };
export type TaskFacts = {
	taskId: string;
	subject: string;
	status: string;
	description?: string;
	questions: TaskQuestion[];
};

/** How much of an issue this session may write to. `adopted` means "linked to someone else's issue": write nothing
 *  there and put the session's work in a sub-issue instead. */
export type LifecycleState = {
	scope: "owned" | "adopted";
	comment?: "pending" | "posted" | "unconfirmed" | "failed";
	commentMarker?: string;
	closed?: boolean;
	subissue?: "pending" | "unconfirmed";
	umbrellaIdentifier?: string;
	error?: string;
	at?: string;
};

export type LifecycleWriter = {
	resolve(project: string, assignee?: string): Promise<Resolved>;
	readIssue(issueId: string): Promise<IssueView>;
	createIssue(r: Resolved, title: string, description: string, state?: string, options?: { parentId?: string }): Promise<IssueRef>;
	comment(issueId: string, body: string): Promise<void>;
	setState(r: Pick<Resolved, "states" | "teamKey">, issueId: string, state: string): Promise<void>;
	setDescription(issueId: string, description: string): Promise<void>;
};

/** A read-only client (or a test double) has no lifecycle surface; publication then links and stops. */
export function lifecycleWriterOf(writer: unknown): LifecycleWriter | undefined {
	const candidate = writer as Partial<LifecycleWriter> | undefined;
	const methods = ["resolve", "readIssue", "createIssue", "comment", "setState", "setDescription"] as const;
	return candidate && methods.every((method) => typeof candidate[method] === "function") ? candidate as LifecycleWriter : undefined;
}

const trimmed = (value: unknown): string | undefined =>
	typeof value === "string" && value.trim() ? value.trim() : undefined;

/** The authoritative task shape TaskManage returns: `questions` (id, text) plus `answers` (question, answer,
 *  evidence). Older payloads inline the answer on the question, so both are read. */
export function taskFacts(task: any): TaskFacts {
	const answers = Array.isArray(task?.answers) ? task.answers : [];
	const answerFor = (id: string) => answers.find((entry: any) => entry && entry.question === id);
	const questions: TaskQuestion[] = [];
	for (const question of Array.isArray(task?.questions) ? task.questions : []) {
		if (!question || typeof question.id !== "string") continue;
		const answer = answerFor(question.id);
		questions.push({
			id: question.id,
			text: typeof question.text === "string" ? question.text : "",
			...(trimmed(answer?.answer) ?? trimmed(question.answer) ? { answer: trimmed(answer?.answer) ?? trimmed(question.answer) } : {}),
			...(trimmed(answer?.evidence) ?? trimmed(question.evidence) ? { evidence: trimmed(answer?.evidence) ?? trimmed(question.evidence) } : {}),
		});
	}
	return {
		taskId: String(task?.id ?? ""),
		subject: String(task?.subject ?? "").trim(),
		status: String(task?.status ?? "pending"),
		...(trimmed(task?.description) ? { description: trimmed(task?.description) } : {}),
		questions,
	};
}

/** A completion the local workflow accepted: every acceptance question carries an answer. Evidence is included in
 *  the comment when present; a question without an answer means completion was not accepted, so nothing closes. */
export function acceptedCompletion(facts: TaskFacts): boolean {
	return facts.status === "completed" && facts.questions.every((question) => !!question.answer);
}

/** The managed block: status plus the acceptance questions. Questions are tracked here, never as separate issues. */
export function managedSection(facts: TaskFacts): string {
	const lines = [MANAGED_START, `Status: ${facts.status}`];
	if (facts.questions.length) {
		lines.push("", "Acceptance questions (tracked here, not as separate issues):");
		for (const question of facts.questions) {
			lines.push(`- [${question.answer ? "x" : " "}] \`${question.id}\` ${question.text}`);
			if (question.answer) lines.push(`  - Answer: ${question.answer}`);
			if (question.evidence) lines.push(`  - Evidence: ${question.evidence}`);
		}
	}
	lines.push(MANAGED_END);
	return lines.join("\n");
}

/** Replaces only the managed block, keeping every human byte before and after it. Without a block the section is
 *  appended, so an issue written by an older version gains one without losing its description. */
export function mergeManagedDescription(existing: string, section: string): string {
	const start = existing.indexOf(MANAGED_START);
	const end = existing.indexOf(MANAGED_END);
	if (start !== -1 && end > start) return `${existing.slice(0, start)}${section}${existing.slice(end + MANAGED_END.length)}`;
	if (!existing) return section;
	// Keep the human text byte-for-byte, including trailing spaces and newlines; only the separator is added.
	const separator = existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
	return `${existing}${separator}${section}`;
}

/** A line-anchored marker match. Ownership and comment dedupe must never use `includes`: `…:1` is a prefix of
 *  `…:10`, and prose can quote a marker it does not own. The marker has to be the whole `Label: value` line. */
export function hasMarkerLine(text: string, label: string, marker: string): boolean {
	if (!marker) return false;
	const wanted = `${label}: ${marker}`;
	return String(text ?? "").split(/\r?\n/).some((line) => line.trim() === wanted);
}

/** This session's ownership marker for a task, as written by `issueDescription`. */
export const hasLinkMarker = (description: string, marker: string): boolean => hasMarkerLine(description, "Link marker", marker);
/** The completion comment marker, as written by `completionComment`. */
export const hasAnswerMarker = (comment: string, marker: string): boolean => hasMarkerLine(comment, "Answer marker", marker);

/** Content revision of the accepted answers. A changed answer set produces a different marker (and therefore one new
 *  comment); an identical repeated completion produces the same marker and posts nothing. */
export function answerRevision(facts: TaskFacts): string {
	const canonical = facts.questions
		.map((question) => [question.id, question.text, question.answer ?? "", question.evidence ?? ""].join("\u001f"))
		.join("\u001e");
	let hash = 0x811c9dc5;
	for (const char of canonical) {
		hash ^= char.codePointAt(0) ?? 0;
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Stable per-task, per-revision comment marker: proves a completion comment exists before writing another. */
export function answerMarker(sessionKey: string, taskId: string, revision: string): string {
	const session = String(sessionKey ?? "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64) || "session";
	const task = String(taskId ?? "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) || "task";
	return `hoja-answer:${session}:${task}:${revision}`;
}

/** Text outside the managed block, so a write can be proved not to have eaten human description. */
export function outsideManaged(text: string): { prefix: string; suffix: string } {
	const start = text.indexOf(MANAGED_START);
	const end = text.indexOf(MANAGED_END);
	if (start === -1 || end <= start) return { prefix: text, suffix: "" };
	return { prefix: text.slice(0, start), suffix: text.slice(end + MANAGED_END.length) };
}

/** The one evidence-bearing comment a completed task posts to its own issue. */
export function completionComment(facts: TaskFacts, marker: string): string {
	const lines = [`TaskManage task #${facts.taskId} completed: ${facts.subject}`, "", `Answer marker: ${marker}`];
	if (!facts.questions.length) lines.push("", "This task recorded no acceptance questions.");
	else {
		lines.push("", "Answers:");
		for (const question of facts.questions) {
			lines.push(`- \`${question.id}\` ${question.text}`, `  - Answer: ${question.answer ?? "(unanswered)"}`);
			if (question.evidence) lines.push(`  - Evidence: ${question.evidence}`);
		}
	}
	return lines.join("\n");
}

const stateFor = (facts: TaskFacts): string => (facts.status === "in_progress" ? "In Progress" : "Todo");

/** Fresh sub-issue body for a session working beneath a shared issue: marker first, then the managed block. */
export function subissueDescription(facts: TaskFacts, marker: string): string {
	return [facts.description, `Link marker: ${marker}`, managedSection(facts)].filter(Boolean).join("\n\n");
}

export type SyncArgs = {
	writer: LifecycleWriter;
	record: HojaTaskRecord;
	facts: TaskFacts;
	/** This session's exact ownership marker for the task. */
	marker: string;
	sessionKey: string;
	/** Project used when the record does not name one. */
	project?: string;
	active: () => boolean;
	journal: (record: HojaTaskRecord) => void;
	at: () => string;
};

export type SyncResult = { record: HojaTaskRecord; stopped: boolean; writes: number; error?: string };

/**
 * One lifecycle pass over a linked issue. Never throws: a Hoja problem becomes a recorded error the model can read.
 * `stopped` means the session went away and nothing further was written.
 */
export async function syncTask(args: SyncArgs): Promise<SyncResult> {
	const { writer, facts, active, journal, at } = args;
	let record = args.record;
	let writes = 0;
	let error: string | undefined;

	const current = (): LifecycleState => record.lifecycle ?? { scope: "owned" };
	const save = (next: LifecycleState, extra: Partial<HojaTaskRecord> = {}) => {
		record = { ...record, ...extra, lifecycle: { ...next, at: at() } };
		journal(record);
		return record;
	};
	const fail = (reason: string): SyncResult => {
		error = reason;
		save({ ...current(), error: reason });
		return { record, stopped: false, writes, error };
	};

	if (!record.issueId) return { record, stopped: false, writes };
	// A deleted task is not work any more: touch nothing.
	if (facts.status === "deleted") return { record, stopped: false, writes };
	if (!active()) return { record, stopped: true, writes };

	let view: IssueView;
	try {
		view = await writer.readIssue(record.issueId);
	} catch {
		return fail("sync_read_failed");
	}

	let lifecycle = current();
	// Ownership is the exact `Link marker:` line, never a substring: `…:1` must not match `…:10`, and prose that
	// quotes a marker is not ownership. A record can predate this feature; the marker in the issue is the proof.
	let owned = hasLinkMarker(view.description, args.marker);

	// A shared issue is never written to. The session's work goes into one sub-issue beneath it, created once.
	if (!owned && lifecycle.scope === "adopted") {
		// `pending` was journaled before the create left the process. A crash there may have committed, so it is
		// ambiguous exactly like `unconfirmed` and is never retried as a create.
		if (lifecycle.subissue === "pending" || lifecycle.subissue === "unconfirmed")
			return fail(lifecycle.subissue === "pending" ? "subissue_pending" : "subissue_unconfirmed");
		const project = record.project ?? args.project;
		if (!project) return fail("shared_unowned");
		if (!active()) return { record, stopped: true, writes };
		let resolved: Resolved;
		try {
			resolved = await writer.resolve(project);
		} catch {
			return fail("shared_project_unresolved");
		}
		// A sub-issue must live in its parent's team; never create across teams on a guess.
		if (resolved.teamId !== view.teamId) return fail("shared_target_mismatch");
		// Durable intent before the request leaves the process, exactly like a root create.
		save({ ...lifecycle, subissue: "pending", umbrellaIdentifier: view.identifier });
		if (!active()) return { record, stopped: true, writes };
		let child: IssueRef;
		try {
			child = await writer.createIssue(resolved, facts.subject, subissueDescription(facts, args.marker), stateFor(facts), { parentId: view.id });
		} catch (failure) {
			// An ambiguous sub-issue is never repeated: a second one would be a duplicate of the session's own work.
			if (failure instanceof HojaRequestError && failure.ambiguous) {
				error = "subissue_ambiguous";
				save({ ...current(), subissue: "unconfirmed", error });
				return { record, stopped: false, writes, error };
			}
			return fail("subissue_failed");
		}
		writes += 1;
		if (!active()) return { record, stopped: true, writes };
		let readback: IssueView;
		try {
			readback = await writer.readIssue(child.id);
		} catch {
			error = "subissue_unverified";
			save({ ...current(), subissue: "unconfirmed", error });
			return { record, stopped: false, writes, error };
		}
		if (!hasLinkMarker(readback.description, args.marker) || (readback.parentId || "") !== view.id) {
			error = "subissue_unverified";
			save({ ...current(), subissue: "unconfirmed", error });
			return { record, stopped: false, writes, error };
		}
		save({ ...lifecycle, scope: "owned", subissue: undefined, umbrellaIdentifier: view.identifier }, {
			issueId: readback.id, identifier: readback.identifier, parentIdentifier: view.identifier ?? record.parentIdentifier,
		});
		lifecycle = current();
		view = readback;
		owned = true;
	}
	if (!owned) return fail("shared_unowned");

	// 1. Managed block. Written only when it differs, then read back and proved to contain the new block while every
	//    character outside it — the human description — is unchanged.
	const section = managedSection(facts);
	let changed = false;
	const desired = mergeManagedDescription(view.description, section);
	if (desired !== view.description) {
		if (!active()) return { record, stopped: true, writes };
		try {
			await writer.setDescription(view.id, desired);
		} catch (failure) {
			return fail(failure instanceof HojaRequestError && failure.ambiguous ? "description_ambiguous" : "description_failed");
		}
		writes += 1;
		if (!active()) return { record, stopped: true, writes };
		let check: IssueView;
		try {
			check = await writer.readIssue(view.id);
		} catch {
			return fail("description_unverified");
		}
		// Exact equality is the proof: `desired` was built from the live description by replacing only the block, so
		// a server that normalizes the human text, drops it or ignores the write fails closed here.
		if (check.description !== desired || !check.description.includes(section)) return fail("description_unverified");
		view = check;
		changed = true;
	}

	// 2. Remote workflow state follows the local task, including reopening a Done issue. The resolved team/project
	//    must be the issue's own before any state id is written, and every transition is read back.
	let stateChanged = false;
	const applyState = async (target: string): Promise<SyncResult | undefined> => {
		if (view.state.trim().toLowerCase() === target.toLowerCase()) return undefined;
		const project = record.project ?? args.project;
		if (!project) return fail("state_project_unknown");
		if (!active()) return { record, stopped: true, writes };
		let resolved: Resolved;
		try {
			resolved = await writer.resolve(project);
		} catch {
			return fail("state_unresolved");
		}
		// A state id belongs to a team. Writing one to an issue in another team or project is never safe.
		if (resolved.teamId !== view.teamId || resolved.projectId !== view.projectId) return fail("state_target_mismatch");
		if (!active()) return { record, stopped: true, writes };
		try {
			await writer.setState(resolved, view.id, target);
		} catch (failure) {
			return fail(failure instanceof HojaRequestError && failure.ambiguous ? "state_ambiguous" : "state_failed");
		}
		writes += 1;
		if (!active()) return { record, stopped: true, writes };
		let after: IssueView;
		try {
			after = await writer.readIssue(view.id);
		} catch {
			return fail("state_unverified");
		}
		if (after.state.trim().toLowerCase() !== target.toLowerCase()) return fail("state_unverified");
		view = after;
		stateChanged = true;
		return undefined;
	};

	// 3. Completion. The marker carries the answer revision: identical repeats dedupe, changed answers post exactly
	//    one new comment. An earlier intent is reconciled by its own marker before any new revision is considered.
	const revision = answerRevision(facts);
	const commentMarker = answerMarker(args.sessionKey, facts.taskId, revision);
	const previousMarker = lifecycle.commentMarker;
	const unresolved = lifecycle.comment === "pending" || lifecycle.comment === "unconfirmed";
	if (unresolved) {
		// The last write may have committed: prove it by its marker. No marker means still ambiguous — fail closed.
		const earlierFound = !!previousMarker && view.comments.some((body) => hasAnswerMarker(body, previousMarker));
		if (!earlierFound) return fail(lifecycle.comment === "pending" ? "comment_pending" : "comment_unconfirmed");
		lifecycle = { ...lifecycle, comment: "posted", commentMarker: previousMarker };
		save({ ...lifecycle, error: undefined });
	}
	const alreadyPosted = view.comments.some((body) => hasAnswerMarker(body, commentMarker));

	if (!acceptedCompletion(facts)) {
		// Completed locally but not accepted (a question has no answer): say so, and never close.
		if (facts.status === "completed") {
			save({ ...lifecycle, error: "completion_unaccepted" });
			return { record, stopped: false, writes, error: "completion_unaccepted" };
		}
		// pending / in_progress: keep the issue's state in step, including reopening a Done issue.
		const stateStop = await applyState(stateFor(facts));
		if (stateStop) return stateStop;
		const reopened = lifecycle.closed === true;
		if (changed || stateChanged || reopened) save({ ...lifecycle, closed: false, error: undefined });
		return { record, stopped: false, writes };
	}

	if (!alreadyPosted) {
		save({ ...lifecycle, comment: "pending", commentMarker });
		if (!active()) return { record, stopped: true, writes };
		try {
			await writer.comment(view.id, completionComment(facts, commentMarker));
		} catch (failure) {
			// Ambiguous means the comment may exist: record it and never write another one for this revision.
			if (failure instanceof HojaRequestError && failure.ambiguous) {
				error = "comment_ambiguous";
				save({ ...current(), comment: "unconfirmed", error });
				return { record, stopped: false, writes, error };
			}
			save({ ...current(), comment: "failed", error: "comment_failed" });
			return { record, stopped: false, writes, error: "comment_failed" };
		}
		writes += 1;
		if (!active()) return { record, stopped: true, writes };
		let check: IssueView;
		try {
			check = await writer.readIssue(view.id);
		} catch {
			error = "comment_unverified";
			save({ ...current(), comment: "unconfirmed", error });
			return { record, stopped: false, writes, error };
		}
		if (!check.comments.some((body) => hasAnswerMarker(body, commentMarker))) {
			error = "comment_unverified";
			save({ ...current(), comment: "unconfirmed", error });
			return { record, stopped: false, writes, error };
		}
		view = check;
		lifecycle = { ...lifecycle, comment: "posted", commentMarker };
		save({ ...lifecycle, error: undefined });
	}

	// Done only after this revision's comment is proved present, the target is the issue's own team/project, and the
	// transition itself reads back.
	const stateStop = await applyState(DONE_STATE);
	if (stateStop) return stateStop;
	const alreadyClosed = lifecycle.closed === true && lifecycle.comment === "posted" && lifecycle.commentMarker === commentMarker;
	if (!changed && !stateChanged && alreadyClosed) return { record, stopped: false, writes };
	save({ ...lifecycle, comment: "posted", commentMarker, closed: true, error: undefined });
	return { record, stopped: false, writes };
}
