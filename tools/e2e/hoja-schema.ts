/** Independent schema check. Install isolated validator (no project/global deps):
 * npm install --prefix artifacts/hoja-schema-validator --no-save --package-lock=false --ignore-scripts graphql@16.11.0
 * npx vite-node tools/e2e/hoja-schema.ts --capture  # one READ-ONLY introspection
 * npx vite-node tools/e2e/hoja-schema.ts            # entirely offline validation
 */
import { createRequire } from "node:module";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { HojaClient } from "../../.pi/lib/claw/hoja.ts";
import { OPERATION_DOCUMENTS } from "../../.pi/lib/tools/hoja-operations.ts";
const require = createRequire(import.meta.url);
const { getIntrospectionQuery, buildClientSchema, parse, validate, getVariableValues } = require(resolve("artifacts/hoja-schema-validator/node_modules/graphql"));
const file = resolve("artifacts/hoja-schema-introspection.json");
const hash = (v: string) => createHash("sha256").update(v).digest("hex");
if (process.argv.includes("--capture")) {
	const token = process.env.LINEAR_TOKEN || process.env.HOJA_API_KEY || readFileSync(join(homedir(), ".config/hoja/api-key"), "utf8").trim();
	const endpoint = "https://hoja.clover4.app/graphql";
	const query = getIntrospectionQuery();
	assert.ok(!query.includes("mutation "));
	const data = await new HojaClient({ token, url: endpoint }).gql(query);
	mkdirSync(resolve("artifacts"), { recursive: true });
	writeFileSync(file, JSON.stringify({ endpoint, capturedAt: new Date().toISOString(), querySha256: hash(query), dataSha256: hash(JSON.stringify(data)), data }, null, 2) + "\n");
	console.log("Captured read-only introspection; no mutation transmitted");
}
const snapshot = JSON.parse(readFileSync(file, "utf8"));
assert.equal(hash(JSON.stringify(snapshot.data)), snapshot.dataSha256);
const schema = buildClientSchema(snapshot.data);
console.log(JSON.stringify({ endpoint: snapshot.endpoint, capturedAt: snapshot.capturedAt, dataSha256: snapshot.dataSha256 }));
for (const [name, document] of Object.entries(OPERATION_DOCUMENTS)) {
	const errors = validate(schema, parse(document));
	assert.deepEqual(errors.map((e: any) => e.message), [], name);
	console.log(`PASS offline document ${name}`);
}
const negatives = {
	unknownField: OPERATION_DOCUMENTS.hoja_issue.replace("identifier", "notARealField"),
	wrongVariableType: OPERATION_DOCUMENTS.hoja_issue.replace("$id:String!", "$id:Int!"),
	wrongNullability: OPERATION_DOCUMENTS.hoja_issue.replace("$id:String!", "$id:String"),
	missingRequiredArgument: OPERATION_DOCUMENTS.hoja_comment_create.replace("(input:$input)", ""),
	legacyCommentSignature: "mutation($issueId:String!,$body:String!) { commentCreate(issueId:$issueId,body:$body) { success } }",
	wrongInputType: OPERATION_DOCUMENTS.hoja_issue_create.replace("IssueCreateInput!", "IssueFilter!"),
	wrongResponseField: OPERATION_DOCUMENTS.hoja_issue_delete.replace("success", "notASuccessField"),
};
for (const [name, doc] of Object.entries(negatives)) {
	assert.ok(validate(schema, parse(doc)).length > 0, name);
	console.log(`PASS negative schema control ${name}`);
}
const samples: Record<string, any> = {
	hoja_issues: { first: 2, filter: { team: { id: { eq: "t" } }, project: { id: { eq: "p" } }, assignee: { id: { eq: "a" } }, state: { type: { nin: ["completed", "canceled"] } } } },
	hoja_issue_create: { input: { title: "fixture", teamId: "t", projectId: "p", description: "fixture", priority: 0, assigneeId: "a", dueDate: "2024-02-29T12:00:00Z" } },
	hoja_issue_update: { id: "i", input: { title: "fixture", description: "", priority: 4, stateId: "s", assigneeId: "a", dueDate: "2024-02-29" } },
	hoja_comment_create: { input: { issueId: "i", body: "fixture" } }, hoja_issue_delete: { id: "i" },
};
for (const [name, variables] of Object.entries(samples)) {
	const definitions = parse(OPERATION_DOCUMENTS[name]).definitions[0].variableDefinitions;
	assert.equal(getVariableValues(schema, definitions, variables).errors, undefined, name);
	console.log(`PASS schema input fields ${name}`);
}
const defs = parse(OPERATION_DOCUMENTS.hoja_issue_create).definitions[0].variableDefinitions;
for (const input of [{ title: "x" }, { title: "x", teamId: "t", unknownInput: true }, { title: "x", teamId: "t", priority: "wrong" }]) {
	assert.ok(getVariableValues(schema, defs, { input }).errors?.length, "invalid input must fail");
}
console.log("PASS input negative controls; schema compatibility is NOT permission or custom-scalar runtime validation");
