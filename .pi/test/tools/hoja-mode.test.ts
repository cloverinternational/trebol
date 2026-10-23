import { describe, expect, it } from "vitest";
import {
	CLOSED_STATE_TYPES, COMMENT_BODY_LIMIT, HOJA_QUERIES, HOJA_RULE, MAX_LIMIT, buildIssueFilter, hojaTools, registerHojaMode,
} from "../../../extensions/hoja-mode/extension.ts";
import { HojaClient } from "../../lib/claw/hoja.ts";

const TOKEN = "lin_secret_test_token";
const issues = [
	{ identifier: "TREBOL-1", title: "Open item", priority: 2, createdAt: "2026-10-01T10:00:00.000Z", updatedAt: "2026-10-22T10:00:00.000Z",
		state: { name: "In Progress" }, assignee: { name: "Alice" }, project: { name: "Infra" } },
	{ identifier: "TREBOL-2", title: "Other item", priority: 0, createdAt: "2026-10-02T10:00:00.000Z", updatedAt: "2026-10-21T10:00:00.000Z",
		state: { name: "Todo" }, assignee: null, project: null },
];

const detail = {
	...issues[0], description: "Do the thing.\n".repeat(5), url: "https://hoja.clover4.app/issue/TREBOL-1",
	state: { name: "In Progress", type: "started" }, team: { key: "TREBOL" },
	comments: { nodes: [
		{ body: "First comment", createdAt: "2026-10-20T12:00:00.000Z", user: { name: "Bob" } },
		{ body: "x".repeat(COMMENT_BODY_LIMIT + 25), createdAt: "2026-10-21T12:00:00.000Z", user: { name: "Carol" } },
	] },
};

function fakeClient(response: unknown, status = 200) {
	const calls: { query: string; variables: Record<string, unknown> }[] = [];
	return {
		calls,
		client: {
			async gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
				calls.push({ query, variables });
				if (status !== 200) throw new Error(`Hoja HTTP ${status}`);
				return response as T;
			},
		},
	};
}

const listTool = (client: any) => hojaTools(client).find(t => t.name === "hoja_list")!;
const getTool = (client: any) => hojaTools(client).find(t => t.name === "hoja_get")!;
const body = (result: { content: { text: string }[] }) => JSON.parse(result.content[0].text);
const listCall = async (params: Record<string, unknown> = {}) => {
	const { client, calls } = fakeClient({ issues: { nodes: issues } });
	const result = await listTool(client).execute("id", params);
	return { result, variables: calls[0].variables, query: calls[0].query, filter: calls[0].variables.filter };
};

describe("hoja_list", () => {
	it("defaults to open issues, asks for one sentinel row, and returns the dates", async () => {
		const { result, query, variables } = await listCall();
		expect(variables.first).toBe(101);
		expect(variables.filter).toEqual({ state: { type: { nin: [...CLOSED_STATE_TYPES] } } });
		expect(query).toBe(HOJA_QUERIES.list);
		expect(query).toContain("createdAt");
		expect(query).toContain("updatedAt");
		const data = body(result);
		expect(data).toMatchObject({ returnedCount: 2, truncated: false });
		expect(data.issues[0]).toMatchObject({ identifier: "TREBOL-1", createdAt: "2026-10-01T10:00:00.000Z", updatedAt: "2026-10-22T10:00:00.000Z" });
	});

	it.each([
		["closed", { state: { type: { in: [...CLOSED_STATE_TYPES] } } }],
		["completed", { state: { type: { eq: "completed" } } }],
		["In Review", { state: { name: { eqIgnoreCase: "In Review" } } }],
	])("maps state=%s to a server-side filter", async (state, expected) => {
		expect((await listCall({ state })).filter).toEqual(expected);
	});

	it("treats an explicit open/all request as open", async () => {
		expect((await listCall({ state: "open" })).filter).toEqual({ state: { type: { nin: [...CLOSED_STATE_TYPES] } } });
		expect((await listCall({ state: "  " })).filter).toEqual({ state: { type: { nin: [...CLOSED_STATE_TYPES] } } });
		// "all" drops the state clause entirely rather than trying to match a state named "all".
		expect((await listCall({ state: "all" })).filter).toEqual({});
	});

	it("filters by assignee, project and team server-side", async () => {
		expect((await listCall({ assignee: "ali" })).filter).toEqual({ and: [
			{ state: { type: { nin: [...CLOSED_STATE_TYPES] } } },
			{ assignee: { name: { containsIgnoreCase: "ali" } } },
		] });
		expect((await listCall({ state: "closed", project: "CRM" })).filter).toEqual({ and: [
			{ state: { type: { in: [...CLOSED_STATE_TYPES] } } },
			{ project: { name: { eqIgnoreCase: "CRM" } } },
		] });
		expect((await listCall({ team: " trebol " })).filter).toEqual({ and: [
			{ state: { type: { nin: [...CLOSED_STATE_TYPES] } } },
			{ team: { key: { eq: "TREBOL" } } },
		] });
	});

	it("turns updated/created bounds into ISO instants, day-only meaning UTC midnight", async () => {
		expect((await listCall({ state: "all", updatedSince: "2026-10-22", updatedBefore: "2026-10-23" })).filter).toEqual({ and: [
			{ updatedAt: { gte: "2026-10-22T00:00:00.000Z" } },
			{ updatedAt: { lt: "2026-10-23T00:00:00.000Z" } },
		] });
		expect((await listCall({ state: "all", createdSince: "2026-10-01T05:30:00-05:00" })).filter)
			.toEqual({ createdAt: { gte: "2026-10-01T10:30:00.000Z" } });
	});

	it("honours limit and reports truncation with a sentinel row", async () => {
		for (const [count, limit, truncated] of [[0, 100, false], [100, 100, false], [101, 100, true], [6, 5, true], [5, 5, false]] as const) {
			const { client, calls } = fakeClient({ issues: { nodes: Array.from({ length: count }, () => issues[0]) } });
			const data = body(await listTool(client).execute("id", limit === 100 ? {} : { limit }));
			expect(calls[0].variables.first).toBe(limit + 1);
			expect(data.truncated).toBe(truncated);
			expect(data.returnedCount).toBe(Math.min(count, limit));
			expect(data.issues).toHaveLength(Math.min(count, limit));
		}
	});

	it.each([{ limit: 0 }, { limit: MAX_LIMIT + 1 }, { limit: 1.5 }, { updatedSince: "yesterday" }, { createdBefore: "22/10/2026" }])
	("refuses invalid parameters locally without calling Hoja: %o", async (params) => {
		const { client, calls } = fakeClient({ issues: { nodes: [] } });
		const result = await listTool(client).execute("id", params);
		expect(result.isError).toBe(true);
		expect(calls).toHaveLength(0);
	});

	it("surfaces API errors without echoing the token", async () => {
		const client = { async gql<T>(): Promise<T> { throw new Error(`Authorization: ${TOKEN}`); } };
		const result = await listTool(client).execute("id", {});
		expect(result.isError).toBe(true);
		expect(result.content[0].text).not.toContain(TOKEN);
	});
});

describe("hoja_get", () => {
	it("looks the issue up server-side by identifier, so age never matters", async () => {
		const { client, calls } = fakeClient({ issues: { nodes: [detail] } });
		const result = await getTool(client).execute("id", { identifier: " trebol-1 " });
		expect(calls[0].query).toBe(HOJA_QUERIES.get);
		expect(calls[0].variables).toMatchObject({ filter: { identifier: { eq: "TREBOL-1" } }, comments: 10 });
		expect(calls[0].query).not.toContain("250");
		const data = body(result);
		expect(data).toMatchObject({
			identifier: "TREBOL-1", title: "Open item", description: detail.description, createdAt: issues[0].createdAt,
			updatedAt: issues[0].updatedAt, url: detail.url, state: { name: "In Progress", type: "started" }, team: { key: "TREBOL" },
			assignee: { name: "Alice" }, project: { name: "Infra" },
		});
		expect(data.comments, "comments carry author, date and body").toEqual([
			{ author: "Bob", createdAt: "2026-10-20T12:00:00.000Z", body: "First comment" },
			{ author: "Carol", createdAt: "2026-10-21T12:00:00.000Z", body: expect.stringContaining("… [truncated: 25 more characters]") },
		]);
		expect(data.comments[1].body.length).toBeLessThan(COMMENT_BODY_LIMIT + 60);
		expect(data.commentsReturned).toBe(2);
		expect(data.commentsNote).toBeUndefined();
	});

	it("passes the requested comment count and warns when the page may be partial", async () => {
		const { client, calls } = fakeClient({ issues: { nodes: [detail] } });
		const data = body(await getTool(client).execute("id", { identifier: "TREBOL-1", comments: 2 }));
		expect(calls[0].variables.comments).toBe(2);
		expect(data.commentsNote).toContain("older ones may exist");
	});

	it("reports a miss as an error instead of returning another issue", async () => {
		const { client } = fakeClient({ issues: { nodes: [detail] } });
		const miss = await getTool(client).execute("id", { identifier: "TREBOL-999" });
		expect(miss.isError).toBe(true);
		expect(body(miss).error).toContain("not found");
	});

	it("refuses a malformed identifier or comment count without calling Hoja", async () => {
		const { client, calls } = fakeClient({ issues: { nodes: [] } });
		for (const params of [{ identifier: "" }, { identifier: "not-an-issue" }, { identifier: "TREBOL-1", comments: 0 }, { identifier: "TREBOL-1", comments: 51 }]) {
			expect((await getTool(client).execute("id", params)).isError).toBe(true);
		}
		expect(calls).toHaveLength(0);
	});
});

describe("hoja-mode read-only guarantee", () => {
	it("ships only fixed query documents, never a mutation", () => {
		for (const [name, document] of Object.entries(HOJA_QUERIES)) {
			expect(document, name).toMatch(/^query \(/);
			expect(document, name).not.toMatch(/\bmutation\b/i);
			expect(document, name).not.toMatch(/\bsubscription\b/i);
		}
	});

	it("sends only those documents and never caller text, for a wide spread of inputs", async () => {
		const { client, calls } = fakeClient({ issues: { nodes: [detail] } });
		const tools = hojaTools(client);
		await tools[0].execute("id", {});
		await tools[0].execute("id", { state: "closed", assignee: "x", project: "y", team: "z", updatedSince: "2026-01-01", limit: 3 });
		await tools[0].execute("id", { state: '"} } mutation { issueCreate(input: {}) { success } #' });
		await tools[1].execute("id", { identifier: "TREBOL-1" });
		expect(new Set(calls.map(c => c.query))).toEqual(new Set([HOJA_QUERIES.list, HOJA_QUERIES.get]));
		// A state that tries to look like GraphQL stays a JSON string inside the variables, never query text.
		expect(calls[2].query).toBe(HOJA_QUERIES.list);
		expect(calls[2].variables.filter).toEqual({ state: { name: { eqIgnoreCase: '"} } mutation { issueCreate(input: {}) { success } #' } } });
	});

	it("exposes no raw-query parameter and no permissive schema", () => {
		for (const tool of hojaTools({ async gql<T>(): Promise<T> { return {} as T; } })) {
			const properties = (tool.parameters as { properties?: Record<string, unknown> }).properties ?? {};
			expect(Object.keys(properties).some(key => /query|document|graphql|mutation|raw/i.test(key))).toBe(false);
			expect((tool.parameters as { additionalProperties?: boolean }).additionalProperties).toBe(false);
		}
	});

	it("builds filters from fixed keys only, so no caller value can become GraphQL", () => {
		const filter = buildIssueFilter({ state: "closed", assignee: "a", project: "p", team: "t", updatedSince: "2026-01-01", createdBefore: "2026-02-01" });
		expect(JSON.stringify(filter)).not.toContain("mutation");
		const keys = (value: unknown): string[] => Array.isArray(value) ? value.flatMap(keys)
			: typeof value !== "object" || value === null ? []
			: Object.entries(value).flatMap(([k, v]) => [k, ...keys(v)]);
		const allowed = new Set(["and", "state", "assignee", "project", "team", "updatedAt", "createdAt", "name", "key", "type", "eq", "in", "nin", "gte", "lt", "eqIgnoreCase", "containsIgnoreCase"]);
		expect(keys(filter).filter(k => !allowed.has(k))).toEqual([]);
	});
});

describe("shared Hoja client safety", () => {
	it.each(["http", "graphql", "network", "json"])("does not leak secrets via %s errors", async (kind) => {
		const client = new HojaClient({ token: TOKEN, fetch: async () => {
			if (kind === "network") throw new Error(TOKEN);
			return { status: kind === "http" ? 403 : 200, text: async () => kind === "json" ? TOKEN : JSON.stringify({ errors: [{ message: TOKEN }] }) };
		} });
		const result = await hojaTools(client)[0].execute("id", {});
		expect(result.isError).toBe(true);
		expect(JSON.stringify(result)).not.toContain(TOKEN);
	});
	it.each(["fetch", "body"])("bounds a stalled %s and aborts the request", async (stage) => {
		let signal: AbortSignal | undefined;
		const client = new HojaClient({ token: TOKEN, timeoutMs: 10, fetch: async (_url, init) => {
			signal = init.signal;
			if (stage === "fetch") return new Promise(() => {});
			return { status: 200, text: () => new Promise(() => {}) };
		} });
		await expect(client.gql("query { viewer { id } }")).rejects.toThrow("timed out");
		expect(signal?.aborted).toBe(true);
	});
	it("retains valid results and refuses redirects", async () => {
		const client = new HojaClient({ token: TOKEN, fetch: async (_url, init) => {
			expect(init.redirect).toBe("error");
			expect(init.headers.Authorization).toBe(TOKEN);
			return { status: 200, text: async () => JSON.stringify({ data: { viewer: { id: "1" } } }) };
		} });
		await expect(client.gql("query { viewer { id } }")).resolves.toEqual({ viewer: { id: "1" } });
	});
});

describe("hoja-mode registration", () => {
	it("registers only read tools and appends the confirmation rule to the prompt", async () => {
		const registered: string[] = [];
		let hook: ((event: any) => any) | undefined;
		const pi = {
			registerTool: (t: { name: string }) => registered.push(t.name),
			registerCommand: () => {},
			on: (_event: string, handler: (event: any) => any) => { hook = handler; },
		};
		const { client } = fakeClient({ issues: { nodes: [] } });
		registerHojaMode(pi, client);
		expect(registered).toEqual(["hoja_list", "hoja_get"]);
		expect(registered.some(n => /update|create|set|delete/.test(n))).toBe(false);
		const out = hook!({ systemPrompt: "base" });
		expect(out.systemPrompt.startsWith("base\n")).toBe(true);
		expect(out.systemPrompt).toContain(HOJA_RULE);
		expect(HOJA_RULE).toContain("ask the user to confirm");
	});
	it("registers /hoja and toggles only the proactive guidance", async () => {
		const hooks = new Map<string, Function>();
		let command: any;
		const notices: string[] = [];
		registerHojaMode({
			registerTool: () => {},
			registerCommand: (name: string, definition: any) => { expect(name).toBe("hoja"); command = definition; },
			on: (name: string, handler: Function) => hooks.set(name, handler),
		}, { async gql<T>(): Promise<T> { throw new Error("Command must not access Hoja"); } });
		const ctx = { ui: { notify: (message: string) => notices.push(message) } };
		const prompt = () => hooks.get("before_agent_start")!({ systemPrompt: "base" });
		await command.handler("", ctx);
		expect(notices.at(-1)).toContain("mode on");
		await command.handler("off", ctx);
		expect(prompt()).toBeUndefined();
		await command.handler("invalid", ctx);
		expect(notices.at(-1)).toContain("Usage:");
		expect(prompt()).toBeUndefined();
		await command.handler("on", ctx);
		expect(prompt().systemPrompt).toContain(HOJA_RULE);
		await command.handler("off", ctx);
		hooks.get("session_start")!();
		expect(prompt().systemPrompt).toContain(HOJA_RULE);
	});
});
