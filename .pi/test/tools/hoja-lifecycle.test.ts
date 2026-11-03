import { describe as group, expect, it } from "vitest";
import { HojaRequestError, type IssueView } from "../../lib/claw/hoja.ts";
import {
	answerMarker, answerRevision, completionComment, hasAnswerMarker, hasLinkMarker, managedSection,
	mergeManagedDescription, outsideManaged, taskFacts, MANAGED_START, MANAGED_END,
} from "../../../extensions/hoja-mode/lifecycle.ts";
import { publicationNote, publishBatch, taskMarker, type HojaRecords } from "../../../extensions/hoja-mode/publish.ts";
import { HOJA_RULE } from "../../../extensions/hoja-mode/extension.ts";

const SESSION = "session-abc";

type Issue = IssueView & { parentId?: string; parentIdentifier?: string };

/** In-memory board with the full write surface lifecycle needs, recording every write. */
function fakeHoja(options: {
	issues?: Issue[];
	ambiguousComment?: "commit" | "lose";
	ambiguousCreate?: "commit" | "lose";
	failComment?: boolean;
	/** Simulates a server that writes only the block and eats the human description. */
	dropHumanText?: boolean;
	/** Simulates resolving to a different project, e.g. the repository fallback. */
	wrongProject?: boolean;
} = {}) {
	const issues = new Map<string, Issue>();
	for (const issue of options.issues ?? []) issues.set(issue.id, issue);
	const calls = {
		create: [] as { title: string; description: string; state: string; parentId?: string }[],
		comments: [] as { issueId: string; body: string }[],
		states: [] as { issueId: string; state: string }[],
		descriptions: [] as { issueId: string; description: string }[],
	};
	let next = 1;
	let ambiguousComment = options.ambiguousComment;
	let ambiguousCreate = options.ambiguousCreate;
	const writer = {
		async resolve(project: string) {
			return {
				teamId: "team", teamKey: "TREBOL", projectId: options.wrongProject ? "another-project" : "proj",
				project, assigneeId: "me", assignee: "Luis",
				states: { todo: "state-todo", "in progress": "state-active", done: "state-done" },
			};
		},
		async createIssue(_r: unknown, title: string, description: string, state = "In Progress", createOptions: { parentId?: string } = {}) {
			calls.create.push({ title, description, state, parentId: createOptions.parentId });
			if (ambiguousCreate === "lose") { ambiguousCreate = undefined; throw new HojaRequestError("timed out", true); }
			const number = next++;
			const issue: Issue = {
				id: `issue-${number}`, identifier: `TREBOL-${number}`, title, description, state,
				teamId: "team", projectId: "proj", assigneeId: "me", comments: [],
				...(createOptions.parentId ? { parentId: createOptions.parentId } : {}),
			};
			issues.set(issue.id, issue);
			if (ambiguousCreate === "commit") { ambiguousCreate = undefined; throw new HojaRequestError("timed out", true); }
			return { id: issue.id, identifier: issue.identifier };
		},
		async readIssue(id: string) {
			const issue = issues.get(id);
			if (!issue) throw new Error("missing");
			return { ...issue, comments: [...issue.comments] };
		},
		async findIssueByMarker(marker: string) {
			const hit = [...issues.values()].find((issue) => issue.description.includes(marker));
			return hit && { id: hit.id, identifier: hit.identifier };
		},
		async findIssueByIdentifier(identifier: string) {
			const hit = [...issues.values()].find((issue) => issue.identifier === identifier);
			return hit && { id: hit.id, identifier: hit.identifier };
		},
		async comment(issueId: string, body: string) {
			calls.comments.push({ issueId, body });
			if (options.failComment) throw new Error("rejected");
			if (ambiguousComment === "lose") { ambiguousComment = undefined; throw new HojaRequestError("timed out", true); }
			const issue = issues.get(issueId);
			if (!issue) throw new Error("missing");
			issue.comments.push(body);
			if (ambiguousComment === "commit") { ambiguousComment = undefined; throw new HojaRequestError("timed out", true); }
		},
		async setState(_r: unknown, issueId: string, state: string) {
			calls.states.push({ issueId, state });
			const issue = issues.get(issueId);
			if (!issue) throw new Error("missing");
			issue.state = state;
		},
		async setDescription(issueId: string, description: string) {
			calls.descriptions.push({ issueId, description });
			const issue = issues.get(issueId);
			if (!issue) throw new Error("missing");
			issue.description = options.dropHumanText ? description.slice(description.indexOf(MANAGED_START)) : description;
		},
	};
	return { writer, issues, calls };
}

type Harness = ReturnType<typeof fakeHoja>;

const task = (id: string, extra: Record<string, unknown> = {}) =>
	({ id, subject: `Task ${id}`, status: "pending", active: false, parent_id: "", ...extra });
const question = (id: string, text = `Question ${id}`) => ({ id, text });
const answered = (id: string, answer: string, evidence: string) => ({ question: id, answer, evidence });
const batch = (...results: unknown[]) => ({ status: "succeeded", results });
const created = (key: string, value: Record<string, unknown>) => ({ key, op: "create", status: "succeeded", data: { task: value } });
const updated = (key: string, value: Record<string, unknown>) => ({ key, op: "update", status: "succeeded", data: { task: value } });
const params = (...operations: unknown[]) => ({ operations });
const run = (hoja: Harness, operations: unknown, results: unknown, records: HojaRecords = {}) =>
	publishBatch(operations, results, { enabled: true, sessionKey: SESSION, project: "Trebol", writer: hoja.writer as any, records });

const linkedRecord = (issueId: string, identifier: string, lifecycle?: Record<string, unknown>): HojaRecords => ({
	"1": { taskId: "1", state: "linked", at: "t", issueId, identifier, project: "Trebol", ...(lifecycle ? { lifecycle: lifecycle as any } : {}) },
});

const completedFacts = (answers: unknown[] = [answered("q1", "Yes", "tool:Bash")]) =>
	task("1", { status: "completed", questions: [question("q1", "Done?")], answers });

/** Publish one root task with questions, then hand its records to the next step. */
async function withRoot(hoja: Harness, questions = [question("q1")]) {
	const outcome = await run(hoja, params({ key: "a", op: "create", subject: "Tern git totals", description: "Human context.", questions }),
		batch(created("a", task("1", { questions }))));
	return outcome.applied;
}

group("managed description block", () => {
	it("replaces only the managed block and keeps human text on both sides", () => {
		const before = `Human intro.\n\n${managedSection({ taskId: "1", subject: "s", status: "pending", questions: [] })}\n\nHuman footer.`;
		const next = managedSection({ taskId: "1", subject: "s", status: "completed", questions: [{ id: "q1", text: "Done?", answer: "Yes" }] });
		const merged = mergeManagedDescription(before, next);
		expect(merged.startsWith("Human intro.")).toBe(true);
		expect(merged.endsWith("Human footer.")).toBe(true);
		expect(merged).toContain("Status: completed");
		expect(merged).toContain("- [x] `q1` Done?");
		expect(merged).not.toContain("Status: pending");
	});

	it("appends a block to an issue written before the block existed", () => {
		const merged = mergeManagedDescription("old description", managedSection({ taskId: "1", subject: "s", status: "pending", questions: [] }));
		expect(merged).toBe(`old description\n\n${MANAGED_START}\nStatus: pending\n${MANAGED_END}`);
	});

	it("keeps trailing whitespace when it appends a block", () => {
		const existing = "Human text.  \n";
		const merged = mergeManagedDescription(existing, managedSection({ taskId: "1", subject: "s", status: "pending", questions: [] }));
		expect(merged.startsWith(existing)).toBe(true);
		expect(outsideManaged(merged).prefix.startsWith(existing)).toBe(true);
		expect(merged).toBe(`${existing}\n${MANAGED_START}\nStatus: pending\n${MANAGED_END}`);
	});

	it("matches the exact Link marker line, never a prefix or quoted prose", () => {
		const one = taskMarker(SESSION, "1");
		expect(hasLinkMarker(`Link marker: ${taskMarker(SESSION, "10")}`, one)).toBe(false);
		expect(hasLinkMarker(`Link marker: ${one}`, one)).toBe(true);
		expect(hasLinkMarker(`See ${one} in prose.`, one)).toBe(false);
		expect(hasLinkMarker(`prefix${one}`, one)).toBe(false);
		expect(hasAnswerMarker(`Answer marker: ${answerMarker(SESSION, "10", "abcd")}`, answerMarker(SESSION, "1", "abcd"))).toBe(false);
		expect(hasAnswerMarker(`Answer marker: ${answerMarker(SESSION, "1", "abcd")}`, answerMarker(SESSION, "1", "abcd"))).toBe(true);
	});

	it("treats task.answers as authoritative over inline question fields", () => {
		const facts = taskFacts({
			id: "1", subject: "s", status: "completed",
			questions: [{ id: "q1", text: "Why?", answer: "stale" }],
			answers: [answered("q1", "fresh", "file.ts#L1")],
		});
		expect(facts.questions[0]).toMatchObject({ answer: "fresh", evidence: "file.ts#L1" });
	});
});

group("created issues carry acceptance questions", () => {
	it("writes the questions into one managed block and files no issue per question", async () => {
		const hoja = fakeHoja();
		await withRoot(hoja, [question("q1"), question("q2")]);

		expect(hoja.calls.create).toHaveLength(1);
		const description = hoja.calls.create[0].description;
		expect(description).toContain("Human context.");
		expect(description).toContain("`q1`");
		expect(description).toContain("`q2`");
		expect(description).toContain("Status: pending");
		expect(description).toContain("not as separate issues");
		expect(hoja.issues.size).toBe(1);
	});
});

group("progress and changed questions sync without hoja metadata", () => {
	it("rewrites the managed block and moves the remote state on a plain update, with no comment", async () => {
		const hoja = fakeHoja();
		const linked = await withRoot(hoja);
		const progress = await run(hoja, params({ key: "b", op: "update" }),
			batch(updated("b", task("1", { status: "in_progress", questions: [question("q1")] }))), linked);

		expect(progress.records.some((r) => r.state === "linked")).toBe(true);
		expect(hoja.calls.descriptions).toHaveLength(1);
		expect(hoja.calls.descriptions[0].description).toContain("Status: in_progress");
		expect(hoja.calls.comments).toHaveLength(0);
		expect(hoja.calls.states).toEqual([{ issueId: "issue-1", state: "In Progress" }]);
		expect(hoja.calls.create).toHaveLength(1);
		expect(hoja.issues.get("issue-1")?.state).toBe("In Progress");
	});

	it("follows changed questions, dropping wording that no longer exists", async () => {
		const hoja = fakeHoja();
		const first = await withRoot(hoja);
		await run(hoja, params({ key: "b", op: "update" }),
			batch(updated("b", task("1", { status: "in_progress", questions: [question("q1")] }))), first);
		await run(hoja, params({ key: "c", op: "update" }),
			batch(updated("c", task("1", { status: "in_progress", questions: [question("q1", "New wording"), question("q2")] }))), first);

		const description = hoja.issues.get("issue-1")?.description ?? "";
		expect(description).toContain("New wording");
		expect(description).not.toContain("Question q1");
		expect(description).toContain("`q2`");
		expect(hoja.calls.descriptions).toHaveLength(2);
	});

	it("reports nothing when a plain update leaves the issue unchanged", async () => {
		const hoja = fakeHoja();
		const linked = await withRoot(hoja);
		const outcome = await run(hoja, params({ key: "b", op: "update" }),
			batch(updated("b", task("1", { questions: [question("q1")] }))), linked);

		expect(hoja.calls.descriptions).toHaveLength(0);
		expect(outcome.records).toEqual([]);
		expect(publicationNote(outcome)).toBeUndefined();
	});
});

group("accepted completion closes an owned issue exactly once", () => {
	const completedTask = (id = "1") => task(id, {
		status: "completed", subject: "Tern git totals",
		questions: [question("q1", "What changed?")],
		answers: [answered("q1", "Summary totals added", ".pi/lib/tern/startup-card.ts#L304")],
	});

	it("posts one evidence-bearing comment, then Done, and reads both back", async () => {
		const hoja = fakeHoja();
		const linked = await withRoot(hoja, [question("q1", "What changed?")]);
		const outcome = await run(hoja, params({ key: "d", op: "update" }), batch(updated("d", completedTask())), linked);
		const marker = answerMarker(SESSION, "1", answerRevision(taskFacts(completedTask())));

		expect(hoja.calls.comments).toHaveLength(1);
		const comment = hoja.calls.comments[0].body;
		expect(comment).toContain(`Answer marker: ${marker}`);
		expect(hasAnswerMarker(comment, marker)).toBe(true);
		expect(comment).toContain("Summary totals added");
		expect(comment).toContain(".pi/lib/tern/startup-card.ts#L304");
		expect(hoja.calls.states).toEqual([{ issueId: "issue-1", state: "Done" }]);
		expect(hoja.issues.get("issue-1")?.state).toBe("Done");
		expect(hoja.issues.get("issue-1")?.description).toContain("- [x] `q1`");
		expect(outcome.applied["1"].lifecycle).toMatchObject({ comment: "posted", closed: true });
	});

	it("never posts twice on a repeated completion or a replayed record", async () => {
		const hoja = fakeHoja();
		const linked = await withRoot(hoja, [question("q1", "What changed?")]);
		const first = await run(hoja, params({ key: "d", op: "update" }), batch(updated("d", completedTask())), linked);

		await run(hoja, params({ key: "e", op: "update" }), batch(updated("e", completedTask())), first.applied);
		expect(hoja.calls.comments).toHaveLength(1);
		expect(hoja.calls.states).toHaveLength(1);

		// A resumed chat whose journal lost the lifecycle outcome still finds the marker in the issue's comments.
		const replayed: HojaRecords = { "1": { ...first.applied["1"], lifecycle: { scope: "owned" } } };
		await run(hoja, params({ key: "f", op: "update" }), batch(updated("f", completedTask())), replayed);
		expect(hoja.calls.comments).toHaveLength(1);
		expect(hoja.issues.get("issue-1")?.comments).toHaveLength(1);
	});

	it("does not close a completed task whose acceptance question has no answer", async () => {
		const hoja = fakeHoja();
		const linked = await withRoot(hoja, [question("q1")]);
		const outcome = await run(hoja, params({ key: "d", op: "update" }),
			batch(updated("d", task("1", { status: "completed", questions: [question("q1")] }))), linked);

		expect(hoja.calls.comments).toHaveLength(0);
		expect(hoja.calls.states).toHaveLength(0);
		expect(outcome.applied["1"].lifecycle?.error).toBe("completion_unaccepted");
		expect(publicationNote(outcome)).toContain("NOT closed");
	});
});

group("shared umbrella issues are protected", () => {
	it("writes to an adopted issue that carries this session's exact marker", async () => {
		const marker = taskMarker(SESSION, "1");
		const own: Issue = {
			id: "issue-1", identifier: "TREBOL-577", title: "Own work", description: `Old body.\n\nLink marker: ${marker}`, state: "Todo",
			teamId: "team", projectId: "proj", assigneeId: "me", comments: [],
		};
		const hoja = fakeHoja({ issues: [own] });
		const outcome = await run(hoja,
			params({ key: "a", op: "create", subject: "Own work", metadata: { hojaIssue: "TREBOL-577" }, questions: [question("q1", "Done?")] }),
			batch(created("a", task("1", {
				status: "completed", questions: [question("q1", "Done?")],
				answers: [answered("q1", "Yes", "tool:Bash")],
			}))));

		expect(hoja.calls.create).toHaveLength(0);
		expect(hoja.issues.get("issue-1")?.state).toBe("Done");
		expect(hoja.issues.get("issue-1")?.description).toContain("Old body.");
		expect(hoja.calls.comments).toHaveLength(1);
		expect(outcome.applied["1"]).toMatchObject({ identifier: "TREBOL-577" });
	});

	it("writes the session's work to a sub-issue and leaves the shared issue untouched", async () => {
		const shared: Issue = {
			id: "issue-9", identifier: "TREBOL-9", title: "Umbrella", description: "someone else's work", state: "Todo",
			teamId: "team", projectId: "proj", assigneeId: "me", comments: ["keep me"],
		};
		const hoja = fakeHoja({ issues: [shared] });
		const outcome = await run(hoja,
			params({ key: "a", op: "create", subject: "Tern totals", metadata: { hojaIssue: "TREBOL-9" }, questions: [question("q1", "Done?")] }),
			batch(created("a", task("1", {
				status: "completed", questions: [question("q1", "Done?")],
				answers: [answered("q1", "Yes", "tool:Bash")],
			}))));

		expect(hoja.issues.get("issue-9")).toMatchObject({ description: "someone else's work", state: "Todo", comments: ["keep me"] });
		const child = hoja.issues.get("issue-1");
		expect(child?.parentId).toBe("issue-9");
		expect(child?.state).toBe("Done");
		expect(child?.comments[0]).toContain("Yes");
		expect(hoja.calls.states).toEqual([{ issueId: "issue-1", state: "Done" }]);
		expect(outcome.applied["1"]).toMatchObject({ identifier: "TREBOL-1", parentIdentifier: "TREBOL-9" });
		expect(outcome.applied["1"].lifecycle).toMatchObject({ scope: "owned", umbrellaIdentifier: "TREBOL-9", closed: true });
	});

	it("never repeats an unconfirmed sub-issue creation", async () => {
		const shared: Issue = {
			id: "issue-9", identifier: "TREBOL-9", title: "Umbrella", description: "someone else's", state: "Todo",
			teamId: "team", projectId: "proj", assigneeId: "me", comments: [],
		};
		const hoja = fakeHoja({ issues: [shared], ambiguousCreate: "commit" });
		const operations = params({ key: "a", op: "create", subject: "Session work", metadata: { hojaIssue: "TREBOL-9" }, questions: [question("q1")] });
		const results = batch(created("a", task("1", { questions: [question("q1")] })));
		const first = await run(hoja, operations, results);
		expect(first.applied["1"].lifecycle).toMatchObject({ subissue: "unconfirmed" });
		expect(hoja.issues.size).toBe(2);

		await run(hoja, params({ key: "b", op: "update" }), batch(updated("b", task("1", { questions: [question("q1")], status: "in_progress" }))), first.applied);
		expect(hoja.issues.size).toBe(2);
		expect(hoja.issues.get("issue-9")).toMatchObject({ description: "someone else's", state: "Todo" });
	});
});

group("parent and child hierarchy", () => {
	it("creates a promoted child as a sub-issue carrying its own questions", async () => {
		const hoja = fakeHoja();
		const root = await run(hoja, params({ key: "r", op: "create", subject: "Parent", questions: [question("pq")] }),
			batch(created("r", task("1", { questions: [question("pq")] }))));
		const child = await run(hoja, params({ key: "c", op: "create", subject: "Child", metadata: { hoja: "publish" }, questions: [question("cq")] }),
			batch(created("c", task("2", { parent_id: "1", questions: [question("cq")] }))), root.applied);

		const parentIssue = hoja.issues.get("issue-1");
		const childIssue = hoja.issues.get("issue-2");
		expect(childIssue?.parentId).toBe(parentIssue?.id);
		expect(childIssue?.description).toContain("`cq`");
		expect(parentIssue?.description).toContain("`pq`");
		expect(parentIssue?.description).not.toContain("`cq`");
		expect(child.applied["2"]).toMatchObject({ parentIdentifier: "TREBOL-1" });
	});
});

group("backfill of an already-linked issue", () => {
	it("syncs a legacy link on a metadata-bearing retry instead of creating another issue", async () => {
		const marker = taskMarker(SESSION, "1");
		const legacy: Issue = {
			id: "issue-1", identifier: "TREBOL-577", title: "Tern Git totals",
			description: `Tracked by TaskManage task #1.\n\nLink marker: ${marker}`, state: "Todo",
			teamId: "team", projectId: "proj", assigneeId: "me", comments: [],
		};
		const hoja = fakeHoja({ issues: [legacy] });
		const records: HojaRecords = { "1": { taskId: "1", state: "linked", at: "t", issueId: "issue-1", identifier: "TREBOL-577", project: "Trebol" } };
		const outcome = await run(hoja,
			params({ key: "a", op: "update", metadata: { hojaProject: "Trebol" } }),
			batch(updated("a", task("1", {
				status: "completed", subject: "Tern Git totals", questions: [question("q1", "What changed?")],
				answers: [answered("q1", "Summary totals", ".pi/lib/tern/startup-card.ts#L304")],
			}))), records);

		expect(hoja.calls.create).toHaveLength(0);
		const issue = hoja.issues.get("issue-1");
		expect(issue?.state).toBe("Done");
		expect(issue?.description).toContain("Status: completed");
		expect(issue?.description).toContain("`q1`");
		expect(issue?.description).toContain("Link marker");
		expect(hoja.calls.comments).toHaveLength(1);
		expect(outcome.applied["1"].lifecycle).toMatchObject({ closed: true });
	});
});

group("failed and ambiguous writes", () => {
	const completedTask = () => task("1", {
		status: "completed",
		questions: [question("q1", "Done?")],
		answers: [answered("q1", "Yes", "tool:Bash")],
	});

	it("records an ambiguous comment and closes only once a readback proves it landed", async () => {
		const hoja = fakeHoja({ ambiguousComment: "commit" });
		const linked = await withRoot(hoja, [question("q1", "Done?")]);
		const first = await run(hoja, params({ key: "d", op: "update" }), batch(updated("d", completedTask())), linked);

		expect(first.applied["1"].lifecycle).toMatchObject({ comment: "unconfirmed" });
		expect(hoja.issues.get("issue-1")?.comments).toHaveLength(1);
		expect(hoja.issues.get("issue-1")?.state).toBe("Todo");
		expect(publicationNote(first)).toContain("never repeated automatically");

		// The comment may exist; the next pass reads it back, posts nothing, and only then may close.
		const second = await run(hoja, params({ key: "e", op: "update" }), batch(updated("e", completedTask())), first.applied);
		expect(hoja.calls.comments).toHaveLength(1);
		expect(hoja.issues.get("issue-1")?.comments).toHaveLength(1);
		expect(second.applied["1"].lifecycle).toMatchObject({ closed: true });
		expect(second.applied["1"].lifecycle?.error).toBeUndefined();
		expect(hoja.issues.get("issue-1")?.state).toBe("Done");
	});

	it("treats a lost comment response as unconfirmed and does not repost", async () => {
		const hoja = fakeHoja({ ambiguousComment: "lose" });
		const linked = await withRoot(hoja, [question("q1", "Done?")]);
		const first = await run(hoja, params({ key: "d", op: "update" }), batch(updated("d", completedTask())), linked);

		expect(first.applied["1"].lifecycle).toMatchObject({ comment: "unconfirmed" });
		expect(hoja.issues.get("issue-1")?.comments).toHaveLength(0);
		await run(hoja, params({ key: "e", op: "update" }), batch(updated("e", completedTask())), first.applied);
		expect(hoja.calls.comments).toHaveLength(1);
		expect(hoja.issues.get("issue-1")?.comments).toHaveLength(0);
		expect(hoja.issues.get("issue-1")?.state).toBe("Todo");
	});

	it("records a rejected comment as failed and leaves the issue open", async () => {
		const hoja = fakeHoja({ failComment: true });
		const linked = await withRoot(hoja, [question("q1", "Done?")]);
		const outcome = await run(hoja, params({ key: "d", op: "update" }), batch(updated("d", completedTask())), linked);

		expect(outcome.applied["1"].lifecycle).toMatchObject({ comment: "failed" });
		expect(hoja.calls.states).toHaveLength(0);
		expect(hoja.issues.get("issue-1")?.state).toBe("Todo");
		expect(publicationNote(outcome)).toContain("Hoja rejected the completion comment");
	});

	it("reports a read failure once and writes nothing else", async () => {
		const hoja = fakeHoja();
		const linked = await withRoot(hoja, [question("q1")]);
		const writer = { ...hoja.writer, async readIssue() { throw new Error("unavailable"); } };
		const outcome = await publishBatch(params({ key: "b", op: "update" }), batch(updated("b", task("1", { status: "in_progress" }))),
			{ enabled: true, sessionKey: SESSION, project: "Trebol", writer: writer as any, records: linked });

		expect(outcome.applied["1"].lifecycle?.error).toBe("sync_read_failed");
		expect(hoja.calls.descriptions).toHaveLength(0);
		expect(hoja.calls.comments).toHaveLength(0);
	});
});

group("ownership proof", () => {
	const foreign = (description: string): Issue => ({
		id: "issue-1", identifier: "TREBOL-1", title: "Other", description, state: "Todo",
		teamId: "team", projectId: "proj", assigneeId: "me", comments: [],
	});

	it("refuses an issue whose Link marker belongs to another task (prefix collision)", async () => {
		const hoja = fakeHoja({ issues: [foreign(`Link marker: ${taskMarker(SESSION, "10")}`)] });
		const outcome = await run(hoja, params({ key: "b", op: "update" }),
			batch(updated("b", task("1", { status: "in_progress" }))), linkedRecord("issue-1", "TREBOL-1"));

		expect(outcome.applied["1"].lifecycle?.error).toBe("shared_unowned");
		expect(hoja.calls.descriptions).toHaveLength(0);
		expect(hoja.calls.states).toHaveLength(0);
	});

	it("refuses an issue that merely quotes this task's marker in prose", async () => {
		const hoja = fakeHoja({ issues: [foreign(`See ${taskMarker(SESSION, "1")} for context.`)] });
		const outcome = await run(hoja, params({ key: "b", op: "update" }),
			batch(updated("b", task("1", { status: "in_progress" }))), linkedRecord("issue-1", "TREBOL-1"));

		expect(outcome.applied["1"].lifecycle?.error).toBe("shared_unowned");
		expect(hoja.calls.descriptions).toHaveLength(0);
	});
});

group("crash ambiguity", () => {
	it("treats a journaled sub-issue pending intent as ambiguous and creates nothing", async () => {
		const shared: Issue = {
			id: "issue-9", identifier: "TREBOL-9", title: "Umbrella", description: "someone else's", state: "Todo",
			teamId: "team", projectId: "proj", assigneeId: "me", comments: [],
		};
		const hoja = fakeHoja({ issues: [shared] });
		const outcome = await run(hoja, params({ key: "b", op: "update" }),
			batch(updated("b", task("1", { status: "in_progress" }))),
			linkedRecord("issue-9", "TREBOL-9", { scope: "adopted", subissue: "pending" }));

		expect(hoja.calls.create).toHaveLength(0);
		expect(hoja.issues.size).toBe(1);
		expect(outcome.applied["1"].lifecycle?.error).toBe("subissue_pending");
	});

	it("treats a journaled comment pending intent with no marker as ambiguous", async () => {
		const hoja = fakeHoja();
		const linked = await withRoot(hoja, [question("q1", "Done?")]);
		const facts = taskFacts(completedFacts());
		const marker = answerMarker(SESSION, "1", answerRevision(facts));
		const outcome = await run(hoja, params({ key: "d", op: "update" }), batch(updated("d", completedFacts())),
			{ "1": { ...linked["1"], lifecycle: { scope: "owned", comment: "pending", commentMarker: marker } } });

		expect(hoja.calls.comments).toHaveLength(0);
		expect(outcome.applied["1"].lifecycle?.error).toBe("comment_pending");
		expect(hoja.issues.get("issue-1")?.state).toBe("Todo");
	});

	it("reconciles a journaled comment found by marker and closes without posting again", async () => {
		const hoja = fakeHoja();
		const linked = await withRoot(hoja, [question("q1", "Done?")]);
		const facts = taskFacts(completedFacts());
		const marker = answerMarker(SESSION, "1", answerRevision(facts));
		hoja.issues.get("issue-1")?.comments.push(completionComment(facts, marker));
		const outcome = await run(hoja, params({ key: "d", op: "update" }), batch(updated("d", completedFacts())),
			{ "1": { ...linked["1"], lifecycle: { scope: "owned", comment: "pending", commentMarker: marker } } });

		expect(hoja.calls.comments).toHaveLength(0);
		expect(hoja.issues.get("issue-1")?.state).toBe("Done");
		expect(outcome.applied["1"].lifecycle).toMatchObject({ closed: true });
	});
});

group("workflow state sync", () => {
	it("reopens a Done issue when the task returns to in_progress", async () => {
		const hoja = fakeHoja();
		const linked = await withRoot(hoja, [question("q1", "Done?")]);
		const closed = await run(hoja, params({ key: "d", op: "update" }), batch(updated("d", completedFacts())), linked);
		expect(hoja.issues.get("issue-1")?.state).toBe("Done");

		const reopened = await run(hoja, params({ key: "e", op: "update" }),
			batch(updated("e", task("1", { status: "in_progress", questions: [question("q1", "Done?")] }))), closed.applied);
		expect(hoja.issues.get("issue-1")?.state).toBe("In Progress");
		expect(reopened.applied["1"].lifecycle).toMatchObject({ closed: false });
	});

	it("returns an In Progress issue to Todo for a pending task", async () => {
		const hoja = fakeHoja();
		const linked = await withRoot(hoja);
		const active = await run(hoja, params({ key: "b", op: "update" }),
			batch(updated("b", task("1", { status: "in_progress", questions: [question("q1")] }))), linked);
		expect(hoja.issues.get("issue-1")?.state).toBe("In Progress");

		const back = await run(hoja, params({ key: "c", op: "update" }),
			batch(updated("c", task("1", { status: "pending", questions: [question("q1")] }))), active.applied);
		expect(hoja.issues.get("issue-1")?.state).toBe("Todo");
		expect(back.applied["1"].lifecycle?.error).toBeUndefined();
	});

	it("refuses a state write when the resolved project is not the issue's own", async () => {
		const hoja = fakeHoja();
		const linked = await withRoot(hoja);
		// The issue lives in `proj`; a resolution that lands elsewhere must never supply its state id.
		const writer = {
			...hoja.writer,
			async resolve(project: string) {
				return { ...(await hoja.writer.resolve(project)), projectId: "another-project" };
			},
		};
		const outcome = await publishBatch(params({ key: "b", op: "update" }),
			batch(updated("b", task("1", { status: "in_progress", questions: [question("q1")] }))),
			{ enabled: true, sessionKey: SESSION, project: "Trebol", writer: writer as any, records: linked });

		expect(outcome.applied["1"].lifecycle?.error).toBe("state_target_mismatch");
		expect(hoja.calls.states).toHaveLength(0);
		expect(hoja.issues.get("issue-1")?.state).toBe("Todo");
	});

	it("refuses a state write when the resolved team is not the issue's team", async () => {
		const hoja = fakeHoja();
		const linked = await withRoot(hoja);
		const writer = {
			...hoja.writer,
			async resolve(project: string) {
				return { ...(await hoja.writer.resolve(project)), teamId: "other-team" };
			},
		};
		const outcome = await publishBatch(params({ key: "b", op: "update" }),
			batch(updated("b", task("1", { status: "in_progress", questions: [question("q1")] }))),
			{ enabled: true, sessionKey: SESSION, project: "Trebol", writer: writer as any, records: linked });

		expect(outcome.applied["1"].lifecycle?.error).toBe("state_target_mismatch");
		expect(hoja.calls.states).toHaveLength(0);
		expect(hoja.issues.get("issue-1")?.state).toBe("Todo");
	});
});

group("description read-back", () => {
	it("stops when the managed write lost the human description", async () => {
		const hoja = fakeHoja({ dropHumanText: true });
		const linked = await withRoot(hoja);
		const outcome = await run(hoja, params({ key: "b", op: "update" }),
			batch(updated("b", task("1", { status: "in_progress", questions: [question("q1")] }))), linked);

		expect(outcome.applied["1"].lifecycle?.error).toBe("description_unverified");
		expect(hoja.calls.comments).toHaveLength(0);
		expect(hoja.calls.states).toHaveLength(0);
	});
});

group("answer revisions", () => {
	const completedWith = (answer: string, evidence: string) =>
		task("1", { status: "completed", questions: [question("q1", "What?")], answers: [answered("q1", answer, evidence)] });

	it("posts a new comment only when the accepted answers change", async () => {
		const hoja = fakeHoja();
		const linked = await withRoot(hoja, [question("q1", "What?")]);
		const first = await run(hoja, params({ key: "a", op: "update" }), batch(updated("a", completedWith("First", "a.ts#L1"))), linked);
		expect(hoja.calls.comments).toHaveLength(1);

		// Reopen and complete with identical answers: nothing new is posted.
		const reopened = await run(hoja, params({ key: "b", op: "update" }),
			batch(updated("b", task("1", { status: "in_progress", questions: [question("q1", "What?")] }))), first.applied);
		expect(hoja.issues.get("issue-1")?.state).toBe("In Progress");
		const again = await run(hoja, params({ key: "c", op: "update" }), batch(updated("c", completedWith("First", "a.ts#L1"))), reopened.applied);
		expect(hoja.calls.comments).toHaveLength(1);
		expect(hoja.issues.get("issue-1")?.state).toBe("Done");

		// Reopen and complete with changed answers: exactly one new comment for the new revision.
		const reopenedAgain = await run(hoja, params({ key: "d", op: "update" }),
			batch(updated("d", task("1", { status: "in_progress", questions: [question("q1", "What?")] }))), again.applied);
		await run(hoja, params({ key: "e", op: "update" }), batch(updated("e", completedWith("Second", "a.ts#L2"))), reopenedAgain.applied);
		expect(hoja.calls.comments).toHaveLength(2);
		expect(hoja.calls.comments[1].body).toContain("Second");
		expect(hoja.calls.comments[1].body).not.toBe(hoja.calls.comments[0].body);
	});

	it("reconciles an unresolved earlier intent before posting a new revision", async () => {
		const hoja = fakeHoja();
		const linked = await withRoot(hoja, [question("q1", "What?")]);
		const records: HojaRecords = {
			"1": { ...linked["1"], lifecycle: { scope: "owned", comment: "unconfirmed", commentMarker: answerMarker(SESSION, "1", "deadbeef") } },
		};

		const outcome = await run(hoja, params({ key: "a", op: "update" }), batch(updated("a", completedWith("Second", "a.ts#L2"))), records);
		expect(hoja.calls.comments).toHaveLength(0);
		expect(outcome.applied["1"].lifecycle?.error).toBe("comment_unconfirmed");
		expect(hoja.issues.get("issue-1")?.state).toBe("Todo");
	});
});

group("guidance matches behavior", () => {
	it("describes owned lifecycle writes and shared-issue protection", () => {
		expect(HOJA_RULE).toContain("moves the owned issue to Done");
		expect(HOJA_RULE).toContain("never moved, closed or commented on");
		expect(HOJA_RULE).toContain("never as separate issues");
		expect(HOJA_RULE).toContain("ask the user to confirm");
	});

	it("builds a completion comment with every answer and its evidence", () => {
		const body = completionComment({
			taskId: "1", subject: "s", status: "completed",
			questions: [{ id: "q1", text: "Why?", answer: "because", evidence: "file.ts#L5" }],
		}, "hoja-answer:s:1");
		expect(body).toContain("because");
		expect(body).toContain("file.ts#L5");
	});
});
