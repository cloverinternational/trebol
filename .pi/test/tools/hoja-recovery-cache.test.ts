import { describe as group, expect, it } from "vitest";
import { HojaClient } from "../../lib/claw/hoja.ts";
import { registerHojaMode } from "../../../extensions/hoja-mode/extension.ts";

/** The real HojaClient, whose catalogue is cached after the first resolve. The board only gains the "Trebol" project
 *  after that first resolve, so the retry can succeed only if discovery invalidates the cache. */
function realCachedClient() {
	const calls = { catalogLoads: 0, creates: 0, discovery: 0 };
	let createdDescription = "";
	let state = { withTrebol: false };
	const catalog = (withTrebol: boolean) => ({
		viewer: { id: "me", name: "Luis" },
		projects: {
			nodes: [
				{ id: "p-hoja", name: "Hoja", teams: { nodes: [{ id: "team", key: "TREBOL" }] } },
				...(withTrebol ? [{ id: "p-trebol", name: "Trebol", teams: { nodes: [{ id: "team", key: "TREBOL" }] } }] : []),
			],
		},
		teams: {
			nodes: [{
				id: "team", key: "TREBOL",
				states: { nodes: [{ id: "s-todo", name: "Todo" }, { id: "s-active", name: "In Progress" }, { id: "s-done", name: "Done" }] },
				members: { nodes: [{ id: "me", name: "Luis" }] },
			}],
		},
	});
	const fetchImpl = async (_url: string, init: { body: string }) => {
		const { query, variables } = JSON.parse(init.body) as { query: string; variables?: any };
		const reply = (data: unknown) => ({ status: 200, text: async () => JSON.stringify({ data }) });
		if (query.includes("projects(first: 200)")) {
			calls.catalogLoads += 1;
			return reply(catalog(state.withTrebol));
		}
		if (query.includes("projects(first: 201)")) {
			calls.discovery += 1;
			// The board gains the project between the failed resolve and discovery, which is the case a stale client
			// catalogue cannot see without invalidation.
			state.withTrebol = true;
			return reply(catalog(true));
		}
		if (query.includes("issueCreate")) {
			calls.creates += 1;
			createdDescription = String(variables?.input?.description ?? "");
			return reply({ issueCreate: { success: true, issue: { id: "issue-1", identifier: "TREBOL-1" } } });
		}
		if (query.includes("issue(id:")) return reply({
			issue: {
				id: "issue-1", identifier: "TREBOL-1", title: "Root", description: createdDescription,
				state: { name: "In Progress" }, team: { id: "team" }, project: { id: "p-trebol" }, assignee: { id: "me" },
				parent: null, comments: { nodes: [] },
			},
		});
		if (query.includes("issueUpdate")) return reply({ issueUpdate: { success: true } });
		if (query.includes("commentCreate")) return reply({ commentCreate: { success: true } });
		throw new Error(`unexpected query: ${query.slice(0, 60)}`);
	};
	return { client: new HojaClient({ url: "https://hoja.test/graphql", token: "t", fetch: fetchImpl as any }), calls, state };
}

group("real cached catalogue", () => {
	it("invalidates the client cache after discovery so the retry sees the new project", async () => {
		const board = realCachedClient();
		const handlers: Record<string, Function[]> = {};
		const entries: any[] = [];
		const pi = {
			registerTool: () => {}, registerCommand: () => {},
			on: (name: string, handler: Function) => { (handlers[name] ??= []).push(handler); },
			appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
		};
		registerHojaMode(pi, board.client, {
			project: "", config: () => ({ project: "Trebol" }), persist: () => {},
		});
		const ctx = {
			sessionManager: { getSessionId: () => "session-cache", getBranch: () => entries },
			ui: { notify: () => {} },
		};
		for (const handler of handlers.session_start ?? []) await handler({}, ctx);

		const operations = { operations: [{ key: "a", op: "create", subject: "Root", questions: [] }] };
		const results = { status: "succeeded", results: [{ key: "a", op: "create", status: "succeeded", data: { task: { id: "1", subject: "Root", status: "in_progress", parent_id: "", questions: [] } } }] };
		let patch: any;
		for (const handler of handlers.tool_result ?? []) patch = await handler({ toolName: "TaskManage", input: operations, details: { batch: results }, content: [{ type: "text", text: "{}" }] }, ctx);

		// First resolve saw the old board (no Trebol) and cached it; discovery then saw the new project, and the retry
		// could only succeed because the cache was invalidated.
		expect(board.calls.catalogLoads).toBe(2);
		expect(board.calls.discovery).toBe(1);
		expect(board.calls.creates).toBe(1);
		expect(patch.content.map((block: any) => block.text).join("\n")).toContain("linked TREBOL-1");
	});
});
