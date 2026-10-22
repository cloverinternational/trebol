#!/usr/bin/env node
/**
 * Mutation checks for the always-on Claw completion goal (TREBOL-325).
 *
 * Each case removes or inverts exactly one guard, runs the single test that is supposed to pin it, and requires that
 * test to FAIL. A guard whose removal leaves its test green is not load-bearing, so this script fails too. Every case
 * also runs a control first: the untouched source must leave the selected test green, so a pattern that matches
 * nothing can never be mistaken for a broken test.
 *
 * Sources are restored after every case and verified byte-for-byte at the end. Nothing is committed:
 *
 *   node tools/verify/claw-goal-mutations.mjs
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const CLAW_GOAL_TEST = ".pi/test/claw/goal.test.ts";
const SWARM_GOAL_TEST = ".pi/test/tools/swarm-goal.test.ts";
const VITEST = "node_modules/.bin/vitest";

/** name, source file, exact fragment, its mutant, and the test that must break. */
const CASES = [
  {
    name: "derived acceptance criteria",
    file: ".pi/lib/claw/goal.ts",
    from: "\t\tif (bullet) push(bullet[1]);",
    to: "\t\tif (bullet) { /* mutation: stated criteria dropped */ }",
    test: "derives the objective and the acceptance criteria the task states, deterministically",
  },
  {
    name: "goal spec written for the worker",
    file: ".pi/lib/claw/spawn.ts",
    from: "\tif (spec) store.writeGoalSpec(spec);",
    to: "\t/* mutation: no goal spec written */",
    test: "every worker run records a derived goal, its spec, and it in the task file",
  },
  {
    name: "goal stated in the task file",
    file: ".pi/lib/claw/spawn.ts",
    from: '\tconst goal = run.goal && run.goal.status !== "unavailable" ? `',
    to: "\tconst goal = false ? `",
    test: "every worker run records a derived goal, its spec, and it in the task file",
  },
  {
    name: "establishment after launch",
    file: "extensions/claw/extension.ts",
    from: "\t\ttry { establishGoal(host, { condition: goalSpec.condition, source: goalSpec.source }); }",
    to: "\t\ttry { /* mutation: goal never established */ }",
    test: "establishes the derived condition after launch, through the worker's own process",
  },
  {
    name: "host resolved by session, not by module state",
    file: "extensions/claw/extension.ts",
    from: "\t\tif (!host && sessionStarted) host = goalHostForSession(ctx);",
    to: "\t\tif (!host && sessionStarted) host = undefined;",
    test: "establishes the derived condition after launch, through the worker's own process",
  },
  {
    name: "the loop continues on NOT_MET",
    file: ".pi/lib/tools/swarm-goal.ts",
    from: "      return { continue: true, entries: [...(_event.entries ?? []), { type: \"custom_message\", customType: \"swarm-goal\", content: `Goal check: NOT_MET. Continue working toward: ${current.condition}\\nOther schedules: ${JSON.stringify([...schedules.values()].map(describe))}`, display: true }] };",
    to: "      return; /* mutation: NOT_MET no longer continues */",
    test: "repeats while the judge answers NOT_MET and stops on MET",
  },
  {
    name: "claw_finish clears the goal before reporting",
    file: "extensions/claw/extension.ts",
    from: '\t\t\tclearGoal(host, finish.outcome === "needs_user" ? "needs_user" : "finish");\n\t\t\trecordFinish(store, identity.runId, finish);',
    to: '\t\t\trecordFinish(store, identity.runId, finish);\n\t\t\tclearGoal(host, finish.outcome === "needs_user" ? "needs_user" : "finish");',
    test: "claw_finish clears the goal BEFORE reporting",
  },
  {
    name: "claw_finish clears the goal at all",
    file: "extensions/claw/extension.ts",
    from: '\t\t\tclearGoal(host, finish.outcome === "needs_user" ? "needs_user" : "finish");',
    to: "\t\t\t/* mutation: goal left running */",
    test: "claw_finish clears the goal BEFORE reporting",
  },
  {
    name: "a worker question stops the loop",
    file: "extensions/claw/extension.ts",
    from: '\t\tclearGoal(host, "awaiting_decision");',
    to: "\t\t/* mutation: loop keeps judging while a human decides */",
    test: "a worker question ends the loop once",
  },
  {
    name: "a report ends the goal (daemon side)",
    file: ".pi/lib/claw/daemon.ts",
    from: '\tendRunGoal(run, store, ev.outcome === "needs_user" ? "needs_user" : "finish", ev.at);',
    to: "\t/* mutation: report does not end the goal */",
    test: "needs_user, cancellation and terminal states end the goal exactly once",
  },
  {
    name: "cancellation ends the goal",
    file: ".pi/lib/claw/daemon.ts",
    from: '\t\t\tendRunGoal(run, store, "cancel", deps.now().toISOString());',
    to: "\t\t\t/* mutation: cancel leaves the goal active */",
    test: "needs_user, cancellation and terminal states end the goal exactly once",
  },
  {
    name: "ending a goal is idempotent",
    file: ".pi/lib/claw/goal.ts",
    from: "\tif (!goal || !ACTIVE_GOAL.includes(goal.status)) return false;",
    to: "\tif (!goal) return false;",
    test: "needs_user, cancellation and terminal states end the goal exactly once",
  },
  {
    name: "a late establishment cannot revive an ended goal",
    file: ".pi/lib/claw/goal.ts",
    from: "\t\tif (current && ENDED_GOAL.includes(current.status)) return false;",
    to: "\t\tif (false) return false;",
    test: "a worker that reported before its goal was established",
  },
  {
    name: "a resumed worker keeps the original establishment time",
    file: ".pi/lib/claw/goal.ts",
    from: "\t\tgoal.establishedAt ??= at;",
    to: "\t\tgoal.establishedAt = at;",
    test: "a daemon restart mid-goal resumes the persisted goal",
  },
  {
    name: "an ended source is never re-established",
    file: ".pi/lib/tools/swarm-goal.ts",
    from: '    if (source && source === endedSource) return { created: false, state: snapshot() ?? { condition, status: "cleared", source, turns: 0, judgeCalls: 0 } };',
    to: "    /* mutation: ended goal can be re-armed */",
    test: "a host establishes a goal once, widens it, and never resurrects one",
    testFile: SWARM_GOAL_TEST,
  },
  {
    name: "the host is published for the session",
    file: ".pi/lib/tools/swarm-goal.ts",
    from: "    hostTable().set(goalSessionKey(ctx), { host, pi });",
    to: "    /* mutation: no cross-extension host */",
    test: "another extension finds the host by session, never by module state",
    testFile: SWARM_GOAL_TEST,
  },
  {
    name: "one long-run warning",
    file: ".pi/lib/claw/daemon.ts",
    from: '\tif (!goal || goal.status !== "active" || goal.warningAt) return false;',
    to: '\tif (!goal || goal.status !== "active") return false;',
    test: "a long-running goal raises ONE warning and keeps looping",
  },
  {
    name: "the warning itself fires",
    file: ".pi/lib/claw/daemon.ts",
    from: "\tif (!Number.isFinite(since) || nowMs - since < GOAL_LONG_MS) return false;",
    to: "\treturn false;",
    test: "a long-running goal raises ONE warning and keeps looping",
  },
  {
    name: "the warning never stops the run",
    file: ".pi/lib/claw/daemon.ts",
    from: "\tif (isActive(run)) warnLongGoal(run, store, deps.now().getTime());",
    to: '\tif (isActive(run) && warnLongGoal(run, store, deps.now().getTime())) run.status = "failed";',
    test: "a long-running goal raises ONE warning and keeps looping",
  },
  {
    name: "status exposes elapsed time",
    file: ".pi/lib/claw/goal.ts",
    from: "\t\telapsedSeconds: Number.isFinite(startedAt) ? Math.max(0, Math.round((endedAt - startedAt) / 1000)) : 0,",
    to: "\t\telapsedSeconds: 0,",
    test: "status exposes condition, turns used, judge calls, last verdict and elapsed time",
  },
];

const originals = new Map();
const readSource = (file) => {
  if (!originals.has(file)) originals.set(file, readFileSync(file, "utf8"));
  return originals.get(file);
};
const restore = () => { for (const [file, text] of originals) writeFileSync(file, text); };
const pattern = (name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const run = (args) => {
  try { return { ok: true, output: execFileSync(VITEST, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) }; }
  catch (error) { return { ok: false, output: `${error.stdout ?? ""}${error.stderr ?? ""}` }; }
};

let failures = 0;
try {
  for (const testCase of CASES) {
    const testFile = testCase.testFile ?? CLAW_GOAL_TEST;
    const original = readSource(testCase.file);
    const occurrences = original.split(testCase.from).length - 1;
    if (occurrences !== 1) {
      console.log(`✗ ${testCase.name}: mutation target found ${occurrences} times, expected exactly 1`);
      failures++;
      continue;
    }
    // Control: the selected test must pass untouched.
    writeFileSync(testCase.file, original);
    const control = run(["run", testFile, "-t", pattern(testCase.test)]);
    if (!control.ok || !/\bpassed\b/.test(control.output)) {
      console.log(`✗ ${testCase.name}: control run did not select a passing test`);
      failures++;
      continue;
    }
    writeFileSync(testCase.file, original.replace(testCase.from, testCase.to));
    const result = run(["run", testFile, "-t", pattern(testCase.test)]);
    restore();
    if (result.ok) {
      console.log(`✗ ${testCase.name}: "${testCase.test}" still passed — the guard is not load-bearing`);
      failures++;
    } else {
      console.log(`✓ ${testCase.name}: "${testCase.test}" fails under mutation`);
    }
  }
} finally {
  restore();
}

for (const [file, text] of originals) {
  if (readFileSync(file, "utf8") !== text) { console.log(`✗ ${file} not restored`); process.exit(1); }
}
console.log(failures === 0 ? `\nAll ${CASES.length} mutation checks behaved as expected.` : `\n${failures} mutation check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
