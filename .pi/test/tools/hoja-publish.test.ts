import { describe as group, expect, it } from "vitest";
import { HojaClient, HojaProjectError, HojaRequestError, type IssueView } from "../../lib/claw/hoja.ts";
import {
	HOJA_TASK_ENTRY, publicationNote, publishBatch, replayHojaRecords, taskMarker,
	type HojaRecords, type HojaTaskRecord, type HojaWriter,
} from "../../../extensions/hoja-mode/publish.ts";
import { HOJA_RULE, registerHojaMode } from "../../../extensions/hoja-mode/extension.ts";

const SESSION = "session-abc";

type Created = IssueView & { parentId?: string };

/** In-memory Hoja: the same five calls the real client exposes, recording every write. */
function fakeHoja(options: { issues?: Created[]; ambiguousCreate?: "commit" | "lose"; projects?: string[] } = {}) {
	const issues = new Map<string, Created>();
	for (const issue of options.issues ?? []) issues.set(issue.id, issue);
	const calls = { resolve: [] as unknown[], create: [] as { title: string; description: string; state: string; parentId?: string }[], lookup: [] as string[], markers: [] as string[], stateWrites: 0 };
	let next = 1;
	let ambiguous = options.ambiguousCreate;
	const writer: HojaWriter = {
		async resolve(project: string) {
			calls.resolve.push(project);
			// A writer whose board only has the named projects, so a guessed name fails exactly like the real client.
			if (options.projects && !options.projects.some(name => name.toLowerCase() === project.trim().toLowerCase()))
				throw new HojaProjectError(`Hoja project "${project}" not found.`);
			return {
				teamId: "team", teamKey: "TREBOL", projectId: "proj", project, assigneeId: "me", assignee: "Luis",
				states: { todo: "state-todo", "in progress": "state-active" },
			};
		},
		async createIssue(_r, title, description, state, createOptions = {}) {
			calls.create.push({ title, description, state, parentId: createOptions.parentId });
			if (ambiguous === "lose") { ambiguous = undefined; throw new HojaRequestError("timed out", true); }
			const id = `issue-${next}`;
			const issue: Created = {
				id, identifier: `TREBOL-${next++}`, title, description, state,
				teamId: "team", projectId: "proj", assigneeId: "me", comments: [], ...(createOptions.parentId ? { parentId: createOptions.parentId } : {}),
			};
			issues.set(id, issue);
			if (ambiguous === "commit") { ambiguous = undefined; throw new HojaRequestError("timed out", true); }
			return { id, identifier: issue.identifier };
		},
		async readIssue(id: string) {
			const issue = issues.get(id);
			if (!issue) throw new Error("missing");
			return { ...issue };
		},
		async findIssueByMarker(marker: string) {
			calls.markers.push(marker);
			const hit = [...issues.values()].find(i => i.description.includes(marker));
			return hit && { id: hit.id, identifier: hit.identifier };
		},
		async findIssueByIdentifier(identifier: string) {
			calls.lookup.push(identifier);
			const hit = [...issues.values()].find(i => i.identifier === identifier);
			return hit && { id: hit.id, identifier: hit.identifier };
		},
	};
	return { writer, issues, calls };
}

type Harness = ReturnType<typeof fakeHoja>;

const task = (id: string, extra: Record<string, unknown> = {}) =>
	({ id, subject: `Task ${id}`, status: "pending", active: false, parent_id: "", ...extra });
const batch = (...results: unknown[]) => ({ status: "succeeded", results });
const created = (key: string, value: Record<string, unknown>) => ({ key, op: "create", status: "succeeded", data: { task: value } });
const updated = (key: string, value: Record<string, unknown>) => ({ key, op: "update", status: "succeeded", data: { task: value } });
const params = (...operations: unknown[]) => ({ operations });
const run = (hoja: Harness, operations: unknown, results: unknown, records: HojaRecords = {}, extra: Record<string, unknown> = {}) =>
	publishBatch(operations, results, { enabled: true, sessionKey: SESSION, project: "Trebol", writer: hoja.writer, records, ...extra });
const publish = (hoja: Harness, operations: unknown, results: unknown, extra: Record<string, unknown> = {}) =>
	run(hoja, operations, results, {}, extra);
const entry = (data: HojaTaskRecord) => ({ type: "custom", customType: HOJA_TASK_ENTRY, data });
const statesOf = (records: readonly HojaTaskRecord[]) => records.map(r => [r.state, r.reason]);

group("coarse publication is on by default", () => {
	it("journals the pre-write intent before the create, then the link, and never moves the issue", async () => {
		const hoja = fakeHoja();
		const journaled: HojaTaskRecord[] = [];
		const operations = params({ key: "a", op: "create", subject: "Ship board", description: "Do the work.", questions: [{ id: "q", text: "done?" }] });
		const outcome = await publish(hoja, operations, batch(created("a", task("1"))), { journal: (r: HojaTaskRecord) => journaled.push(r) });

		expect(statesOf(journaled)).toEqual([["reconciling", "write_in_flight"], ["linked", undefined]]);
		expect(journaled[0]).toMatchObject({ marker: taskMarker(SESSION, "1"), project: "Trebol", projectId: "proj" });
		expect(journaled[0].expectedParentIssueId).toBeUndefined();
		expect(outcome.records).toEqual(journaled);
		expect(hoja.calls.create).toHaveLength(1);
		expect(hoja.calls.create[0]).toMatchObject({ title: "Task 1", state: "Todo", parentId: undefined });
		expect(hoja.calls.create[0].description).toContain("Do the work.");
		expect(hoja.calls.create[0].description).toContain(taskMarker(SESSION, "1"));
		expect(outcome.applied["1"]).toMatchObject({ state: "linked", issueId: "issue-1", identifier: "TREBOL-1", project: "Trebol" });
		expect(hoja.calls.stateWrites).toBe(0);
	});

	it("keeps child steps local unless they are promoted", async () => {
		const hoja = fakeHoja();
		const root = await run(hoja, params({ key: "r", op: "create", subject: "Root", questions: [] }),
			batch(created("r", task("1"))));
		expect(root.applied["1"].identifier).toBe("TREBOL-1");

		// A child task without metadata is a local step: no call, no record.
		const plain = await run(hoja, params({ key: "c", op: "create", subject: "Step", questions: [] }),
			batch(created("c", task("2", { parent_id: "1" }))), root.applied);
		expect(plain.records).toEqual([]);
		expect(hoja.calls.create).toHaveLength(1);

		// The same shape marked local is equally silent.
		const local = await run(hoja, params({ key: "l", op: "create", subject: "Root 2", metadata: { hoja: "local" }, questions: [] }),
			batch(created("l", task("3"))), plain.applied);
		expect(local.records).toEqual([]);
		expect(hoja.calls.create).toHaveLength(1);
	});

	it("creates a promoted child as a sub-issue of its linked parent and reads the hierarchy back", async () => {
		const hoja = fakeHoja();
		const root = await run(hoja, params({ key: "r", op: "create", subject: "Root", questions: [] }),
			batch(created("r", task("1"))));
		const child = await run(hoja, params({ key: "c", op: "create", subject: "Child", metadata: { hoja: "publish" }, questions: [] }),
			batch(created("c", task("2", { parent_id: "1" }))), root.applied);

		expect(hoja.calls.create[1]).toMatchObject({ title: "Task 2", parentId: "issue-1" });
		expect(child.applied["2"]).toMatchObject({ state: "linked", identifier: "TREBOL-2", parentIdentifier: "TREBOL-1" });
	});

	it("defers a promoted child instead of filing it as a root when its parent has no issue", async () => {
		const hoja = fakeHoja();
		const childOps = params({ key: "c", op: "create", subject: "Child", metadata: { hoja: "publish" }, questions: [] });
		const deferred = await run(hoja, childOps, batch(created("c", task("2", { parent_id: "9" }))));

		expect(hoja.calls.create).toHaveLength(0);
		expect(deferred.applied["2"]).toMatchObject({ state: "skipped", reason: "parent_unpublished" });
		expect(publicationNote(deferred)).toContain("parent_unpublished".replace("parent_unpublished", "NOT filed as a root issue"));

		// Once the parent is published, the same step becomes a sub-issue.
		const root = await run(hoja, params({ key: "r", op: "create", subject: "Root", questions: [] }),
			batch(created("r", task("9"))), deferred.applied);
		const published = await run(hoja, childOps, batch(created("c", task("2", { parent_id: "9" }))), root.applied);
		expect(hoja.calls.create.at(-1)).toMatchObject({ parentId: "issue-1" });
		expect(published.applied["2"]).toMatchObject({ state: "linked", parentIdentifier: "TREBOL-1" });
	});
});

group("checking the project and existing issues", () => {
	it("reuses a named issue without writing to it, even when it is closed", async () => {
		const shared: Created = {
			id: "issue-9", identifier: "TREBOL-9", title: "Shared", description: "someone else's", state: "Done",
			teamId: "team", projectId: "proj", assigneeId: "me", comments: ["keep me"], parentId: undefined,
		};
		const hoja = fakeHoja({ issues: [shared] });
		const outcome = await run(hoja, params({ key: "a", op: "create", subject: "Related", metadata: { hojaIssue: "trebol-9" }, questions: [] }),
			batch(created("a", task("1"))));

		expect(hoja.calls.lookup).toEqual(["TREBOL-9"]);
		expect(hoja.calls.create).toHaveLength(0);
		expect(outcome.applied["1"]).toMatchObject({ state: "linked", issueId: "issue-9", identifier: "TREBOL-9" });
		expect(hoja.issues.get("issue-9")).toEqual(shared);
	});

	it("fails a named issue that does not exist instead of creating a different one", async () => {
		const hoja = fakeHoja();
		const outcome = await run(hoja, params({ key: "a", op: "create", subject: "Related", metadata: { hojaIssue: "TREBOL-404" }, questions: [] }),
			batch(created("a", task("1"))));
		expect(hoja.calls.create).toHaveLength(0);
		expect(outcome.applied["1"]).toMatchObject({ state: "failed", reason: "issue_not_found", identifier: "TREBOL-404" });
	});

	it("refuses an identifier the lookup did not actually return", async () => {
		const hoja = fakeHoja();
		const writer: HojaWriter = {
			...hoja.writer,
			async findIssueByIdentifier() { return { id: "issue-x", identifier: "TREBOL-999" }; },
		};
		const outcome = await publish(hoja, params({ key: "a", op: "create", subject: "A", metadata: { hojaIssue: "TREBOL-9" }, questions: [] }),
			batch(created("a", task("1"))), { writer });
		expect(outcome.applied["1"]).toMatchObject({ state: "failed", reason: "identifier_mismatch" });
		expect(hoja.calls.create).toHaveLength(0);
	});

	it("skips without a project and retries once corrected metadata names one", async () => {
		const hoja = fakeHoja();
		const noProject = await publishBatch(params({ key: "a", op: "create", subject: "A", questions: [] }), batch(created("a", task("1"))),
			{ enabled: true, sessionKey: SESSION, writer: hoja.writer, records: {} });
		expect(noProject.applied["1"]).toMatchObject({ state: "skipped", reason: "no_project" });
		expect(hoja.calls.create).toHaveLength(0);

		const retried = await run(hoja, params({ key: "a", op: "update", metadata: { hojaProject: "Trebol" }, questions: [] }),
			batch(updated("a", task("1"))), noProject.applied);
		expect(hoja.calls.create).toHaveLength(1);
		expect(retried.applied["1"]).toMatchObject({ state: "linked", project: "Trebol" });
	});

	it("rejects unknown metadata values and keeps a local task local even when it names an issue", async () => {
		const hoja = fakeHoja();
		const invalid = await run(hoja, params({ key: "b", op: "create", subject: "B", metadata: { hoja: "sometimes" }, questions: [] }),
			batch(created("b", task("2"))));
		expect(invalid.applied["2"]).toMatchObject({ state: "skipped", reason: "invalid_hoja_metadata" });

		const local = await run(hoja, params({ key: "c", op: "create", subject: "C", metadata: { hoja: "local", hojaIssue: "TREBOL-9" }, questions: [] }),
			batch(created("c", task("3"))), invalid.applied);
		expect(local.records).toEqual([]);
		expect(hoja.calls.lookup).toEqual([]);
		expect(hoja.calls.create).toHaveLength(0);
	});

	it("never publishes from a read result", async () => {
		const hoja = fakeHoja();
		const outcome = await run(hoja, params({ key: "g", op: "get", taskId: "1" }, { key: "l", op: "list" }),
			{ status: "succeeded", results: [
				{ key: "g", op: "get", status: "succeeded", data: { task: task("1") } },
				{ key: "l", op: "list", status: "succeeded", data: { tasks: [task("1")] } },
			] });
		expect(hoja.calls.create).toHaveLength(0);
		expect(hoja.calls.resolve).toHaveLength(0);
		expect(outcome.records).toEqual([]);
	});
});

group("disabled behavior", () => {
	it("performs no Hoja call and records nothing when the mode is off", async () => {
		const hoja = fakeHoja();
		const outcome = await publishBatch(params({ key: "a", op: "create", subject: "A", questions: [] }), batch(created("a", task("1"))),
			{ enabled: false, sessionKey: SESSION, project: "Trebol", writer: hoja.writer, records: {} });
		expect(outcome.records).toEqual([]);
		expect(outcome.applied).toEqual({});
		expect(hoja.calls).toMatchObject({ resolve: [], create: [], lookup: [], markers: [] });
	});
});

group("retry and resume safety", () => {
	it("adopts a committed write whose response was lost instead of creating a second issue", async () => {
		const hoja = fakeHoja({ ambiguousCreate: "commit" });
		const operations = params({ key: "a", op: "create", subject: "A", questions: [] });
		const first = await run(hoja, operations, batch(created("a", task("1"))));
		expect(first.applied["1"]).toMatchObject({ state: "reconciling", reason: "ambiguous_write", marker: taskMarker(SESSION, "1") });

		const second = await run(hoja, operations, batch(updated("a", task("1", { status: "in_progress" }))), first.applied);
		expect(hoja.calls.create).toHaveLength(1);
		expect(hoja.calls.markers).toEqual([taskMarker(SESSION, "1")]);
		expect(second.applied["1"]).toMatchObject({ state: "linked", identifier: "TREBOL-1" });
		expect(hoja.issues.size).toBe(1);
	});

	it("never creates a second issue when an ambiguous write leaves no marker to find", async () => {
		const hoja = fakeHoja({ ambiguousCreate: "lose" });
		const operations = params({ key: "a", op: "create", subject: "A", questions: [] });
		const first = await run(hoja, operations, batch(created("a", task("1"))));
		expect(first.applied["1"].state).toBe("reconciling");

		const second = await run(hoja, operations, batch(updated("a", task("1", { status: "in_progress" }))), first.applied);
		expect(hoja.calls.create).toHaveLength(1);
		expect(hoja.issues.size).toBe(0);
		expect(second.applied["1"].state).toBe("reconciling");
		expect(second.blocked.map(r => r.taskId)).toEqual(["1"]);
		const note = publicationNote(second)!;
		expect(note).toContain("unconfirmed");
		expect(note).toContain("hojaIssue");

		// The only way out is explicit: link the issue the agent found, never an automatic second create.
		const linked: Created = {
			id: "issue-7", identifier: "TREBOL-7", title: "Found", description: "manual", state: "Todo",
			teamId: "team", projectId: "proj", assigneeId: "me", comments: [],
		};
		const resolved = fakeHoja({ issues: [linked] });
		const third = await publishBatch(params({ key: "a", op: "update", metadata: { hojaIssue: "TREBOL-7" } }),
			batch(updated("a", task("1"))), { enabled: true, sessionKey: SESSION, writer: resolved.writer, records: second.applied });
		expect(third.applied["1"]).toMatchObject({ state: "linked", identifier: "TREBOL-7" });
		expect(resolved.calls.create).toHaveLength(0);
	});

	it("does not adopt a marker hit that fails the project or parent read-back", async () => {
		const marker = taskMarker(SESSION, "1");
		const foreign: Created = {
			id: "issue-9", identifier: "TREBOL-9", title: "Other", description: `someone else's\n${marker}`, state: "Todo",
			teamId: "team", projectId: "another-project", assigneeId: "me", comments: [],
		};
		const hoja = fakeHoja({ issues: [foreign] });
		const records: HojaRecords = { "1": { taskId: "1", state: "reconciling", at: "t", marker, project: "Trebol", projectId: "proj", reason: "ambiguous_write" } };
		const outcome = await run(hoja, params({ key: "a", op: "update", questions: [] }), batch(updated("a", task("1"))), records);
		expect(outcome.applied["1"].state).toBe("reconciling");
		expect(outcome.blocked).toHaveLength(1);

		// A root intent never adopts an issue that was created under a parent.
		const parented: Created = { ...foreign, id: "issue-10", identifier: "TREBOL-10", projectId: "proj", parentId: "issue-1" };
		const withParent = fakeHoja({ issues: [parented] });
		const mismatch = await run(withParent, params({ key: "a", op: "update", questions: [] }), batch(updated("a", task("1"))), records);
		expect(mismatch.applied["1"].state).toBe("reconciling");
		expect(withParent.calls.create).toHaveLength(0);
	});

	it("survives a crash between the create and its outcome, then adopts the issue by marker", async () => {
		const hoja = fakeHoja();
		const journaled: HojaTaskRecord[] = [];
		let alive = true;
		const writer: HojaWriter = {
			...hoja.writer,
			async createIssue(...args: Parameters<HojaWriter["createIssue"]>) {
				const result = await hoja.writer.createIssue(...args);
				// The chat goes away the instant the server commits, before any outcome can be journaled.
				alive = false;
				return result;
			},
		};
		const operations = params({ key: "a", op: "create", subject: "A", questions: [] });
		const first = await run(hoja, operations, batch(created("a", task("1"))), {}, {
			writer, isActive: () => alive, journal: (r: HojaTaskRecord) => journaled.push(r),
		});
		expect(first.stopped).toBe(true);
		expect(hoja.issues.size).toBe(1);
		expect(statesOf(journaled)).toEqual([["reconciling", "write_in_flight"]]);

		const replayed = replayHojaRecords(journaled.map(entry));
		const second = await run(hoja, operations, batch(updated("a", task("1", { status: "in_progress" }))), replayed);
		expect(hoja.calls.create).toHaveLength(1);
		expect(hoja.issues.size).toBe(1);
		expect(second.applied["1"]).toMatchObject({ state: "linked", identifier: "TREBOL-1" });
	});

	it("reports a definitive rejection once, not the pre-write intent as well", async () => {
		const hoja = fakeHoja();
		const writer: HojaWriter = {
			...hoja.writer,
			async createIssue() { throw new HojaRequestError("rejected"); },
		};
		const outcome = await publish(hoja, params({ key: "a", op: "create", subject: "A", questions: [] }),
			batch(created("a", task("1"))), { writer });
		expect(statesOf(outcome.records)).toEqual([["reconciling", "write_in_flight"], ["failed", "create_failed"]]);
		const note = publicationNote(outcome)!;
		expect(note).toContain("Hoja rejected the create");
		expect(note).not.toContain("unconfirmed");
	});

	it("replays the association from the journal so a resumed chat never republishes", async () => {
		const hoja = fakeHoja();
		const operations = params({ key: "a", op: "create", subject: "A", questions: [] });
		const first = await run(hoja, operations, batch(created("a", task("1"))));
		const records = replayHojaRecords(first.records.map(entry));
		expect(records["1"]).toMatchObject({ state: "linked", identifier: "TREBOL-1" });
		const resumed = await run(hoja, operations, batch(updated("a", task("1", { status: "in_progress" }))), records);
		expect(hoja.calls.create).toHaveLength(1);
		expect(resumed.records).toEqual([]);
	});
});

group("extension wiring", () => {
	function instance(options: { fake?: Harness; client?: any; entries?: any[]; project?: string; config?: () => { project?: string; assignee?: string } } = {}) {
		const entries = options.entries ?? [];
		const handlers: Record<string, Function[]> = {};
		let command: any;
		const notices: string[] = [];
		const hoja = options.fake ?? fakeHoja();
		const client = options.client ?? hoja.writer;
		const pi = {
			registerTool: () => {},
			registerCommand: (_name: string, definition: any) => { command = definition; },
			on: (name: string, handler: Function) => { (handlers[name] ??= []).push(handler); },
			appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
		};
		// The default is an empty repository config: the checkout running these tests has its own .pi/config/hoja.json.
		registerHojaMode(pi, client as any, { project: options.project ?? "Trebol", config: options.config ?? (() => ({})) });
		const ctx = {
			sessionManager: { getSessionId: () => SESSION, getBranch: () => entries },
			ui: { notify: (message: string) => notices.push(message) },
		};
		const start = async () => { for (const fn of handlers.session_start ?? []) await fn({}, ctx); };
		const shutdown = async () => { for (const fn of handlers.session_shutdown ?? []) await fn({}, ctx); };
		const toolResultNamed = (toolName: string, input: unknown, details: unknown) => {
			let pending: Promise<any> | undefined;
			for (const fn of handlers.tool_result ?? []) pending = fn({ toolName, input, details, content: [{ type: "text", text: "{}" }] }, ctx);
			return pending;
		};
		const toolResult = (input: unknown, details: unknown) => toolResultNamed("TaskManage", input, details);
		const rule = () => handlers.before_agent_start?.[0]?.({ systemPrompt: "" }, ctx)?.systemPrompt ?? "";
		const commandRun = async (args: string) => command.handler(args, ctx);
		const journals = () => entries.filter(e => e.customType === HOJA_TASK_ENTRY).map(e => e.data);
		const textOf = (patch: any) => (patch?.content ?? []).map((block: any) => block.text).join("\n");
		const call = (toolName: string, input: unknown) => handlers.tool_call?.[0]?.({ toolName, input }, ctx);
		return { entries, notices, hoja, start, shutdown, toolResult, toolResultNamed, rule, commandRun, journals, textOf, call };
	}

	it("publishes on a TaskManage result, journals intent then link, and appends the outcome for the model", async () => {
		const inst = instance();
		await inst.start();
		const patch = await inst.toolResult(params({ key: "a", op: "create", subject: "Root", questions: [] }), { batch: batch(created("a", task("1"))) });
		expect(inst.hoja.calls.create).toHaveLength(1);
		expect(inst.journals().map((r: any) => [r.state, r.reason])).toEqual([["reconciling", "write_in_flight"], ["linked", undefined]]);
		expect(inst.notices.at(-1)).toContain("TREBOL-1");
		expect(inst.textOf(patch)).toContain("TREBOL-1");
		expect(inst.rule()).toContain(HOJA_RULE);
		// The pre-start check stays on the existing read tools; publication adds no schema scope.
		expect(HOJA_RULE).toContain("check whether an issue already exists (hoja_list)");
		expect(HOJA_RULE).toContain("read its outcome in the TaskManage result");
	});

	it("tells the model why nothing was published when no project is configured", async () => {
		const inst = instance({ project: "" });
		await inst.start();
		const patch = await inst.toolResult(params({ key: "a", op: "create", subject: "Root", questions: [] }), { batch: batch(created("a", task("1"))) });
		expect(inst.hoja.calls.create).toHaveLength(0);
		const text = inst.textOf(patch);
		expect(text).toContain("no Hoja project");
		expect(text).toContain("hojaProject");
		expect(text).toContain("hoja_project");
		expect(text).toContain("ask_user_question");
		expect(inst.notices.at(-1)).toContain("no_project");
		// Missing filing is recovery, not a gate: no tool is blocked, including read-only inspection and completion.
		expect(inst.call("apply_patch", {})).toBeUndefined();
		expect(inst.call("Bash", { command: "cat report.txt | grep launchd" })).toBeUndefined();
		expect(inst.call("hoja_project", { action: "list" })).toBeUndefined();
		expect(inst.call("ask_user_question", {})).toBeUndefined();
		expect(inst.call("TaskManage", { operations: [{ op: "update", taskId: "1", status: "completed" }] })).toBeUndefined();
		await inst.commandRun("off");
		expect(inst.call("apply_patch", {})).toBeUndefined();
	});

	it("publishes an ordinary task that names no project, because the repository declares one", async () => {
		// The reproduced failure: a delegated agent starts a root task and never mentions a project.
		const hoja = fakeHoja({ projects: ["Hoja"] });
		const inst = instance({ fake: hoja, project: "", config: () => ({ project: "Hoja" }) });
		await inst.start();
		const patch = await inst.toolResult(params({ key: "a", op: "create", subject: "Tern Git UI", questions: [] }), { batch: batch(created("a", task("1"))) });

		expect(hoja.calls.resolve).toEqual(["Hoja"]);
		expect(hoja.calls.create).toHaveLength(1);
		expect(inst.journals().map((r: any) => [r.state, r.reason])).toEqual([["reconciling", "write_in_flight"], ["linked", undefined]]);
		expect(inst.journals().at(-1)).toMatchObject({ project: "Hoja" });
		expect(inst.textOf(patch)).toContain("TREBOL-1");
		expect(inst.call("apply_patch", {})).toBeUndefined();
	});

	it("serializes batches so a concurrent call cannot publish the same task twice", async () => {
		const inst = instance();
		await inst.start();
		const first = inst.toolResult(params({ key: "a", op: "create", subject: "Root", questions: [] }), { batch: batch(created("a", task("1"))) });
		const second = inst.toolResult(params({ key: "b", op: "update", metadata: { hoja: "publish" } }), { batch: batch(updated("b", task("1", { status: "in_progress" }))) });
		await Promise.all([first, second]);
		expect(inst.hoja.calls.create).toHaveLength(1);
	});

	it("stops an in-flight batch when the mode is turned off", async () => {
		const hoja = fakeHoja();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const client = {
			...hoja.writer,
			async resolve(...args: Parameters<HojaWriter["resolve"]>) {
				await gate;
				return hoja.writer.resolve(...args);
			},
		};
		const inst = instance({ fake: hoja, client });
		await inst.start();
		const pending = inst.toolResult(params({ key: "a", op: "create", subject: "Root", questions: [] }), { batch: batch(created("a", task("1"))) });
		await new Promise(resolve => setTimeout(resolve, 0));
		await inst.commandRun("off");
		release();
		expect(await pending).toBeUndefined();
		expect(hoja.calls.create).toHaveLength(0);
		expect(inst.journals()).toEqual([]);
	});

	it("stops an in-flight batch when the chat shuts down", async () => {
		const hoja = fakeHoja();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const client = {
			...hoja.writer,
			async resolve(...args: Parameters<HojaWriter["resolve"]>) {
				await gate;
				return hoja.writer.resolve(...args);
			},
		};
		const inst = instance({ fake: hoja, client });
		await inst.start();
		const pending = inst.toolResult(params({ key: "a", op: "create", subject: "Root", questions: [] }), { batch: batch(created("a", task("1"))) });
		await new Promise(resolve => setTimeout(resolve, 0));
		await inst.shutdown();
		release();
		expect(await pending).toBeUndefined();
		expect(hoja.calls.create).toHaveLength(0);
		expect(inst.journals()).toEqual([]);
	});

	it("stops publishing and drops the guidance after /hoja off, and resumes after /hoja on", async () => {
		const inst = instance();
		await inst.start();
		await inst.commandRun("off");
		expect(inst.rule()).toBe("");
		await inst.toolResult(params({ key: "a", op: "create", subject: "Root", questions: [] }), { batch: batch(created("a", task("1"))) });
		expect(inst.hoja.calls.create).toHaveLength(0);
		expect(inst.journals()).toEqual([]);

		await inst.commandRun("on");
		await inst.toolResult(params({ key: "b", op: "create", subject: "Root 2", questions: [] }), { batch: batch(created("b", task("2"))) });
		expect(inst.hoja.calls.create).toHaveLength(1);
	});

	it("ignores every other tool", async () => {
		const inst = instance();
		await inst.start();
		await inst.toolResultNamed("Bash", params({ key: "a", op: "create", subject: "Root", questions: [] }), { batch: batch(created("a", task("1"))) });
		await inst.toolResult(params({ key: "a", op: "create", subject: "Root", questions: [] }), { batch: batch(created("a", task("1"))) });
		expect(inst.hoja.calls.create).toHaveLength(1);
	});
});

group("HojaClient write surface", () => {
	const respond = (payload: unknown) => {
		const calls: { query: string; variables: any }[] = [];
		const client = new HojaClient({
			url: "https://hoja.test/graphql", token: "t",
			fetch: async (_url, init) => {
				calls.push(JSON.parse(init.body));
				return { status: 200, text: async () => JSON.stringify({ data: payload }) };
			},
		});
		return { client, calls };
	};

	it("sends parentId only when a caller supplies an existing issue id", async () => {
		const withParent = respond({ issueCreate: { success: true, issue: { id: "i2", identifier: "TREBOL-2" } } });
		await withParent.client.createIssue({ teamId: "t", projectId: "p", assigneeId: "a", states: { "in progress": "s1" }, teamKey: "TREBOL", project: "Trebol", assignee: "Luis" } as any,
			"Child", "body", "In Progress", { parentId: "i1" });
		expect(withParent.calls[0].variables.input).toMatchObject({ parentId: "i1", stateId: "s1" });
		expect(withParent.calls[0].query).toContain("issueCreate");

		const noParent = respond({ issueCreate: { success: true, issue: { id: "i1", identifier: "TREBOL-1" } } });
		await noParent.client.createIssue({ teamId: "t", projectId: "p", assigneeId: "a", states: { "in progress": "s1" }, teamKey: "TREBOL", project: "Trebol", assignee: "Luis" } as any,
			"Root", "body");
		expect(noParent.calls[0].variables.input).not.toHaveProperty("parentId");
	});

	it("looks a reused issue up by identifier with variables and reads the hierarchy back", async () => {
		const lookup = respond({ issues: { nodes: [{ id: "i9", identifier: "TREBOL-9" }] } });
		expect(await lookup.client.findIssueByIdentifier("TREBOL-9")).toEqual({ id: "i9", identifier: "TREBOL-9" });
		expect(lookup.calls[0].variables).toEqual({ first: 2, filter: { identifier: { eq: "TREBOL-9" } } });
		expect(lookup.calls[0].query).not.toContain("TREBOL-9");

		const read = respond({ issue: { id: "i2", identifier: "TREBOL-2", title: "Child", description: "d", state: { name: "Todo" },
			team: { id: "t" }, project: { id: "p" }, assignee: { id: "a" }, parent: { id: "i1", identifier: "TREBOL-1" }, comments: { nodes: [] } } });
		expect(await read.client.readIssue("i2")).toMatchObject({ parentId: "i1", parentIdentifier: "TREBOL-1" });
		expect(read.calls[0].query).toContain("parent { id identifier }");
	});
});

group("project resolution", () => {
	const create = (metadata?: Record<string, unknown>) =>
		params({ key: "a", op: "create", subject: "Ship board", ...(metadata ? { metadata } : {}) });

	it("uses the repository project when the task names none", async () => {
		const hoja = fakeHoja({ projects: ["Hoja"] });
		const outcome = await publishBatch(create(), batch(created("a", task("1"))), {
			enabled: true, sessionKey: SESSION, fallbackProject: "Hoja", writer: hoja.writer, records: {},
		});

		expect(hoja.calls.resolve).toEqual(["Hoja"]);
		expect(outcome.applied["1"]).toMatchObject({ state: "linked", project: "Hoja" });
		expect(outcome.applied["1"].substitutedFrom).toBeUndefined();
		expect(publicationNote(outcome)).toContain("TREBOL-1");
	});

	it("falls back to the repository project when the agent guesses a workspace name", async () => {
		// Reproduced live: a delegated agent named the checkout directory "trebol", which is not a project.
		const hoja = fakeHoja({ projects: ["Hoja"] });
		const outcome = await publishBatch(create({ hoja: "publish", hojaProject: "trebol" }), batch(created("a", task("1"))), {
			enabled: true, sessionKey: SESSION, fallbackProject: "Hoja", writer: hoja.writer, records: {},
		});

		expect(hoja.calls.resolve).toEqual(["trebol", "Hoja"]);
		expect(outcome.applied["1"]).toMatchObject({ state: "linked", project: "Hoja", substitutedFrom: "trebol" });
		expect(publicationNote(outcome)).toContain('"trebol" does not exist');
	});

	it("honours an explicit project that exists without touching the repository default", async () => {
		const hoja = fakeHoja({ projects: ["Hoja", "Clover Infrastructure"] });
		const outcome = await publishBatch(create({ hojaProject: "Clover Infrastructure" }), batch(created("a", task("1"))), {
			enabled: true, sessionKey: SESSION, fallbackProject: "Hoja", writer: hoja.writer, records: {},
		});

		expect(hoja.calls.resolve).toEqual(["Clover Infrastructure"]);
		expect(outcome.applied["1"]).toMatchObject({ state: "linked", project: "Clover Infrastructure" });
		expect(outcome.applied["1"].substitutedFrom).toBeUndefined();
	});

	it("does not reach for another project when the failure is not about the project", async () => {
		const hoja = fakeHoja();
		const rejecting: HojaWriter = {
			...hoja.writer,
			async resolve() { throw new Error('assignee "me" is not a member of team TREBOL'); },
		};
		const outcome = await publishBatch(create({ hojaProject: "Hoja" }), batch(created("a", task("1"))), {
			enabled: true, sessionKey: SESSION, fallbackProject: "Hoja", writer: rejecting, records: {},
		});

		expect(statesOf(outcome.records)).toEqual([["failed", "project_unresolved"]]);
		expect(hoja.calls.create).toHaveLength(0);
	});

	it("still skips honestly, and tells the model how to configure a project, when nothing declares one", async () => {
		const hoja = fakeHoja();
		const outcome = await publishBatch(create(), batch(created("a", task("1"))), {
			enabled: true, sessionKey: SESSION, writer: hoja.writer, records: {},
		});

		expect(statesOf(outcome.records)).toEqual([["skipped", "no_project"]]);
		expect(hoja.calls.resolve).toEqual([]);
		const note = publicationNote(outcome) ?? "";
		expect(note).toContain("no Hoja project is configured");
		expect(note).toContain(".pi/config/hoja.json");
	});
});
