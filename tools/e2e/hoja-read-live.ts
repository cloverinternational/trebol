/** Opt-in read-only check: npx vite-node tools/e2e/hoja-read-live.ts.
 * Credentials read in process; no mutation handler is ever invoked. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { HojaClient } from "../../.pi/lib/claw/hoja.ts";
import { hojaOperationTools } from "../../.pi/lib/tools/hoja-operations.ts";
const token = process.env.LINEAR_TOKEN || process.env.HOJA_API_KEY || readFileSync(join(homedir(), ".config/hoja/api-key"), "utf8").trim();
const tools = hojaOperationTools(new HojaClient({ token }));
async function read(name: string, params: any = {}) {
	assert.ok(["hoja_projects", "hoja_teams", "hoja_issues", "hoja_issue", "hoja_search_issues"].includes(name));
	const r = await tools.find(t => t.name === name)!.execute("live-read", params);
	const data = JSON.parse(r.content[0].text);
	assert.ok(!r.isError, `${name}: ${data.error}`);
	console.log(`PASS ${name}: ${Array.isArray(data.nodes) ? `${data.nodes.length} records, truncated=${data.truncated}` : "detail returned"}`);
	return data;
}
await read("hoja_projects");
const teams = await read("hoja_teams");
assert.ok(teams.nodes.length > 0);
const issues = await read("hoja_issues", { teamId: teams.nodes[0].id, first: 1 });
assert.ok(issues.nodes.length > 0);
const detail = await read("hoja_issue", { id: issues.nodes[0].id });
assert.ok(Object.hasOwn(detail, "description"));
await read("hoja_search_issues", { query: issues.nodes[0].identifier, first: 1 });
console.log("PASS five native reads; zero mutations invoked");
