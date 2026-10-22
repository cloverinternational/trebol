#!/usr/bin/env node
/**
 * Mutation checks for the task-gate auto-continue.
 *
 * Each case removes or inverts exactly one guard in
 * `.pi/lib/runtime/task-gate-resume.ts`, runs the single test that is supposed
 * to pin that guard, and requires the test to FAIL. A guard whose removal
 * leaves its test green is not load-bearing, so this script fails too.
 *
 * The source file is restored from the backup in `finally` for every case, and
 * the script aborts if the file differs afterwards. Nothing is committed; run
 * from the repository root:
 *
 *   node tools/verify/task-gate-resume-mutations.mjs
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SOURCE = ".pi/lib/runtime/task-gate-resume.ts";
const TEST = ".pi/test/runtime/task-gate-resume.test.ts";
const VITEST = "node_modules/.bin/vitest";

/** name, exact source fragment, its mutant, and the test name that must break. */
const CASES = [
  {
    name: "outcome guard",
    from: 'if (input.outcome !== undefined && input.outcome !== "completed") return { gate: false, reason: `outcome:${input.outcome}` };',
    to: "/* mutation: outcome guard removed */",
    test: "user interrupt (aborted outcome)",
  },
  {
    name: "already-continuing guard",
    from: 'if (input.alreadyContinuing) return { gate: false, reason: "already-continuing" };',
    to: "/* mutation: already-continuing guard removed */",
    test: "turn already continuing",
  },
  {
    name: "pending-input guard",
    from: 'if (input.hasPendingMessages) return { gate: false, reason: "pending-input" };',
    to: "/* mutation: pending-input guard removed */",
    test: "queued user input",
  },
  {
    name: "stop-reason guard",
    from: 'if (stopReason !== "stop") return { gate: false, reason: `stop-reason:${String(stopReason)}` };',
    to: "/* mutation: stop-reason guard removed */",
    test: "a non-stop assistant ending (toolUse / aborted / length) is not resumed",
  },
  {
    name: "completed-report guard",
    from: 'if (hasCompletedReport(tail)) return { gate: false, reason: "completed-report" };',
    to: "/* mutation: completed-report guard removed */",
    test: "explicit completion (successful claw_finish) is never resumed",
  },
  {
    name: "last-tool-is-gate guard",
    from: 'if (!isTaskEnforcementBlockText(messageText(result?.content))) return { gate: false, reason: "last-tool-not-gate" };',
    to: "/* mutation: last-tool-is-gate guard removed */",
    test: "a turn that last touched a non-gate tool is not resumed",
  },
  {
    name: "gate message matchers",
    from: 'return text.includes(BLOCKED_BY_HOOK_PREFIX)\n    && text.includes(TASK_GATE_BLOCK_MARKER)\n    && text.includes(TASK_GATE_BLOCK_HEADLINE);',
    to: "return true;",
    test: "does not treat another hook's block as the task gate",
  },
  {
    name: "further-tool-call guard",
    from: 'if (furtherToolCall) return { gate: false, reason: "further-tool-call" };',
    to: "/* mutation: further-tool-call guard removed */",
    test: "a tool call issued after the block is not resumed",
  },
  {
    name: "focused-task short circuit",
    from: 'if (input.taskFocused) { budget.reset(input.session); return { action: "none", reason: "task-focused" }; }',
    to: "/* mutation: focused-task short circuit removed */",
    test: "a turn that ends with a focused task is not resumed and resets the budget",
  },
  {
    name: "budget cap",
    from: 'if (state.used >= this.limit) return "exhausted";',
    to: '/* mutation: cap removed */',
    test: "continues at most 2 times, then surfaces the spent budget once",
  },
  {
    name: "dedupe key",
    from: 'if (state.lastKey === key) return "duplicate";',
    to: "/* mutation: dedupe removed */",
    test: "injects one continue for a blocked-tool-then-stop turn",
  },
  {
    name: "continuation does not cut the run short",
    from: "    if (isTaskGateContinuationMessage(message)) continue;",
    to: "    /* mutation: own continuations treated as user turns */",
    test: "a stop that follows an injected continue is a new stop: second continue, then the spent notice",
  },
  {
    name: "one key per stop, not per call",
    from: "key: `${toolCallId || `${toolName}:${resultIndex}`}@${messages.length}`",
    to: "key: toolCallId || `${toolName}:${resultIndex}`",
    test: "a stop that follows an injected continue is a new stop: second continue, then the spent notice",
  },
  {
    name: "real-progress reset",
    from: 'if (input.taskFocused) { budget.reset(input.session); return { action: "none", reason: "task-focused" }; }',
    to: 'if (input.taskFocused) return { action: "none", reason: "task-focused" };',
    test: "real progress (a focused task) resets the budget for a later block",
  },
  {
    name: "process-wide budget map",
    from: 'const sharedBudgets = (): Map<string, GateResumeBudgetState> => ((globalThis as any)[BUDGETS] ??= new Map<string, GateResumeBudgetState>());',
    to: "const sharedBudgets = (): Map<string, GateResumeBudgetState> => new Map<string, GateResumeBudgetState>();",
    test: "keeps the budget on globalThis so a reload cannot refill it",
  },
  {
    name: "injected remedy text",
    from: '`Claw workers: claw_finish is allowed once any task is completed.`,',
    to: '`Report the blocker instead of continuing.`,',
    test: "injects the remedy the gate actually accepts",
  },
  {
    name: "gate still blocks (no exemption added)",
    from: "if (hasFocusedTask(tasks)) { this.counter = 0; return CONTINUE; }",
    to: "if (hasFocusedTask(tasks)) { this.counter = 0; return CONTINUE; }",
    test: "leaves the gate itself untouched: the blocked call is still blocked",
    untouched: true,
  },
  {
    name: "wiring returns continue",
    file: ".pi/lib/runtime/swarm-builtin-hooks-runtime.ts",
    from: 'return decision.action === "continue" ? { continue: true, entries } : { entries };',
    to: "return { entries };",
    test: "returns continue:true with one hidden instruction entry for a gate stop",
  },
  {
    name: "wiring honours the taskmanage group switch",
    file: ".pi/lib/runtime/swarm-builtin-hooks-runtime.ts",
    from: 'if (!isHookEnabled("taskmanage")) return undefined;',
    to: "/* mutation: group switch removed */",
    test: "does not continue when the taskmanage hook group is off",
  },
  {
    name: "wiring passes the real outcome",
    file: ".pi/lib/runtime/swarm-builtin-hooks-runtime.ts",
    from: "      outcome: event?.outcome,",
    to: '      outcome: "completed",',
    test: "does not continue for an aborted run through the registered handler",
  },
];

const sources = new Map();
const readSource = (file) => {
  if (!sources.has(file)) sources.set(file, readFileSync(file, "utf8"));
  return sources.get(file);
};
const restore = () => { for (const [file, text] of sources) writeFileSync(file, text); };
const backup = join(tmpdir(), `task-gate-resume.${process.pid}.bak`);
copyFileSync(SOURCE, backup);

const run = (args) => {
  try {
    return { ok: true, output: execFileSync(VITEST, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
  } catch (error) {
    return { ok: false, output: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
};

/** `-t` is a regex; escape the test name so parentheses and `:` match literally. */
const pattern = (name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

let failures = 0;
try {
  for (const testCase of CASES) {
    const file = testCase.file ?? SOURCE;
    const original = readSource(file);
    if (testCase.untouched) {
      writeFileSync(file, original);
    } else {
      const occurrences = original.split(testCase.from).length - 1;
      if (occurrences !== 1) {
        console.log(`✗ ${testCase.name}: mutation target found ${occurrences} times, expected exactly 1`);
        failures++;
        continue;
      }
      // Control: the selected test must pass before the mutation, so a pattern
      // that matches nothing can never be mistaken for a broken test.
      writeFileSync(file, original);
      const control = run(["run", TEST, "-t", pattern(testCase.test)]);
      if (!control.ok || !/\bpassed\b/.test(control.output)) {
        console.log(`✗ ${testCase.name}: control run did not select a passing test`);
        failures++;
        continue;
      }
      writeFileSync(file, original.replace(testCase.from, testCase.to));
    }
    const result = run(["run", TEST, "-t", pattern(testCase.test)]);
    if (testCase.untouched) {
      // Control: the unmutated guard must keep this test green.
      if (result.ok) console.log(`✓ ${testCase.name}: control stays green`);
      else { console.log(`✗ ${testCase.name}: control unexpectedly red`); failures++; }
    } else if (result.ok) {
      console.log(`✗ ${testCase.name}: "${testCase.test}" still passed — guard is not load-bearing`);
      failures++;
    } else {
      const mentioned = result.output.includes("FAIL");
      console.log(`${mentioned ? "✓" : "✗"} ${testCase.name}: "${testCase.test}" fails under mutation`);
      if (!mentioned) failures++;
    }
  }
} finally {
  restore();
  unlinkSync(backup);
}

for (const [file, text] of sources) {
  if (readFileSync(file, "utf8") !== text) { console.log(`✗ ${file} not restored`); process.exit(1); }
}
console.log(failures === 0 ? `\nAll ${CASES.length} mutation checks behaved as expected.` : `\n${failures} mutation check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
