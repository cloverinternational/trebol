import { describe, expect, it, vi } from "vitest";
import {
  SwarmHookPipeline, blockedByHookText, createSwarmBuiltinPipeline, type HookTask,
} from "../../lib/runtime/swarm-builtin-hooks.ts";
import { sleepBlockReason } from "../../lib/policy/swarm-sleep-blocker.ts";
import {
  BLOCKED_BY_HOOK_PREFIX, TASK_GATE_BLOCK_MARKER, TASK_GATE_CONTINUE_LIMIT, TASK_GATE_SPENT_TYPE,
  TASK_GATE_CONTINUE_TYPE, TaskGateResumeBudget, classifyTaskGateStop, evaluateTaskGateResume, isTaskEnforcementBlockText,
} from "../../lib/runtime/task-gate-resume.ts";
import { registerSwarmBuiltinHooks } from "../../lib/runtime/swarm-builtin-hooks-runtime.ts";
import { toggleHook } from "../../lib/runtime/hook-state.ts";

/**
 * Fixtures are produced by the real gate, never typed by hand: the blocked tool
 * result is whatever `SwarmHookPipeline.preTool` answers in that enforcement
 * mode, wrapped the way the Pi adapter wraps it
 * (`Tool 'x' blocked by hook: …`), and the transcript is the message sequence Pi
 * records for it.
 */
const NO_FOCUS: HookTask[] = [{ id: "1", subject: "earlier work", status: "completed", complete: true } as HookTask];
const event = (toolName: string, params: any = {}) => ({ toolName, params, toolCallId: `call-${toolName}` });

/** The exact tool-result content the host produces for a blocked call. */
function blockedResult(mode: "advise" | "block", toolName = "Bash", params: any = { command: "git commit -am wip" }) {
  const tasks: HookTask[] = [{ id: "1", subject: "earlier work", status: "completed" }];
  const p = createSwarmBuiltinPipeline({ session: `fixture-${mode}-${toolName}`, tasks: () => tasks, enforcementMode: mode, completion: { enabled: false } });
  const out = p.preTool(event(toolName, params));
  return out.block ?? out.context;
}

const assistantToolUse = (toolName: string, toolCallId: string) => ({
  role: "assistant", stopReason: "toolUse",
  content: [{ type: "toolCall", id: toolCallId, name: toolName, arguments: {} }],
});
const assistantStop = (text = "The call was blocked by the same hook I was fixing; I'll report needs_user.") => ({
  role: "assistant", stopReason: "stop", content: [{ type: "text", text }],
});
const userTurn = (text = "do the work") => ({ role: "user", content: [{ type: "text", text }] });
const gateTurn = (mode: "advise" | "block" = "block", toolName = "Bash") => {
  const text = blockedResult(mode, toolName);
  return {
    text,
    messages: [
      userTurn(),
      assistantToolUse(toolName, `call-${toolName}`),
      { role: "toolResult", toolName, toolCallId: `call-${toolName}`, content: [{ type: "text", text }], isError: true },
      assistantStop(),
    ],
  };
};
const freshBudget = () => new TaskGateResumeBudget(TASK_GATE_CONTINUE_LIMIT, new Map());

describe("task-gate auto-continue: fixture is the gate's own message", () => {
  it("matches the block-mode gate message and rejects the advise-mode nudge", () => {
    const blocked = blockedResult("block");
    expect(blocked).toContain(BLOCKED_BY_HOOK_PREFIX);
    expect(blocked).toContain(TASK_GATE_BLOCK_MARKER);
    expect(isTaskEnforcementBlockText(blocked)).toBe(true);
    // advise mode emits a cadence-limited nudge, not a block: nothing to resume.
    const advised = blockedResult("advise");
    expect(advised).not.toContain(TASK_GATE_BLOCK_MARKER);
    expect(isTaskEnforcementBlockText(advised)).toBe(false);
  });

  it("does not treat another hook's block as the task gate", () => {
    const sleep = sleepBlockReason("sleep 5");
    expect(sleep).toBeTruthy();
    const text = blockedByHookText("Bash", sleep!);
    expect(text).toContain(BLOCKED_BY_HOOK_PREFIX);
    expect(isTaskEnforcementBlockText(text)).toBe(false);
  });
});

describe("task-gate auto-continue: gate-caused stop continues exactly once", () => {
  it("injects one continue for a blocked-tool-then-stop turn", () => {
    const { messages } = gateTurn();
    const budget = freshBudget();
    const first = evaluateTaskGateResume({ session: "s", messages, outcome: "completed", taskFocused: false, budget });
    expect(first.action).toBe("continue");
    expect(first.block).toMatchObject({ toolName: "Bash" });
    expect(first.used).toBe(1);
    // Pi may emit the same settle boundary more than once: still exactly one.
    const again = evaluateTaskGateResume({ session: "s", messages, outcome: "completed", taskFocused: false, budget });
    expect(again.action).toBe("none");
    expect(again.reason).toBe("duplicate");
  });

  it("injects the remedy the gate actually accepts", () => {
    const { messages } = gateTurn();
    const decision = evaluateTaskGateResume({ session: "s", messages, outcome: "completed", budget: freshBudget() });
    const text = decision.content ?? "";
    expect(text).toContain("TaskManage");
    expect(text).toContain('op:"create"');
    expect(text).toContain('status:"in_progress"');
    expect(text).toContain("active:true");
    expect(text).toContain("read-only");
    expect(text).toContain("claw_finish is allowed once any task is completed");
    // It must not invite a replay of the blocked call or a needs_user escape.
    expect(text).toContain("Do not replay the blocked call");
    expect(text).toContain("needs_user report");
  });
});

describe("task-gate auto-continue: near-misses never continue", () => {
  const cases: Array<[string, Record<string, any>, string]> = [
    ["user interrupt (aborted outcome)", { outcome: "aborted" }, "outcome:aborted"],
    ["cancelled run / failed run (error outcome)", { outcome: "error" }, "outcome:error"],
    ["turn already continuing", { alreadyContinuing: true }, "already-continuing"],
    ["queued user input", { hasPendingMessages: true }, "pending-input"],
  ];
  it.each(cases)("%s", (_name, patch, reason) => {
    const { messages } = gateTurn();
    const decision = evaluateTaskGateResume({
      session: `near-${reason}`, messages, outcome: "completed", budget: freshBudget(), ...patch,
    });
    expect(decision.action).toBe("none");
    expect(decision.reason).toBe(reason);
  });

  it("explicit completion (successful claw_finish) is never resumed", () => {
    const { messages } = gateTurn();
    const withReport = [
      ...messages,
      assistantToolUse("claw_finish", "call-finish"),
      { role: "toolResult", toolName: "claw_finish", toolCallId: "call-finish", isError: false, content: [{ type: "text", text: "reported" }] },
      assistantStop("Reported the outcome."),
    ];
    const decision = evaluateTaskGateResume({ session: "s-complete", messages: withReport, outcome: "completed", budget: freshBudget() });
    expect(decision.action).toBe("none");
    expect(decision.reason).toBe("completed-report");
  });

  it("a turn that last touched a non-gate tool is not resumed", () => {
    const { messages } = gateTurn();
    const productive = [
      ...messages,
      assistantToolUse("Bash", "call-read"),
      { role: "toolResult", toolName: "Bash", toolCallId: "call-read", isError: false, content: [{ type: "text", text: "ok" }] },
      assistantStop("Done."),
    ];
    expect(evaluateTaskGateResume({ session: "s-productive", messages: productive, outcome: "completed", budget: freshBudget() }).reason)
      .toBe("last-tool-not-gate");
  });

  it("a non-stop assistant ending (toolUse / aborted / length) is not resumed", () => {
    for (const stopReason of ["toolUse", "aborted", "length", "error"]) {
      const { messages } = gateTurn();
      const last = messages[messages.length - 1] as any;
      const decision = classifyTaskGateStop({ messages: [...messages.slice(0, -1), { ...last, stopReason }], outcome: "completed" });
      expect(decision.gate).toBe(false);
      expect((decision as any).reason).toBe(`stop-reason:${stopReason}`);
    }
  });

  it("a tool call issued after the block is not resumed", () => {
    const { messages, text } = gateTurn();
    const afterBlock = [
      ...messages.slice(0, -1), // drop the closing text-only assistant message
      assistantToolUse("Bash", "call-retry"),
      assistantStop(),
    ];
    const result = {
      role: "toolResult", toolName: "Bash", toolCallId: "call-Bash", isError: true, content: [{ type: "text", text }],
    };
    const decision = classifyTaskGateStop({ messages: [...afterBlock.slice(0, 2), result, ...afterBlock.slice(2)], outcome: "completed" });
    expect(decision.gate).toBe(false);
    expect((decision as any).reason).toBe("further-tool-call");
  });

  it("a turn that ends with a focused task is not resumed and resets the budget", () => {
    const { messages } = gateTurn();
    const decision = evaluateTaskGateResume({ session: "s-focus", messages, outcome: "completed", taskFocused: true, budget: freshBudget() });
    expect(decision.action).toBe("none");
    expect(decision.reason).toBe("task-focused");
  });
});

describe("task-gate auto-continue: bounded budget", () => {
  const blockTurn = (callId: string) => {
    const text = blockedResult("block");
    return [
      userTurn(),
      assistantToolUse("Bash", callId),
      { role: "toolResult", toolName: "Bash", toolCallId: callId, content: [{ type: "text", text }], isError: true },
      assistantStop(),
    ];
  };

  it(`continues at most ${TASK_GATE_CONTINUE_LIMIT} times, then surfaces the spent budget once`, () => {
    const budget = freshBudget();
    const actions: string[] = [];
    for (const id of ["c1", "c2", "c3", "c4"]) {
      actions.push(evaluateTaskGateResume({ session: "cap", messages: blockTurn(id), outcome: "completed", budget }).action);
    }
    expect(actions).toEqual(["continue", "continue", "exhausted", "none"]);
    const budget2 = freshBudget();
    evaluateTaskGateResume({ session: "cap2", messages: blockTurn("c1"), outcome: "completed", budget: budget2 });
    evaluateTaskGateResume({ session: "cap2", messages: blockTurn("c2"), outcome: "completed", budget: budget2 });
    const notice = evaluateTaskGateResume({ session: "cap2", messages: blockTurn("c3"), outcome: "completed", budget: budget2 });
    expect(notice.action).toBe("exhausted");
    expect(notice.customType).toBe(TASK_GATE_SPENT_TYPE);
    const text = notice.content ?? "";
    expect(text).toContain("Bash");
    expect(text).toContain("budget for this session is spent (2 of 2 used)");
    expect(text).toContain("TaskManage");
    // The same blocked call never reports twice.
    expect(evaluateTaskGateResume({ session: "cap2", messages: blockTurn("c3"), outcome: "completed", budget: budget2 }).reason)
      .toBe("exhausted-reported");
  });

  it("real progress (a focused task) resets the budget for a later block", () => {
    const budget = freshBudget();
    expect(evaluateTaskGateResume({ session: "reset", messages: blockTurn("c1"), outcome: "completed", budget }).action).toBe("continue");
    expect(evaluateTaskGateResume({ session: "reset", messages: blockTurn("c2"), outcome: "completed", budget }).action).toBe("continue");
    // A task got focused: the block's precondition is gone, so the episode ends.
    expect(evaluateTaskGateResume({ session: "reset", messages: blockTurn("c3"), outcome: "completed", taskFocused: true, budget }).action).toBe("none");
    expect(evaluateTaskGateResume({ session: "reset", messages: blockTurn("c4"), outcome: "completed", budget }).action).toBe("continue");
  });

  it("a stop that follows an injected continue is a new stop: second continue, then the spent notice", () => {
    const budget = freshBudget();
    const base = blockTurn("c1");
    const first = evaluateTaskGateResume({ session: "same-block", messages: base, outcome: "completed", budget });
    expect(first.action).toBe("continue");
    // The continuation lands in the transcript as user-role context and the
    // agent answers with another text-only stop, without trying anything else.
    const afterFirst = [...base, { role: "user", content: [{ type: "text", text: first.content! }] }, assistantStop("Stopping here.")];
    const second = evaluateTaskGateResume({ session: "same-block", messages: afterFirst, outcome: "completed", budget });
    expect(second.action).toBe("continue");
    expect(second.used).toBe(2);
    const afterSecond = [...afterFirst, { role: "user", content: [{ type: "text", text: second.content! }] }, assistantStop("Stopping here.")];
    const third = evaluateTaskGateResume({ session: "same-block", messages: afterSecond, outcome: "completed", budget });
    expect(third.action).toBe("exhausted");
    expect(third.content).toContain("BUDGET SPENT");
    // And it stays settled: no further notice, no further continue.
    const fourth = evaluateTaskGateResume({ session: "same-block", messages: [...afterSecond, assistantStop("Still here.")], outcome: "completed", budget });
    expect(fourth.action).toBe("none");
  });

  it("keeps the budget on globalThis so a reload cannot refill it", () => {
    const session = "reload-shared";
    const first = new TaskGateResumeBudget();
    expect(first.claim(session, "k1")).toBe("continue");
    expect(first.claim(session, "k2")).toBe("continue");
    const afterReload = new TaskGateResumeBudget();
    expect(afterReload.snapshot(session).used).toBe(2);
    expect(afterReload.claim(session, "k3")).toBe("exhausted");
    afterReload.reset(session);
  });
});

describe("task-gate auto-continue: hook pipeline contract", () => {
  it("leaves the gate itself untouched: the blocked call is still blocked", () => {
    const p = new SwarmHookPipeline({
      session: "gate-intact",
      tasks: () => NO_FOCUS,
      preHooks: [{ name: "task-enforcement-hook", run: () => ({ block: true, message: blockedResult("block") }) }],
      postHooks: [],
    });
    expect(p.preTool(event("Bash")).block).toContain("YOU CANNOT EXECUTE ANY TOOL WITHOUT A TASK");
  });
});

/**
 * Wiring: the decision is useless unless the registered runtime handler really
 * returns Pi's boundary shape (`continue: true` + a custom-message draft) and
 * honours the group switch.
 */
describe("task-gate auto-continue: runtime wiring", () => {
  const TASK_MANAGER = Symbol.for("pi-swarm-task-manager");
  const harness = (tasks: HookTask[] = []) => {
    const handlers = new Map<string, Function[]>();
    const pi = {
      on: (name: string, handler: Function) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
      appendEntry: vi.fn(), sendMessage: vi.fn(), registerTool: vi.fn(), registerCommand: vi.fn(), registerShortcut: vi.fn(),
    };
    (globalThis as any)[TASK_MANAGER] = { snapshot: () => ({ tasks }) };
    registerSwarmBuiltinHooks(pi);
    const ctx = { sessionManager: { getSessionId: () => `wiring-${Math.random()}` }, hasPendingMessages: () => false, hasUI: true, ui: {} };
    const emit = async (name: string, event: any = {}) => {
      let result: any;
      for (const handler of handlers.get(name) ?? []) {
        const value = await handler(event, ctx);
        if (value !== undefined) result = value;
      }
      return result;
    };
    return { emit, ctx, pi };
  };

  it("returns continue:true with one hidden instruction entry for a gate stop", async () => {
    const { emit } = harness();
    await emit("session_start");
    const { messages } = gateTurn();
    const result = await emit("agent_before_settle", { type: "agent_before_settle", outcome: "completed", continue: false, entries: [], context: { contextMessages: messages } });
    expect(result?.continue).toBe(true);
    expect(result?.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({ type: "custom_message", customType: TASK_GATE_CONTINUE_TYPE, display: false });
    expect(result.entries[0].content).toContain("TaskManage");
  });

  it("does not continue when the taskmanage hook group is off", async () => {
    toggleHook("taskmanage", false);
    try {
      const { emit } = harness();
      await emit("session_start");
      const result = await emit("agent_before_settle", { type: "agent_before_settle", outcome: "completed", continue: false, entries: [], context: { contextMessages: gateTurn().messages } });
      expect(result).toBeUndefined();
    } finally { toggleHook("taskmanage", true); }
  });

  it("does not continue for an aborted run through the registered handler", async () => {
    const { emit } = harness();
    await emit("session_start");
    const result = await emit("agent_before_settle", { type: "agent_before_settle", outcome: "aborted", continue: false, entries: [], context: { contextMessages: gateTurn().messages } });
    expect(result).toBeUndefined();
  });
});
