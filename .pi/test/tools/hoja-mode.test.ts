import { describe, expect, it } from "vitest";
import { HOJA_RULE, hojaTools, registerHojaMode } from "../../../extensions/hoja-mode/extension.ts";
import { HojaClient } from "../../lib/claw/hoja.ts";

const TOKEN = "lin_secret_test_token";
const issues = [
	{ identifier: "TREBOL-1", title: "Open item", priority: 2, state: { name: "In Progress" }, assignee: { name: "Alice" }, project: { name: "Infra" } },
	{ identifier: "TREBOL-2", title: "Other item", priority: 0, state: { name: "Todo" }, assignee: null, project: null },
];

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

describe("hoja-mode tools", () => {
	it("hoja_list returns open issues and filters completed or canceled server-side", async () => {
		const { client, calls } = fakeClient({ issues: { nodes: issues } });
		const list = hojaTools(client).find(t => t.name === "hoja_list")!;
		const result = await list.execute("id", {});
		expect(calls[0].query).toContain('nin: ["completed", "canceled"]');
		expect(JSON.parse(result.content[0].text)).toMatchObject({ issues, returnedCount: 2, truncated: false });
		expect(calls[0].variables.first).toBe(101);
	});

	it("hoja_get finds one issue by identifier and reports a miss as an error", async () => {
		const { client } = fakeClient({ issues: { nodes: issues } });
		const get = hojaTools(client).find(t => t.name === "hoja_get")!;
		expect(JSON.parse((await get.execute("id", { identifier: "TREBOL-2" })).content[0].text).title).toBe("Other item");
		const miss = await get.execute("id", { identifier: "TREBOL-999" });
		expect(miss.isError).toBe(true);
	});

	it("surfaces API errors without echoing the token", async () => {
		const client = { async gql<T>(): Promise<T> { throw new Error(`Authorization: ${TOKEN}`); } };
		const list = hojaTools(client).find(t => t.name === "hoja_list")!;
		const result = await list.execute("id", {});
		expect(result.isError).toBe(true);
		expect(result.content[0].text).not.toContain(TOKEN);
	});
	it.each([0, 100, 101])("reports truncation correctly for %i rows", async (count) => {
		const { client } = fakeClient({ issues: { nodes: Array.from({ length: count }, () => issues[0]) } });
		const result = await hojaTools(client)[0].execute("id", {});
		const data = JSON.parse(result.content[0].text);
		expect(data.truncated).toBe(count > 100);
		expect(data.returnedCount).toBe(Math.min(count, 100));
		expect(data.issues).toHaveLength(Math.min(count, 100));
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
