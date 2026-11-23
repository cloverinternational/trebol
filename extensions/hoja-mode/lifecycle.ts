/** Lifecycle synchronization for a Hoja issue this session owns.
 *
 * Publication creates or links an issue; this module keeps that issue truthful afterwards: the acceptance questions
 * live in one `## Acceptance criteria` checklist in the description, and an accepted local completion posts exactly
 * one answer comment and then moves the issue to Done.
 *
 * Nothing machine-readable is written into the issue. Descriptions and comments are plain Markdown a person (or a
 * tool listing the issue) reads as-is; every proof this module needs lives somewhere else:
 *   - ownership is the session's own journal: an issue this session created (`origin: "created"`, same issue id) is
 *     owned; a reused or shared issue is not, so it is never moved, commented on or closed. Issues written by earlier
 *     versions still prove ownership by their exact `Link marker:` / `<!-- hoja-task:… -->` line;
 *   - the section this module may rewrite is the last `## Acceptance criteria` heading and the checklist under it
 *     (or the legacy `<!-- hoja-managed -->` block), so text a human adds before or after it is preserved;
 *   - the completion comment is a pure function of the accepted answers, so an exact body match proves it was posted.
 *     Changed answers produce a different body and therefore one new comment; an identical repeat posts nothing.
 *
 * Every write is idempotent by construction, and a write whose outcome is unknown is recorded `unconfirmed` and is
 * never repeated blindly — the next attempt reports it instead of writing again.
 */
import { HojaRequestError, type IssueRef, type IssueView, type Resolved } from "../../.pi/lib/claw/hoja.ts";
import type { HojaTaskRecord } from "./publish.ts";

/** The section heading this module owns. Text outside the section belongs to humans and is preserved verbatim. */
export const CRITERIA_HEADING = "## Acceptance criteria";
/** Legacy block bounds written by earlier versions; still recognised (and replaced) when an old issue syncs. */
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
	/** Digest of the completion comment body this pass wrote (or is about to write); the body itself is the proof. */
	commentDigest?: string;
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

/** The managed section: the acceptance questions as a Markdown checklist, ticked once answered. Questions are tracked
 *  here, never as separate issues. No status line (the issue's workflow state is the status), no ids, no answers (the
 *  completion comment carries those). A task without questions has no section at all. */
export function managedSection(facts: TaskFacts): string {
	if (!facts.questions.length) return "";
	return [CRITERIA_HEADING, "", ...facts.questions.map((question) => `- [${question.answer ? "x" : " "}] ${oneLine(question.text) || question.id}`)].join("\n");
}

const CHECKLIST_ITEM = /^\s*[-*] \[[ xX]\] /;

/** Where the managed section sits in a description: the legacy comment-bounded block when present, else the last
 *  `## Acceptance criteria` heading plus the checklist directly under it. */
export function managedRange(text: string): { start: number; end: number } | undefined {
	const start = text.indexOf(MANAGED_START);
	const end = text.indexOf(MANAGED_END);
	if (start !== -1 && end > start) return { start, end: end + MANAGED_END.length };
	const lines = text.split("\n");
	let heading = -1;
	for (let i = lines.length - 1; i >= 0; i--) if (lines[i].trim() === CRITERIA_HEADING) { heading = i; break; }
	if (heading === -1) return undefined;
	let last = heading;
	for (let i = heading + 1; i < lines.length; i++) {
		if (CHECKLIST_ITEM.test(lines[i])) last = i;
		else if (lines[i].trim() !== "" || last > heading) break;
	}
	const offset = (line: number) => lines.slice(0, line).reduce((sum, value) => sum + value.length + 1, 0);
	return { start: offset(heading), end: offset(last) + lines[last].length };
}

/** The visible machine trail earlier versions wrote around an issue's text. Only this task's own marker lines are
 *  removed; a marker for any other task, or prose that quotes one, is human text and stays. */
export function stripLegacyTrail(text: string, marker: string): string {
	const own = new Set([`Link marker: ${marker}`, hiddenMarker(marker)]);
	const lines = text.split("\n");
	const kept = lines.filter((line) => !own.has(line.trim()) && !/^Tracked by TaskManage task #[A-Za-z0-9_-]+( in session [A-Za-z0-9_-]+)?\.$/.test(line.trim()));
	if (kept.length === lines.length) return text;
	return kept.join("\n").replace(/\n{3,}/g, "\n\n").replace(/^\n+/, "");
}

/** Replaces only the managed section, keeping every human byte before and after it. Without a section one is
 *  appended; an empty section removes the old one. With `marker`, the legacy trail of an owned issue is cleaned too. */
export function mergeManagedDescription(existing: string, section: string, marker?: string): string {
	const text = marker ? stripLegacyTrail(existing, marker) : existing;
	const range = managedRange(text);
	if (range) {
		const before = text.slice(0, range.start);
		const after = text.slice(range.end);
		if (section) return `${before}${section}${after}`;
		const head = before.replace(/\s+$/, "");
		const tail = after.replace(/^\s+/, "");
		return head && tail ? `${head}\n\n${tail}` : head || tail;
	}
	if (!section) return text;
	if (!text) return section;
	// Keep the human text byte-for-byte, including trailing spaces and newlines; only the separator is added.
	const separator = text.endsWith("\n\n") ? "" : text.endsWith("\n") ? "\n" : "\n\n";
	return `${text}${separator}${section}`;
}

/** A line-anchored marker match. Ownership and comment dedupe must never use `includes`: `…:1` is a prefix of
 *  `…:10`, and prose can quote a marker it does not own. Markers are no longer written; this recognises the two forms
 *  earlier versions left in issues (`Label: marker`, and `<!-- marker -->`), always as a whole line. */
export function hasMarkerLine(text: string, label: string, marker: string): boolean {
	if (!marker) return false;
	const wanted = new Set([hiddenMarker(marker), `${label}: ${marker}`]);
	return String(text ?? "").split(/\r?\n/).some((line) => wanted.has(line.trim()));
}

/** The HTML-comment form of a marker, as one earlier version wrote it. */
export const hiddenMarker = (marker: string): string => `<!-- ${marker} -->`;

/** Collapses a value onto one line so it cannot break the list it sits in. */
const oneLine = (value: string): string => value.replace(/\s*\r?\n\s*/g, " ").trim();

/** A legacy ownership marker line for a task. */
export const hasLinkMarker = (description: string, marker: string): boolean => hasMarkerLine(description, "Link marker", marker);
/** A legacy completion-comment marker line. */
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

/** Stable per-task, per-revision key. Kept in the journal (never in the comment) and matched against comments
 *  written by earlier versions, which carried it as a visible line. */
export function answerMarker(sessionKey: string, taskId: string, revision: string): string {
	const session = String(sessionKey ?? "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64) || "session";
	const task = String(taskId ?? "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) || "task";
	return `hoja-answer:${session}:${task}:${revision}`;
}

/** Text outside the managed section, so a write can be proved not to have eaten human description. */
export function outsideManaged(text: string): { prefix: string; suffix: string } {
	const range = managedRange(text);
	if (!range) return { prefix: text, suffix: "" };
	return { prefix: text.slice(0, range.start), suffix: text.slice(range.end) };
}

/** Evidence references as inline code, one span per `;`-separated reference. */
function evidenceText(evidence: string): string {
	const refs = evidence.split(";").map((ref) => oneLine(ref)).filter(Boolean);
	return refs.map((ref) => (ref.includes("`") ? ref : `\`${ref}\``)).join(", ");
}

/** The one evidence-bearing comment a completed task posts to its own issue: a short verdict, then each acceptance
 *  question with its answer and evidence as one numbered item (question, answer and evidence are separate paragraphs,
 *  since a soft line break would run them together). Deterministic: the same answers always produce the same body. */
export function completionComment(facts: TaskFacts): string {
	const count = facts.questions.length;
	const lines = [count
		? `**Done.** ${count === 1 ? "The acceptance criterion is" : `All ${count} acceptance criteria are`} answered below.`
		: "**Done.**"];
	facts.questions.forEach((question, index) => {
		const bullet = `${index + 1}. `;
		const indent = " ".repeat(bullet.length);
		lines.push("", `${bullet}**${oneLine(question.text) || question.id}**`, "");
		const answer = (question.answer ?? "(unanswered)").trim().split(/\r?\n/).map((line) => line.trimEnd());
		for (const line of answer) lines.push(line ? `${indent}${line}` : "");
		if (question.evidence) lines.push("", `${indent}Evidence: ${evidenceText(question.evidence)}`);
	});
	return lines.join("\n");
}

/** Content digest of a comment body, insensitive to line endings and surrounding whitespace a server may normalise. */
export function commentDigest(body: string): string {
	const canonical = String(body ?? "").replace(/\r\n/g, "\n").split("\n").map((line) => line.trimEnd()).join("\n").trim();
	let hash = 0x811c9dc5;
	for (const char of canonical) {
		hash ^= char.codePointAt(0) ?? 0;
		hash = Math.imul(hash, 0x01000193);
	}
	return `${(hash >>> 0).toString(16).padStart(8, "0")}:${canonical.length}`;
}

const stateFor = (facts: TaskFacts): string => (facts.status === "in_progress" ? "In Progress" : "Todo");

/** Fresh sub-issue body for a session working beneath a shared issue: the task's text, then its checklist. */
export function subissueDescription(facts: TaskFacts): string {
	return [facts.description, managedSection(facts)].filter(Boolean).join("\n\n");
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
	// Ownership is the journal's own fact: this session created this very issue. An issue linked by an older version
	// proves it with its exact legacy marker line (never a substring: `…:1` must not match `…:10`), and that proof is
	// written into the record at once, because cleaning the old trail removes the line it came from.
	const createdHere = record.origin === "created" && record.issueId === view.id;
	let owned = (createdHere && lifecycle.scope !== "adopted") || hasLinkMarker(view.description, args.marker);
	if (owned && !createdHere) {
		save({ ...lifecycle, scope: "owned" }, { origin: "created" });
		lifecycle = current();
	}

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
			child = await writer.createIssue(resolved, facts.subject, subissueDescription(facts), stateFor(facts), { parentId: view.id });
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
		if (readback.id !== child.id || (readback.parentId || "") !== view.id) {
			error = "subissue_unverified";
			save({ ...current(), subissue: "unconfirmed", error });
			return { record, stopped: false, writes, error };
		}
		save({ ...lifecycle, scope: "owned", subissue: undefined, umbrellaIdentifier: view.identifier }, {
			origin: "created", issueId: readback.id, identifier: readback.identifier, parentIdentifier: view.identifier ?? record.parentIdentifier,
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
	const desired = mergeManagedDescription(view.description, section, args.marker);
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
	const body = completionComment(facts);
	const digest = commentDigest(body);
	// A comment is ours when its body is exactly the one this revision produces, or (written by an earlier version)
	// it carries the revision's marker line.
	const isOurs = (comment: string, key?: string, bodyDigest?: string) =>
		(!!bodyDigest && commentDigest(comment) === bodyDigest) || (!!key && hasAnswerMarker(comment, key));
	const previousMarker = lifecycle.commentMarker;
	const previousDigest = lifecycle.commentDigest;
	const unresolved = lifecycle.comment === "pending" || lifecycle.comment === "unconfirmed";
	if (unresolved) {
		// The last write may have committed: prove it by its marker. No marker means still ambiguous — fail closed.
		const earlierFound = view.comments.some((comment) => isOurs(comment, previousMarker, previousDigest));
		if (!earlierFound) return fail(lifecycle.comment === "pending" ? "comment_pending" : "comment_unconfirmed");
		lifecycle = { ...lifecycle, comment: "posted", commentMarker: previousMarker, commentDigest: previousDigest };
		save({ ...lifecycle, error: undefined });
	}
	const alreadyPosted = view.comments.some((comment) => isOurs(comment, commentMarker, digest));

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
		save({ ...lifecycle, comment: "pending", commentMarker, commentDigest: digest });
		if (!active()) return { record, stopped: true, writes };
		try {
			await writer.comment(view.id, body);
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
		if (!check.comments.some((comment) => isOurs(comment, commentMarker, digest))) {
			error = "comment_unverified";
			save({ ...current(), comment: "unconfirmed", error });
			return { record, stopped: false, writes, error };
		}
		view = check;
		lifecycle = { ...lifecycle, comment: "posted", commentMarker, commentDigest: digest };
		save({ ...lifecycle, error: undefined });
	}

	// Done only after this revision's comment is proved present, the target is the issue's own team/project, and the
	// transition itself reads back.
	const stateStop = await applyState(DONE_STATE);
	if (stateStop) return stateStop;
	const alreadyClosed = lifecycle.closed === true && lifecycle.comment === "posted" && lifecycle.commentMarker === commentMarker;
	if (!changed && !stateChanged && alreadyClosed) return { record, stopped: false, writes };
	save({ ...lifecycle, comment: "posted", commentMarker, commentDigest: digest, closed: true, error: undefined });
	return { record, stopped: false, writes };
}
