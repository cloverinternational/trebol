import { describe, it, expect, vi } from "vitest";
import { hojaOperationTools, OPERATION_CONTRACTS, OPERATION_DOCUMENTS } from "../../lib/tools/hoja-operations.ts";
import { HojaClient } from "../../lib/claw/hoja.ts";
import { registerHojaMode } from "../../../extensions/hoja-mode/extension.ts";
import { gateActiveTools } from "../../lib/runtime/swarm-tool-gating.ts";

function fixture(data: any = {}) {
	const gql = vi.fn(async () => data);
	const tools = hojaOperationTools({ gql } as any);
	return { gql, call: (name: string, p: any = {}, ctx?: any, signal?: AbortSignal) => tools.find(t => t.name === name)!.execute("test", p, signal, undefined, ctx) };
}
const body = (r: any) => JSON.parse(r.content[0].text);
describe("native Hoja operations", () => {
	describe.each(["hoja_issue_create", "hoja_issue_update"])("%s calendar validation", name => {
		const args = (dueDate: string) => name === "hoja_issue_create" ? { title: "date probe", teamId: "t", dueDate } : { id: "i", dueDate };
		it.each(["2026-02-31", "2026-02-29", "1900-02-29", "2100-02-29", "2026-04-31", "2026-06-31", "2026-09-31", "2026-11-31", "2026-01-32", "2026-00-10", "2026-13-01", "2026-01-00", "2026-02-31T12:00:00Z", "2026-04-31T12:00:00+02:00", "2026-01-01T24:00:00Z", "2026-01-01T12:60:00Z", "2026-01-01T12:00:60Z", "2026-01-01T12:00:00+24:00", "2026-01-01T12:00:00+01:60", "2026-01-01Tgarbage"])("rejects %s before dispatch", async dueDate => {
			const f = fixture({ issueCreate: { success: true }, issueUpdate: { success: true } });
			expect((await f.call(name, args(dueDate))).isError).toBe(true);
			expect(f.gql).not.toHaveBeenCalled();
		});
		it.each(["2026-01-31", "2026-03-31", "2026-05-31", "2026-07-31", "2026-08-31", "2026-10-31", "2026-12-31", "2026-04-30", "2026-06-30", "2026-09-30", "2026-11-30", "2026-02-28", "2024-02-29", "2000-02-29", "2024-02-29T23:59:59Z", "2024-02-29T23:59:59.123Z", "2024-02-29T23:59:59+02:30", "2024-02-29T00:00:00-05:00", "2024-02-29T12:00", "2024-02-29T12:00:00"])("preserves valid %s unchanged", async dueDate => {
			const f = fixture({ issueCreate: { success: true }, issueUpdate: { success: true } });
			expect((await f.call(name, args(dueDate))).isError).not.toBe(true);
			expect(f.gql).toHaveBeenCalledTimes(1);
			expect((f.gql.mock.calls as any)[0][1].input.dueDate).toBe(dueDate);
		});
	});
	it("registers eleven unique tools once per API object and preserves selection", () => {
		const names: string[] = [];
		const pi = { registerTool: (t: any) => names.push(t.name), registerCommand: vi.fn(), on: vi.fn() };
		registerHojaMode(pi); registerHojaMode(pi);
		expect(names).toEqual(["hoja_list", "hoja_get", ...Object.keys(OPERATION_CONTRACTS)]);
		expect(new Set(names).size).toBe(11);
		expect(gateActiveTools(names, { interactive: true, env: {} }, {})).toBeUndefined();
		expect(gateActiveTools(["hoja_get"], { interactive: false, env: {} }, {}, names)).toBeUndefined();
	});
	it("uses all UUID filters and a sentinel, with caller text only in variables", async () => {
		const f = fixture({ issues: { nodes: [{ id: "1" }, { id: "2" }] } });
		const r = await f.call("hoja_issues", { teamId: "t", projectId: "p", assigneeId: "a", first: 1, excludeStateTypes: ["completed"] });
		expect(body(r)).toEqual({ nodes: [{ id: "1" }], returnedCount: 1, truncated: true });
		expect(f.gql).toHaveBeenCalledWith(OPERATION_DOCUMENTS.hoja_issues, { first: 2, filter: { team: { id: { eq: "t" } }, project: { id: { eq: "p" } }, assignee: { id: { eq: "a" } }, state: { type: { nin: ["completed"] } } } });
	});
	it.each([
		["hoja_projects", {}, { projects: { nodes: [] } }],
		["hoja_teams", {}, { teams: { nodes: [] } }],
		["hoja_issue", { id: "uuid" }, { issue: { id: "uuid", description: "full" } }],
		["hoja_search_issues", { query: 'mutation { nope }' }, { searchIssues: { nodes: [] } }],
	])("reads %s with a fixed document", async (name, params, data) => {
		const f = fixture(data); expect((await f.call(name as string, params)).isError).not.toBe(true);
		expect(f.gql.mock.calls[0][0]).toBe(OPERATION_DOCUMENTS[name as string]);
	});
	it.each([
		["hoja_issue_create", { title: "requested", teamId: "t", assigneeId: "a" }, "issueCreate", { input: { title: "requested", teamId: "t", assigneeId: "a" } }],
		["hoja_issue_update", { id: "i", description: "", priority: 0, stateId: "s" }, "issueUpdate", { id: "i", input: { description: "", priority: 0, stateId: "s" } }],
		["hoja_comment_create", { issueId: "i", body: "requested comment" }, "commentCreate", { input: { issueId: "i", body: "requested comment" } }],
	])("sends one mocked %s with exact fields and no redundant modal", async (name, p, root, variables) => {
		const f = fixture({ [root as string]: { success: true, issue: { id: "i" } } });
		const confirm = vi.fn();
		expect(body(await f.call(name as string, p, { hasUI: true, ui: { confirm } })).verificationRequired).toBe(true);
		expect(confirm).not.toHaveBeenCalled();
		expect(f.gql).toHaveBeenCalledExactlyOnceWith(OPERATION_DOCUMENTS[name as string], variables);
	});
	it.each([undefined, { hasUI: false }, { hasUI: true, ui: { confirm: async () => false } }, { hasUI: true, ui: { confirm: async () => undefined } }])("fails closed for unavailable/cancelled deletion", async ctx => {
		const f = fixture(); expect((await f.call("hoja_issue_delete", { id: "i" }, ctx)).isError).toBe(true);
		expect(f.gql).not.toHaveBeenCalled();
	});
	it("confirms exact deletion target, snapshots args, and sends once", async () => {
		const f = fixture({ issueDelete: { success: true } });
		const p = { id: "original" };
		const confirm = vi.fn(async (_title, message) => { expect(message).toContain("original"); p.id = "changed"; return true; });
		expect((await f.call("hoja_issue_delete", p, { hasUI: true, ui: { confirm } })).isError).not.toBe(true);
		expect(f.gql).toHaveBeenCalledExactlyOnceWith(OPERATION_DOCUMENTS.hoja_issue_delete, { id: "original" });
	});
	it("aborts after confirmation without sending", async () => {
		const f = fixture(); const c = new AbortController();
		await f.call("hoja_issue_delete", { id: "i" }, { hasUI: true, ui: { confirm: async () => { c.abort(); return true; } } }, c.signal);
		expect(f.gql).not.toHaveBeenCalled();
	});
	it.each([
		["hoja_issues", {}], ["hoja_issues", { teamId: "t", first: 201 }], ["hoja_issues", { teamId: "t", first: 1.5 }],
		["hoja_issue_update", { id: "i" }], ["hoja_issue_create", { title: "x", teamId: "t", priority: 5 }],
		["hoja_issue_update", { id: "i", labelIds: ["not-supported"] }], ["hoja_comment_create", { issueId: "i", body: " " }],
		["hoja_issue_delete", { id: "i", confirmed: true }], ["hoja_issue_update", { id: "i", dueDate: "not-a-date" }],
	])("rejects malformed %s before network", async (name, p) => {
		const f = fixture(); expect((await f.call(name as string, p)).isError).toBe(true); expect(f.gql).not.toHaveBeenCalled();
	});
	it.each([401, 403, 500])("sanitizes HTTP %s and never retries", async status => {
		const fetch = vi.fn(async () => ({ status, text: async () => "secret-fixture" }));
		const tool = hojaOperationTools(new HojaClient({ token: "secret-fixture", fetch })).find(t => t.name === "hoja_issue_update")!;
		const r = await tool.execute("t", { id: "i", title: "new" });
		expect(r.isError).toBe(true); expect(JSON.stringify(r)).not.toContain("secret-fixture"); expect(fetch).toHaveBeenCalledTimes(1);
	});
	it("does not call a false mutation response success", async () => {
		const f = fixture({ issueCreate: { success: false } });
		expect(body(await f.call("hoja_issue_create", { title: "x", teamId: "t" }))).toMatchObject({ outcome: "unknown" });
	});
	it.each(["graphql", "partial", "network", "timeout"])("sanitizes %s write failures without retries", async kind => {
		const fetch = vi.fn(async () => {
			if (kind === "network") throw new Error("secret-fixture");
			if (kind === "timeout") return await new Promise<any>(() => {});
			return { status: 200, text: async () => JSON.stringify({ errors: [{ message: "secret-fixture" }], ...(kind === "partial" ? { data: { issueUpdate: null } } : {}) }) };
		});
		const tool = hojaOperationTools(new HojaClient({ token: "secret-fixture", fetch, timeoutMs: 10 })).find(t => t.name === "hoja_issue_update")!;
		const r = await tool.execute("t", { id: "i", title: "new" });
		expect(r.isError).toBe(true);
		expect(body(r).outcome).toBe(kind === "graphql" ? "rejected" : "unknown");
		expect(JSON.stringify(r)).not.toContain("secret-fixture");
		expect(fetch).toHaveBeenCalledTimes(1);
	});
	it("rejects mismatched read IDs", async () => {
		const f = fixture({ issue: { id: "other" } }); expect((await f.call("hoja_issue", { id: "wanted" })).isError).toBe(true);
	});
});
