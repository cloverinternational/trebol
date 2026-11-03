import { describe as group, expect, it } from "vitest";
import { HOJA_RECOVERY_ENTRY, HOJA_RULE, MAX_RECOVERY_ATTEMPTS, registerHojaMode } from "../../../extensions/hoja-mode/extension.ts";
import { PROJECT_CATALOG } from "../../../extensions/hoja-mode/projects.ts";

type Issue = {
	id: string; identifier: string; title: string; description: string; state: string;
	teamId: string; projectId: string; assigneeId: string; comments: string[];
};

/** A writer + catalogue double: the same surface the real client exposes, with the catalogue call counted. */
function harness(options: {
	projects?: { name: string; key?: string; description?: string }[];
	catalogError?: string;
	resolveFailures?: number;
	project?: string;
	config?: () => { project?: string; assignee?: string };
	entries?: any[];
	persist?: (name: string) => unknown;
	confirm?: boolean;
	resolveGate?: () => Promise<void>;
} = {}) {
	const entries = options.entries ?? [];
	const handlers: Record<string, Function[]> = {};
	const tools = new Map<string, any>();
	const notices: string[] = [];
	let command: any;
	const calls = {
		discovery: 0, resolves: 0, create: [] as { title: string; description: string; state: string }[],
		comments: [] as string[], states: [] as string[],
	};
	const issues = new Map<string, Issue>();
	let next = 1;
	let resolveFailures = options.resolveFailures ?? 0;
	const catalog = {
		projects: {
			nodes: (options.projects ?? []).map((project) => ({
				id: `project-${project.name}`, name: project.name,
				...(project.description ? { description: project.description } : {}),
				teams: { nodes: [{ id: "team", key: project.key ?? "TREBOL" }] },
			})),
		},
		teams: { nodes: [{ id: "team", key: "TREBOL", name: "Equipo Trebol" }] },
	};
	const client = {
		invalidateCatalog() {},
		async gql<T>(query: string): Promise<T> {
			if (query === PROJECT_CATALOG || query.includes("projects(")) {
				calls.discovery += 1;
				if (options.catalogError) throw new Error(options.catalogError);
				return catalog as T;
			}
			throw new Error(`unexpected query: ${query.slice(0, 40)}`);
		},
		async resolve(project: string) {
			calls.resolves += 1;
			if (options.resolveGate) await options.resolveGate();
			if (resolveFailures > 0) { resolveFailures -= 1; throw new Error("catalogue temporarily unavailable"); }
			return {
				teamId: "team", teamKey: "TREBOL", projectId: "proj", project, assigneeId: "me", assignee: "Luis",
				states: { todo: "state-todo", "in progress": "state-active", done: "state-done" },
			};
		},
		async createIssue(_r: unknown, title: string, description: string, state = "In Progress") {
			calls.create.push({ title, description, state });
			const number = next++;
			const issue: Issue = {
				id: `issue-${number}`, identifier: `TREBOL-${number}`, title, description, state,
				teamId: "team", projectId: "proj", assigneeId: "me", comments: [],
			};
			issues.set(issue.id, issue);
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
			calls.comments.push(body);
			issues.get(issueId)?.comments.push(body);
		},
		async setState(_r: unknown, issueId: string, state: string) {
			calls.states.push(state);
			const issue = issues.get(issueId);
			if (issue) issue.state = state;
		},
		async setDescription(issueId: string, description: string) {
			const issue = issues.get(issueId);
			if (issue) issue.description = description;
		},
	};
	const pi = {
		registerTool: (tool: any) => tools.set(tool.name, tool),
		registerCommand: (_name: string, definition: any) => { command = definition; },
		on: (name: string, handler: Function) => { (handlers[name] ??= []).push(handler); },
		appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
	};
	registerHojaMode(pi, client as any, {
		project: options.project ?? "",
		config: options.config ?? (() => ({})),
		persist: options.persist,
	});
	const ctx = {
		sessionManager: { getSessionId: () => "session-live", getBranch: () => entries },
		ui: {
			notify: (message: string) => notices.push(message),
			...(options.confirm !== undefined ? { confirm: async () => options.confirm } : {}),
		},
		hasUI: options.confirm !== undefined,
	};
	const start = async () => { for (const handler of handlers.session_start ?? []) await handler({}, ctx); };
	const toolResultNamed = (toolName: string, input: unknown, details: unknown) => {
		let pending: Promise<any> | undefined;
		for (const handler of handlers.tool_result ?? []) pending = handler({ toolName, input, details, content: [{ type: "text", text: "{}" }] }, ctx);
		return pending;
	};
	const toolResult = (input: unknown, details: unknown) => toolResultNamed("TaskManage", input, details);
	const commandRun = async (args: string) => {
		await command.handler(args, ctx);
	};
	const textOf = (patch: any) => (patch?.content ?? []).map((block: any) => block.text).join("\n");
	const call = (toolName: string, input: unknown) => handlers.tool_call?.[0]?.({ toolName, input }, ctx);
	return { entries, notices, tools, calls, issues, start, toolResult, textOf, call, commandRun, handlers, client, ctx };
}

const task = (id: string, extra: Record<string, unknown> = {}) =>
	({ id, subject: `Task ${id}`, status: "pending", active: false, parent_id: "", ...extra });
const question = (id: string, text = `Question ${id}`) => ({ id, text });
const answered = (id: string, answer: string, evidence: string) => ({ question: id, answer, evidence });
const params = (...operations: unknown[]) => ({ operations });
const batch = (...results: unknown[]) => ({ status: "succeeded", results });
const created = (key: string, value: Record<string, unknown>) => ({ key, op: "create", status: "succeeded", data: { task: value } });
const updated = (key: string, value: Record<string, unknown>) => ({ key, op: "update", status: "succeeded", data: { task: value } });

group("no_project recovers instead of blocking", () => {
	it("lists real candidates, blocks nothing, and never offers /hoja off", async () => {
		const inst = harness({ projects: [{ name: "Hoja", description: "Replacement for Linear and agent workspace" }, { name: "Clover Track React" }] });
		await inst.start();
		const patch = await inst.toolResult(params({ key: "a", op: "create", subject: "Bank extraction", questions: [] }),
			batch(created("a", task("24"))));
		const text = inst.textOf(patch);

		expect(inst.calls.create).toHaveLength(0);
		expect(inst.calls.discovery).toBe(1);
		expect(text).toContain("Hoja recovery");
		expect(text).toContain("Candidates: Hoja (TREBOL) — Replacement for Linear and agent workspace · Clover Track React (TREBOL).");
		expect(text).toContain("nothing is blocked");
		expect(text).not.toContain("/hoja off");

		// The reproduced failure: a read-only report inspection was blocked. No tool_call gate exists any more.
		expect(inst.handlers.tool_call).toBeUndefined();
		expect(inst.call("Bash", { command: "cat today-report.txt | grep launchd" })).toBeUndefined();
		expect(inst.call("apply_patch", {})).toBeUndefined();
		expect(inst.call("TaskManage", { operations: [{ op: "update", taskId: "24", status: "completed" }] })).toBeUndefined();
	});

	it("reports an unfiled completion honestly instead of claiming remote sync", async () => {
		const inst = harness();
		await inst.start();
		const patch = await inst.toolResult(
			params({ key: "a", op: "create", subject: "Bank extraction", questions: [question("q1")] }),
			batch(created("a", task("24", { status: "completed", questions: [question("q1")], answers: [answered("q1", "done", "tool:Bash")] }))),
		);
		const text = inst.textOf(patch);
		expect(text).toContain("nothing was created for task #24");
		expect(text).not.toContain("is Done");
		expect(inst.calls.comments).toHaveLength(0);
	});
});

group("verified mappings recover automatically", () => {
	it("retries the same task once when a declared project becomes resolvable", async () => {
		const inst = harness({
			projects: [{ name: "Hoja" }], resolveFailures: 1, config: () => ({ project: "Hoja" }),
		});
		await inst.start();
		const patch = await inst.toolResult(params({ key: "a", op: "create", subject: "Root", questions: [] }),
			batch(created("a", task("1"))));

		expect(inst.calls.resolves).toBe(2);
		expect(inst.calls.create).toHaveLength(1);
		expect(inst.textOf(patch)).toContain("linked TREBOL-1");
		expect(inst.issues.size).toBe(1);
	});

	it("reuses the chat's remembered selection on resume without rediscovery", async () => {
		const inst = harness({ projects: [{ name: "Trebol" }] });
		inst.entries.push({ type: "custom", customType: "hoja-project", data: { name: "Trebol" } });
		await inst.start();
		const patch = await inst.toolResult(params({ key: "a", op: "create", subject: "Root", questions: [] }),
			batch(created("a", task("1"))));

		expect(inst.calls.create).toHaveLength(1);
		expect(inst.textOf(patch)).not.toContain("Hoja recovery");
	});

	it("does not guess when several projects are plausible", async () => {
		const inst = harness({ projects: [{ name: "Hoja" }, { name: "Migracion SAP" }, { name: "Clover Query" }] });
		await inst.start();
		const patch = await inst.toolResult(params({ key: "a", op: "create", subject: "Bank extraction", questions: [] }),
			batch(created("a", task("24"))));
		const text = inst.textOf(patch);

		expect(inst.calls.create).toHaveLength(0);
		expect(text).toContain("Do not pick by position or name similarity");
		expect(text).toContain("Ask the user only when the evidence is genuinely ambiguous");
	});
});

group("discovery failure and bounds", () => {
	it("keeps working when the catalogue is unavailable, with bounded attempts", async () => {
		const inst = harness({ catalogError: "network down" });
		await inst.start();
		const first = await inst.toolResult(params({ key: "a", op: "create", subject: "Root", questions: [] }),
			batch(created("a", task("1"))));
		expect(inst.textOf(first)).toContain("discovery is unavailable");
		expect(inst.textOf(first)).toContain("not blocked");
		expect(inst.calls.create).toHaveLength(0);
		expect(inst.calls.discovery).toBe(1);

		// A second task that fails to file gets its own single note; discovery runs at most MAX times.
		const second = await inst.toolResult(params({ key: "b", op: "create", subject: "Root 2", questions: [] }),
			batch(created("b", task("2"))));
		expect(inst.textOf(second)).toContain("Hoja recovery");
		expect(inst.calls.discovery).toBe(2);

		const third = await inst.toolResult(params({ key: "c", op: "create", subject: "Root 3", questions: [] }),
			batch(created("c", task("3"))));
		expect(inst.textOf(third)).not.toContain("Hoja recovery");
		expect(inst.calls.discovery).toBe(MAX_RECOVERY_ATTEMPTS);
		expect(inst.calls.create).toHaveLength(0);
	});

	it("survives a reload without repeating the note", async () => {
		const first = harness({ projects: [{ name: "Hoja" }] });
		await first.start();
		const patch = await first.toolResult(params({ key: "a", op: "create", subject: "Root", questions: [] }),
			batch(created("a", task("1"))));
		expect(first.textOf(patch)).toContain("Hoja recovery");
		const recovery = first.entries.filter((entry) => entry.customType === HOJA_RECOVERY_ENTRY).at(-1);
		expect(recovery?.data).toMatchObject({ attempts: 1, reported: ["1"] });

		// Resume with the same journal: the reported task is remembered, so no second nag.
		const resumed = harness({ projects: [{ name: "Hoja" }], entries: first.entries });
		await resumed.start();
		const again = await resumed.toolResult(params({ key: "b", op: "update" }), batch(updated("b", task("1"))));
		expect(resumed.textOf(again)).not.toContain("Hoja recovery");
	});

	it("does no discovery, publication or note after /hoja off", async () => {
		const inst = harness({ projects: [{ name: "Hoja" }] });
		await inst.start();
		await inst.commandRun("off");
		const patch = await inst.toolResult(params({ key: "a", op: "create", subject: "Root", questions: [] }),
			batch(created("a", task("1"))));

		expect(patch).toBeUndefined();
		expect(inst.calls.discovery).toBe(0);
		expect(inst.calls.create).toHaveLength(0);
		expect(inst.entries.some((entry) => entry.customType === HOJA_RECOVERY_ENTRY)).toBe(false);
	});
});

group("queued tasks recover without hidden metadata", () => {
	it("files a queued task as soon as the user selects a project", async () => {
		const inst = harness({ projects: [{ name: "Trebol" }] });
		await inst.start();
		await inst.toolResult(params({ key: "a", op: "create", subject: "Bank extraction", questions: [question("q1")] }),
			batch(created("a", task("24", { questions: [question("q1")] }))));
		expect(inst.calls.create).toHaveLength(0);

		const tool = inst.tools.get("hoja_project");
		const result = await tool.execute("id", { action: "select", name: "Trebol" }, undefined, undefined, inst.ctx);
		const body = JSON.parse(result.content[0].text);
		expect(inst.calls.create).toHaveLength(1);
		expect(body.recovered).toMatchObject({ linked: ["TREBOL-1"] });

		const recovery = inst.entries.filter((entry) => entry.customType === HOJA_RECOVERY_ENTRY).at(-1);
		expect(recovery?.data.pending).toEqual([]);
	});

	it("retries the durable queue on a plain update after a reload", async () => {
		const first = harness({ projects: [{ name: "Trebol" }] });
		await first.start();
		await first.toolResult(params({ key: "a", op: "create", subject: "Bank extraction", questions: [question("q1")] }),
			batch(created("a", task("24", { questions: [question("q1")] }))));
		const queued = first.entries.filter((entry) => entry.customType === HOJA_RECOVERY_ENTRY).at(-1);
		expect(queued?.data.pending).toHaveLength(1);

		// The user confirmed Trebol in an earlier turn; the task is retried from the task's own snapshot on a plain
		// update — no metadata is repeated by the model.
		first.entries.push({ type: "custom", customType: "hoja-project", data: { name: "Trebol" } });
		const resumed = harness({ projects: [{ name: "Trebol" }], entries: first.entries });
		await resumed.start();
		const patch = await resumed.toolResult(params({ key: "b", op: "update" }), batch(updated("b", task("24"))));

		expect(resumed.calls.create).toHaveLength(1);
		expect(resumed.textOf(patch)).toContain("linked TREBOL-1");
		const recovery = resumed.entries.filter((entry) => entry.customType === HOJA_RECOVERY_ENTRY).at(-1);
		expect(recovery?.data.pending).toEqual([]);
	});
});

group("user-confirmed mapping persistence", () => {
	it("never persists a repository mapping on an ordinary select", async () => {
		const persisted: string[] = [];
		const inst = harness({ projects: [{ name: "Trebol" }], persist: (name) => persisted.push(name) });
		await inst.start();
		const tool = inst.tools.get("hoja_project");
		const result = await tool.execute("id", { action: "select", name: "Trebol" }, undefined, undefined, inst.ctx);

		expect(JSON.parse(result.content[0].text).project).toBe("Trebol");
		expect(persisted).toEqual([]);
		expect(inst.entries.some((entry) => entry.customType === "hoja-project")).toBe(true);
	});

	it("does not persist when the host cannot confirm, and says so", async () => {
		const persisted: string[] = [];
		const inst = harness({ projects: [{ name: "Trebol" }], persist: (name) => persisted.push(name) });
		await inst.start();
		const tool = inst.tools.get("hoja_project");
		const result = await tool.execute("id", { action: "select", name: "Trebol", remember: true }, undefined, undefined, inst.ctx);
		const body = JSON.parse(result.content[0].text);

		expect(persisted).toEqual([]);
		expect(body.remembered).toBe(false);
		expect(body.note).toContain("needs interactive confirmation");
	});

	it("persists only after an explicit host confirmation", async () => {
		const persisted: string[] = [];
		const inst = harness({ projects: [{ name: "Trebol" }], persist: (name) => { persisted.push(name); return true; }, confirm: true });
		await inst.start();
		const tool = inst.tools.get("hoja_project");
		const result = await tool.execute("id", { action: "select", name: "Trebol", remember: true }, undefined, undefined, inst.ctx);
		const body = JSON.parse(result.content[0].text);

		expect(persisted).toEqual(["Trebol"]);
		expect(body.remembered).toBe(true);
	});
});

group("authoritative queue snapshots", () => {
	const queuedOf = (inst: ReturnType<typeof harness>) =>
		inst.entries.filter((entry) => entry.customType === HOJA_RECOVERY_ENTRY).at(-1)?.data?.pending ?? [];

	it("keeps canonical task.answers so a completed queued task closes with evidence", async () => {
		const inst = harness({ projects: [{ name: "Trebol" }] });
		await inst.start();
		await inst.toolResult(
			params({ key: "a", op: "create", subject: "Bank", questions: [question("q1", "Done?")] }),
			batch(created("a", task("24", {
				status: "completed", questions: [question("q1", "Done?")],
				answers: [answered("q1", "Yes", "tool:Bash")],
			}))),
		);
		expect(queuedOf(inst)[0].questions[0]).toMatchObject({ answer: "Yes", evidence: "tool:Bash" });

		const tool = inst.tools.get("hoja_project");
		await tool.execute("id", { action: "select", name: "Trebol" }, undefined, undefined, inst.ctx);
		expect(inst.calls.create).toHaveLength(1);
		expect(inst.calls.create[0].description).toContain("Yes");
		expect(inst.calls.comments).toHaveLength(1);
		expect(inst.issues.get("issue-1")?.state).toBe("Done");
	});

	it("drops a queued task that the task itself deleted before the selection", async () => {
		const inst = harness({ projects: [{ name: "Trebol" }] });
		await inst.start();
		await inst.toolResult(params({ key: "a", op: "create", subject: "Bank", questions: [] }), batch(created("a", task("24"))));
		await inst.toolResult(params({ key: "b", op: "update" }), batch(updated("b", task("24", { status: "deleted" }))));
		expect(queuedOf(inst)).toEqual([]);

		const tool = inst.tools.get("hoja_project");
		await tool.execute("id", { action: "select", name: "Trebol" }, undefined, undefined, inst.ctx);
		expect(inst.calls.create).toHaveLength(0);
	});

	it("drops a queued task the agent marks local", async () => {
		const inst = harness({ projects: [{ name: "Trebol" }] });
		await inst.start();
		await inst.toolResult(params({ key: "a", op: "create", subject: "Bank", questions: [] }), batch(created("a", task("24"))));
		await inst.toolResult(params({ key: "b", op: "update", metadata: { hoja: "local" } }), batch(updated("b", task("24"))));
		expect(queuedOf(inst)).toEqual([]);
	});

	it("ignores failed mutation results instead of queueing them", async () => {
		const inst = harness();
		await inst.start();
		await inst.toolResult(params({ key: "a", op: "create", subject: "Broken", questions: [] }),
			batch({ key: "a", op: "create", status: "failed", data: { task: task("25") } }));
		expect(queuedOf(inst)).toEqual([]);
	});

	it("refreshes a queued snapshot on a plain update that produces no publication record", async () => {
		const inst = harness({ projects: [{ name: "Trebol" }] });
		await inst.start();
		await inst.toolResult(params({ key: "a", op: "create", subject: "Bank", questions: [question("q1")] }),
			batch(created("a", task("24", { questions: [question("q1")] }))));
		await inst.toolResult(params({ key: "b", op: "update" }), batch(updated("b", task("24", {
			status: "completed", questions: [question("q1")], answers: [answered("q1", "late", "tool:hoja_get")],
		}))));
		const queued = queuedOf(inst)[0];
		expect(queued.status).toBe("completed");
		expect(queued.questions[0]).toMatchObject({ answer: "late", evidence: "tool:hoja_get" });
	});
});

group("queue overflow is explicit", () => {
	it("reports overflow instead of silently dropping the oldest task", async () => {
		const inst = harness();
		await inst.start();
		const results = Array.from({ length: 11 }, (_, index) => created(`c${index}`, task(String(index + 1))));
		const patch = await inst.toolResult(
			params(...results.map((result) => ({ key: result.key, op: "create", subject: "Root", questions: [] }))),
			batch(...results),
		);
		const text = inst.textOf(patch);
		const queued = inst.entries.filter((entry) => entry.customType === HOJA_RECOVERY_ENTRY).at(-1)?.data?.pending ?? [];
		expect(queued).toHaveLength(10);
		expect(text).toContain("1 more are not queued");
		expect(text).toContain("re-queued from its authoritative task");
	});
});

group("selection concurrency and honest persistence", () => {
	it("does not double-create when a select races an in-flight batch", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const inst = harness({ projects: [{ name: "Trebol" }], config: () => ({ project: "Trebol" }), resolveGate: () => gate });
		await inst.start();
		const pendingBatch = inst.toolResult(params({ key: "a", op: "create", subject: "Root", questions: [] }), batch(created("a", task("1"))));
		await new Promise((resolve) => setTimeout(resolve, 0));
		const tool = inst.tools.get("hoja_project");
		const selecting = tool.execute("id", { action: "select", name: "Trebol" }, undefined, undefined, inst.ctx);
		release();
		await Promise.all([pendingBatch, selecting]);
		expect(inst.calls.create).toHaveLength(1);
		expect(inst.issues.size).toBe(1);
	});

	it("reports remembered=false when the repository writer refuses", async () => {
		const inst = harness({
			projects: [{ name: "Trebol" }], confirm: true,
			persist: () => ({ ok: false, reason: "invalid_existing" }),
		});
		await inst.start();
		const tool = inst.tools.get("hoja_project");
		const result = await tool.execute("id", { action: "select", name: "Trebol", remember: true }, undefined, undefined, inst.ctx);
		const body = JSON.parse(result.content[0].text);
		expect(body.remembered).toBe(false);
		expect(body.note).toContain("was not written (invalid_existing)");
	});
});

group("guidance matches the recovery contract", () => {
	it("no longer tells the agent that work must stop while filing is unresolved", () => {
		expect(HOJA_RULE).toContain("Missing filing never blocks your work");
		expect(HOJA_RULE).not.toContain("Do not continue implementation while filing is unresolved");
	});
});
