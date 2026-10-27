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
	{
		id: "keep-open-closed-on-terminal",
		why: "the default close ignores the request to keep the tab, which is the whole feature",
		file: ".pi/lib/claw/supervisor.ts",
		find: "\t// S7: the human asked for this tab. Closing it is a decision, not a fault to supervise.\n\tif (run.keepOpen) return;\n",
		replace: "",
		test: "a kept run's tab is never closed across ticks and a daemon restart",
		spec: ".pi/test/claw/keep-open-resume.test.ts",
	},
	{
		id: "keep-open-holds-daemon",
		why: "a kept tab counted as supervision work keeps the daemon alive forever",
		file: ".pi/lib/claw/supervisor.ts",
		find: "\t\tif (!run.keepOpen && run.block !== undefined && !run.tabClosedAt && (CLOSE_ON_END.includes(run.status) || run.status === \"lost\")) return redeemable(run, \"tab-close\");",
		replace: "\t\tif (run.block !== undefined && !run.tabClosedAt && (CLOSE_ON_END.includes(run.status) || run.status === \"lost\")) return redeemable(run, \"tab-close\");",
		test: "a kept run's tab is never closed across ticks and a daemon restart",
		spec: ".pi/test/claw/keep-open-resume.test.ts",
	},
	{
		id: "keep-release-keeps-spent-budget",
		why: "releasing a keep leaves an exhausted close budget, so the tab never closes and nothing says why",
		file: ".pi/lib/claw/daemon.ts",
		find: "\t\t\tif (!req.keep && run.remedies?.[\"tab-close\"]) delete run.remedies[\"tab-close\"];\n",
		replace: "",
		test: "releasing a kept run clears a spent close budget",
		spec: ".pi/test/claw/keep-open-resume.test.ts",
	},
	{
		id: "resume-drops-session-file",
		why: "the original defect of a naive relaunch: a new session instead of the recorded conversation",
		file: ".pi/lib/claw/launcher.ts",
		find: 'const resume = spec.sessionFile ? ` --session ${shellQuote(spec.sessionFile)}` : "";',
		replace: 'const resume = "";',
		test: "resumes a closed run on its recorded session file",
		spec: ".pi/test/claw/keep-open-resume.test.ts",
	},
	{
		id: "resume-keeps-stale-pid",
		why: "the dead worker's pid survives the relaunch, so the supervisor reads the fresh tab as a corpse",
		file: ".pi/lib/claw/resume.ts",
		find: "\trun.pid = undefined;\n\t// A modal lived in the old process.",
		replace: "\t// A modal lived in the old process.",
		test: "resumes a closed run on its recorded session file",
		spec: ".pi/test/claw/keep-open-resume.test.ts",
	},
	{
		id: "resume-without-goal-rearm",
		why: "a resumed run loses its always-on goal, so the continued work is judged by nothing",
		file: ".pi/lib/claw/resume.ts",
		find: "	const rearmed = rearmGoal(run, run.id, at);\n	if (rearmed) store.writeGoalSpec(rearmed.spec);\n",
		replace: "	const rearmed = undefined;\n",
		test: "a resume restores the persisted goal exactly once",
		spec: ".pi/test/claw/keep-open-resume.test.ts",
	},
	{
		id: "resume-unprovable-gone",
		why: "an unreadable Tern snapshot is read as \"nothing is alive\", so a resume forks a live conversation",
		file: ".pi/lib/claw/resume.ts",
		find: "\tif (ACTIVE_STATUSES.includes(run.status) && !provablyGone(run, facts)) {",
		replace: "\tif (false) {",
		test: "refuses an active run whose worker cannot be proven gone",
		spec: ".pi/test/claw/keep-open-resume.test.ts",
	},
	{
		id: "session-inbox-unfiltered",
		why: "the field defect: every session receives every run",
		file: ".pi/lib/claw/inbox.ts",
		find: "export const forSession = (item: InboxItem, session: string): boolean => item.owner === undefined || item.owner === session;",
		replace: "export const forSession = (_item: InboxItem, _session: string): boolean => true;",
		test: "each session receives only its own runs' completions",
		spec: ".pi/test/claw/multi-orchestrator.test.ts",
	},
	{
		id: "session-unaddressed-dropped",
		why: "unaddressed (daemon-wide, legacy) items stop reaching any session",
		file: ".pi/lib/claw/inbox.ts",
		find: "item.owner === undefined || item.owner === session;",
		replace: "item.owner === session;",
		test: "daemon-wide items and runs from before owners reach every session",
		spec: ".pi/test/claw/multi-orchestrator.test.ts",
	},
	{
		id: "session-inbox-not-addressed",
		why: "inbox items lose the run's owner, so everyone gets them",
		file: ".pi/lib/claw/store.ts",
		find: "const owner = item.owner ?? (item.runId ? this.getRun(item.runId)?.owner : undefined) ?? (item.triggerId ? this.getTrigger(item.triggerId)?.owner : undefined);",
		replace: "const owner = item.owner;",
		test: "each session receives only its own runs' completions",
		spec: ".pi/test/claw/multi-orchestrator.test.ts",
	},
	{
		id: "session-tab-shared-pane",
		why: "the field defect: a run's tab opens in the last /claw on's Tern session",
		file: ".pi/lib/claw/spawn.ts",
		find: "session = await clawSession(tern, run.pane ?? store.readControl().pane);",
		replace: "session = await clawSession(tern, store.readControl().pane);",
		test: "A's worker tab opens in A's Tern session",
		spec: ".pi/test/claw/multi-orchestrator.test.ts",
	},
	{
		id: "session-origin-not-stamped",
		why: "the orchestrator sends requests without its session",
		file: "extensions/claw/extension.ts",
		find: "if (body.kind === \"spawn\") return { ...body, input: { ...body.input, ...origin } };",
		replace: "if (body.kind === \"spawn\") return body;",
		test: "the calling session and its pane are stamped",
		spec: ".pi/test/claw/multi-orchestrator.test.ts",
	},
	{
		id: "session-trigger-owner-dropped",
		why: "a trigger's run is owned by nobody",
		file: ".pi/lib/claw/daemon.ts",
		find: "const owner = t.action.owner ?? t.owner;",
		replace: "const owner = undefined;",
		test: "a trigger added by A fires a run owned by A",
		spec: ".pi/test/claw/multi-orchestrator.test.ts",
	},
	{
		id: "session-digest-merged",
		why: "one digest names every session's runs",
		file: ".pi/lib/claw/supervisor.ts",
		find: "const owner = notice.runId ? store.getRun(notice.runId)?.owner ?? \"\" : \"\";",
		replace: "const owner = \"\";",
		test: "the digest is split per session",
		spec: ".pi/test/claw/multi-orchestrator.test.ts",
	},
	{
		id: "session-new-replays-history",
		why: "a new session replays the whole inbox",
		file: ".pi/lib/claw/store.ts",
		find: ": { offset: this.inboxEnd(), pid };",
		replace: ": { offset: 0, pid };",
		test: "a new session starts at the inbox end",
		spec: ".pi/test/claw/multi-orchestrator.test.ts",
	},
	{
		id: "session-steals-live-legacy",
		why: "a new session takes a live owner's legacy cursor",
		file: ".pi/lib/claw/store.ts",
		find: "&& (legacy.owner === session || legacy.ownerPid === undefined || !alive(legacy.ownerPid));",
		replace: "&& true;",
		test: "a live legacy owner keeps its cursor",
		spec: ".pi/test/claw/multi-orchestrator.test.ts",
	},
	{
		id: "session-restart-waits",
		why: "a restarted process waits 30 s before resending its own batch",
		file: ".pi/lib/claw/inbox.ts",
		find: "(inflight.pid === undefined || inflight.pid === pid) && ",
		replace: "",
		test: "a restarted process of the same session resends",
		spec: ".pi/test/claw/multi-orchestrator.test.ts",
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
