#!/usr/bin/env node
/** Materialize a claw store from the committed 2026-10-22 fixtures, so a measurement is reproducible and does not
 *  depend on the live store (which keeps changing as real runs finish).
 *
 *  Usage: node tools/claw/build-fixture-store.mjs --out <dir>
 *
 *  The fixtures are a bounded, prose-free projection of the real store: run identity, status, phase, timestamps, tab
 *  block, settle count, and each event's type/outcome/evidence count. No prompts, code, tokens or message text. */
import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const out = args[args.indexOf("--out") + 1];
if (!out || !args.includes("--out")) throw new Error("usage: build-fixture-store.mjs --out <dir> [--no-inbox]");
/** --no-inbox starts with an empty inbox: used for the "after" store, whose notices must come from the new code
 *  replaying the same events, not from the items the old code happened to write. */
const withInbox = !args.includes("--no-inbox");

const here = new URL(".", import.meta.url).pathname;
const fixtureDir = join(here, "..", "..", ".pi", "test", "claw", "fixtures");
const runs = JSON.parse(readFileSync(join(fixtureDir, "claw-runs-2026-10-22.json"), "utf8"));
const inbox = JSON.parse(readFileSync(join(fixtureDir, "claw-inbox-2026-10-22.json"), "utf8"));

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "runs"), { recursive: true });
for (const dir of ["triggers", "requests", "responses"]) mkdirSync(join(out, dir), { recursive: true });

for (const fixture of runs) {
	const run = {
		id: fixture.id, label: fixture.identifier ?? fixture.id, task: "(fixture)", cwd: out,
		status: fixture.status, phase: fixture.phase, createdAt: fixture.createdAt, updatedAt: fixture.updatedAt,
		project: "Hoja", eventsOffset: 0, settles: fixture.settles ?? 0, attempts: 0, outbox: [], seen: [],
		...(fixture.block === undefined ? {} : { block: fixture.block }),
		...(fixture.pid === undefined ? {} : { pid: fixture.pid }),
		...(fixture.error ? { error: fixture.error } : {}),
		...(fixture.identifier ? { hoja: { issueId: `iss-${fixture.id.slice(-6)}`, identifier: fixture.identifier, teamKey: "TREBOL", project: "Hoja", assignee: "Luis" } } : {}),
	};
	// The recorded state at the moment of capture: no supervisor fields existed then, which is what "before" means.
	writeFileSync(join(out, "runs", `${fixture.id}.json`), JSON.stringify(run, null, 2));
	writeFileSync(join(out, "runs", `${fixture.id}.events.jsonl`), fixture.events.map((e) => JSON.stringify({ ...e, runId: fixture.id, evidence: [] })).join("\n") + (fixture.events.length ? "\n" : ""));
}
writeFileSync(join(out, "inbox.jsonl"), withInbox ? inbox.map((i) => JSON.stringify({ id: i.key ?? `${i.kind}:${i.runId}:${i.at}`, ...i })).join("\n") + "\n" : "");
writeFileSync(join(out, "control.json"), JSON.stringify({ enabled: true, updatedAt: runs[0].createdAt }));
process.stderr.write(`fixture store: ${runs.length} runs, ${withInbox ? inbox.length : 0} inbox items -> ${out}\n`);
