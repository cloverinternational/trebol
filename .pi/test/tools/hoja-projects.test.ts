import { expect, it } from "vitest";
import { projectTool, PROJECT_CATALOG } from "../../../extensions/hoja-mode/projects.ts";

function fixture() {
	const projects: any[] = [];
	const attempts: string[] = [];
	let selected: string | undefined;
	let writes = 0;
	const client = { async gql<T>(query: string, vars?: any): Promise<T> {
		if (query === PROJECT_CATALOG) return { projects: { nodes: projects }, teams: { nodes: [{ id: "team", key: "TREBOL", name: "Trebol" }] } } as T;
		writes++;
		expect(vars.input.teamIds).toEqual(["team"]);
		projects.push({ id: "p", name: vars.input.name, teams: { nodes: [{ id: "team", key: "TREBOL" }] } });
		return { projectCreate: { success: true, project: { id: "p" } } } as T;
	} };
	const state = { enabled: () => true, current: () => selected, select: (n: string) => { selected = n; }, epoch: () => 1,
		attempt: (n: string) => { attempts.push(n); }, pending: (n: string) => attempts.includes(n) };
	const tool = projectTool(client, state);
	return { tool, projects, attempts, state, writes: () => writes, selected: () => selected };
}
it("lists empty projects and teams without writing", async () => {
	const f = fixture();
	const out = await f.tool.execute("1", { action: "list" });
	expect(out.content[0].text).toContain("TREBOL");
	expect(f.writes()).toBe(0);
});
it("requires user confirmation, journals intent, reads back and selects the created project", async () => {
	const f = fixture();
	const args = { action: "create", name: "Trebol", team: "TREBOL" };
	expect((await f.tool.execute("1", args)).isError).toBe(true);
	expect(f.writes()).toBe(0);
	const out = await f.tool.execute("2", args, undefined, undefined, { hasUI: true, ui: { confirm: async () => true } });
	expect(out.isError).toBeUndefined();
	expect(f.attempts).toEqual(["Trebol"]);
	expect(f.selected()).toBe("Trebol");
	await f.tool.execute("3", args);
	expect(f.writes()).toBe(1);
});
it("declined confirmation never creates", async () => {
	const f = fixture();
	await f.tool.execute("1", { action: "create", name: "Trebol", team: "TREBOL" }, undefined, undefined, { hasUI: true, ui: { confirm: async () => false } });
	expect(f.writes()).toBe(0);
});
it("uncertain attempt without catalog match never creates again", async () => {
	const f = fixture(); f.attempts.push("Trebol");
	const out = await f.tool.execute("1", { action: "create", name: "Trebol", team: "TREBOL" }, undefined, undefined, { hasUI: true, ui: { confirm: async () => true } });
	expect(out.isError).toBe(true);
	expect(f.writes()).toBe(0);
});
