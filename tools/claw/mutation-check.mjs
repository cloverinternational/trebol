#!/usr/bin/env node
/** Mutation check for the supervisor fixes: for each mutation, break exactly the mechanism the test is about and
 *  confirm the test fails; then restore the file and confirm it passes again. A test that survives its mutation is a
 *  test that would not have caught the bug.
 *
 *  Usage: node tools/claw/mutation-check.mjs [--only <id>]
 *
 *  Mutations are applied in place and always restored (including on error and on SIGINT) because the alternative —
 *  editing a copy — would not exercise the same import graph the suite uses. Run it in a worktree, never in a checkout
 *  you care about; it refuses to run when the working tree has uncommitted changes to the files it mutates. */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : undefined;

const mutations = [
	{
		id: "tab-close-gated-on-snapshot",
		why: "the original defect: a failed Tern snapshot skips the close",
		file: ".pi/lib/claw/supervisor.ts",
		find: "if (run.block !== undefined && !run.tabClosedAt && (CLOSE_ON_END.includes(run.status) || run.status === \"lost\")) {\n\t\tawait superviseTabClose(run, deps, live, nowMs, slo);",
		replace: "if (run.block !== undefined && !run.tabClosedAt && live !== undefined && (CLOSE_ON_END.includes(run.status) || run.status === \"lost\")) {\n\t\tawait superviseTabClose(run, deps, live, nowMs, slo);",
		test: "closes a terminal run's tab even when liveBlocks throws",
		spec: ".pi/test/claw/supervisor.test.ts",
	},
	{
		id: "no-budget",
		why: "retries without the remedy ledger: an unbounded loop",
		file: ".pi/lib/claw/supervisor.ts",
		find: "\tconst key = remedyKey(\"tab-close\");\n\tif (!remedyDue(run, key, nowMs)) return;",
		replace: "\tconst key = remedyKey(\"tab-close\");",
		test: "honours the budget exactly and never loops",
		spec: ".pi/test/claw/supervisor.test.ts",
	},
	{
		id: "no-digest",
		why: "every settled turn wakes the session again",
		file: ".pi/lib/claw/daemon.ts",
		find: "store.appendNotice({\n\t\t\tkind: \"run_idle\",",
		replace: "store.appendInbox({\n\t\t\tkind: \"run_idle\",",
		test: "folds started and idle notices into exactly one digest item",
		spec: ".pi/test/claw/supervisor.test.ts",
	},
	{
		id: "no-orphan-report",
		why: "a tab that cannot be closed is silently forgotten",
		file: ".pi/lib/claw/supervisor.ts",
		find: "\t\tdeps.store.appendInbox({\n\t\t\tkind: \"run_tab_orphan\",",
		replace: "\t\tdeps.store.appendNotice({\n\t\t\tkind: \"run_tab_orphan\",",
		test: "retries a failing close within the budget, then reports one orphan",
		spec: ".pi/test/claw/supervisor.test.ts",
	},
	{
		id: "no-settle-relaunch-disabled",
		why: "a worker killed before its first turn is left dead instead of restarted",
		file: ".pi/lib/claw/supervisor.ts",
		find: '	if (run.status === "lost" && run.settles === 0 && run.phase === "tab_open") {',
		replace: '	if (false) {',
		test: "worker killed before any settle: restarted once on the same issue",
		spec: ".pi/test/claw/supervisor.test.ts",
	},
	{
		id: "no-budget-record",
		why: "a spent recovery budget stays silent",
		file: ".pi/lib/claw/supervisor.ts",
		find: '		recordBudgetSpent(deps, run, "relaunch", why);',
		replace: '		void why;',
		test: "stuck past its deadline: not restarted",
		spec: ".pi/test/claw/supervisor.test.ts",
	},
	{
		id: "no-stall-bound",
		why: "an idle run is never ended, so S1 does not bound it",
		file: ".pi/lib/claw/supervisor.ts",
		find: "\tif (idleMs >= slo.idleFailMs) {",
		replace: "\tif (idleMs >= Number.POSITIVE_INFINITY) {",
		test: "fails a worker that stays idle past the bound",
		spec: ".pi/test/claw/supervisor.test.ts",
	},
];

const run = (args) => {
	try {
		execFileSync("npx", args, { cwd: root, stdio: "pipe" });
		return true;
	} catch {
		return false;
	}
};
const vitest = (spec, name) => run(["vitest", "run", spec, "-t", name]);

const results = [];
for (const mutation of mutations) {
	if (only && mutation.id !== only) continue;
	const path = join(root, mutation.file);
	const original = readFileSync(path, "utf8");
	if (!original.includes(mutation.find)) {
		results.push({ id: mutation.id, status: "STALE", detail: "the code the mutation targets is not present" });
		continue;
	}
	const restore = () => writeFileSync(path, original);
	process.on("SIGINT", () => { restore(); process.exit(130); });
	let baseline;
	let mutated;
	try {
		baseline = vitest(mutation.spec, mutation.test);
		writeFileSync(path, original.replace(mutation.find, mutation.replace));
		mutated = vitest(mutation.spec, mutation.test);
	} finally {
		restore();
	}
	const restored = vitest(mutation.spec, mutation.test);
	const killed = baseline && !mutated && restored;
	results.push({ id: mutation.id, why: mutation.why, baselinePassed: baseline, mutatedFailed: !mutated, restoredPassed: restored, status: killed ? "KILLED" : "SURVIVED" });
	process.stderr.write(`${killed ? "KILLED  " : "SURVIVED"} ${mutation.id}: ${mutation.why}\n`);
}

const survived = results.filter((r) => r.status !== "KILLED");
process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
process.stderr.write(`\n${results.length - survived.length}/${results.length} mutations killed\n`);
process.exit(survived.length ? 1 : 0);
