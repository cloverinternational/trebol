/**
 * Auto-continue for a turn that ended because the task-enforcement gate
 * blocked the agent's tool call.
 *
 * The gate (TaskEnforcementHook.onToolBefore, priority 95) answers a blocked
 * call with `Tool '<name>' blocked by hook: <system-reminder …>[TASK
 * ENFORCEMENT - BLOCKED] YOU CANNOT EXECUTE ANY TOOL WITHOUT A TASK …`. That
 * block is a correction, not a reason to end the run, but a model that treats
 * tool errors as fatal will stop the turn there and leave the session (and a
 * Claw run) idle until a human types "continue".
 *
 * This module decides — from the transcript only, matching the gate's own
 * message rather than guessing — whether the turn that is about to settle was
 * stopped by that gate, and if so whether one bounded auto-continue may be
 * injected. It never weakens the gate: the injected instruction tells the
 * agent to satisfy the gate (create/focus a task) or to stay on a path the
 * gate already exempts.
 *
 * Everything here is pure except the counter map, which lives on globalThis
 * so a /reload cannot refill a spent budget mid-loop.
 */
import { normalizeToolName } from "./swarm-toolclass.ts";

/** Hard bound on auto-continues per episode (one episode = real progress or user input resets it). */
export const TASK_GATE_CONTINUE_LIMIT = 2;
/** Exact strings the gate writes into the blocked tool result. */
export const BLOCKED_BY_HOOK_PREFIX = "blocked by hook:";
export const TASK_GATE_BLOCK_MARKER = "[TASK ENFORCEMENT - BLOCKED]";
export const TASK_GATE_BLOCK_HEADLINE = "YOU CANNOT EXECUTE ANY TOOL WITHOUT A TASK";
/** Custom-message types of the injected context and of the spent-budget notice. */
export const TASK_GATE_CONTINUE_TYPE = "swarm-task-gate-auto-continue";
export const TASK_GATE_SPENT_TYPE = "swarm-task-gate-auto-continue-spent";
/** ASCII sentinel inside every injected continuation, so this module finds its own turns again. */
export const TASK_GATE_CONTINUE_SENTINEL = "TASK GATE — AUTO-CONTINUE";

export interface GateBlockedCall {
  toolName: string;
  toolCallId: string;
  /** One key per stop: re-emitted settles of the same stop share it, a later stop does not. */
  key: string;
}

export type GateResumeVerdict =
  | { gate: true; block: GateBlockedCall }
  | { gate: false; reason: string };

/** Text of a tool-result content block list (Pi stores an array of text/image parts). */
export function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part: any) => part?.type === "text" && typeof part.text === "string")
    .map((part: any) => part.text as string)
    .join("\n");
}

/** True for a message this module injected, whichever role or entry shape Pi gives it. */
export function isTaskGateContinuationMessage(message: unknown): boolean {
  return messageText((message as any)?.content).includes(TASK_GATE_CONTINUE_SENTINEL);
}

/**
 * True when a tool result is the task-enforcement gate's own block message.
 * Requires the host block prefix plus both gate phrases, so the advise-mode
 * nudge ("No active task is focused; consider …"), the skill-budget block and
 * any unrelated `blockedByHookText` result never match.
 */
export function isTaskEnforcementBlockText(text: string): boolean {
  return text.includes(BLOCKED_BY_HOOK_PREFIX)
    && text.includes(TASK_GATE_BLOCK_MARKER)
    && text.includes(TASK_GATE_BLOCK_HEADLINE);
}

/** A Claw worker that already reported its outcome has finished; never resume that turn. */
export function hasCompletedReport(messages: readonly any[]): boolean {
  return messages.some((m: any) =>
    m?.role === "toolResult"
    && normalizeToolName(String(m?.toolName ?? "")) === "clawfinish"
    && m?.isError !== true);
}

/** Index of the last message with this role, or -1. */
const lastIndexOfRole = (messages: readonly any[], role: string): number => {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i]?.role === role) return i;
  return -1;
};

/** Index of the last genuine user turn, skipping this module's own continuations. */
const currentRunStart = (messages: readonly any[]): number => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== "user") continue;
    if (isTaskGateContinuationMessage(message)) continue;
    return i;
  }
  return -1;
};

/**
 * Decide whether the turn that is settling was stopped by the task gate.
 *
 * Only a clean, completed turn counts. Aborted runs (user interrupt, cancelled
 * Claw run), provider errors, queued input, a `toolUse`/`length` stop and a
 * turn whose last tool result is anything other than the gate's block are all
 * near-misses that must fall through to Pi's normal settlement.
 */
export function classifyTaskGateStop(input: {
  messages: readonly any[];
  outcome?: string;
  alreadyContinuing?: boolean;
  hasPendingMessages?: boolean;
}): GateResumeVerdict {
  const { messages } = input;
  if (input.outcome !== undefined && input.outcome !== "completed") return { gate: false, reason: `outcome:${input.outcome}` };
  if (input.alreadyContinuing) return { gate: false, reason: "already-continuing" };
  if (input.hasPendingMessages) return { gate: false, reason: "pending-input" };
  const assistantIndex = lastIndexOfRole(messages, "assistant");
  if (assistantIndex < 0) return { gate: false, reason: "no-assistant-message" };
  const stopReason = messages[assistantIndex]?.stopReason;
  if (stopReason !== "stop") return { gate: false, reason: `stop-reason:${String(stopReason)}` };

  // Everything after the last genuine user turn belongs to this run. Our own
  // continuations arrive as user-role context, so they must not cut the run
  // short: the block they answer is still the cause of this stop.
  const tail = messages.slice(currentRunStart(messages) + 1);
  if (hasCompletedReport(tail)) return { gate: false, reason: "completed-report" };

  const resultIndex = lastIndexOfRole(tail, "toolResult");
  if (resultIndex < 0) return { gate: false, reason: "no-tool-result" };
  const result = tail[resultIndex];
  if (!isTaskEnforcementBlockText(messageText(result?.content))) return { gate: false, reason: "last-tool-not-gate" };

  // No further tool call may follow the blocked one: the assistant stopped on text.
  const after = tail.slice(resultIndex + 1);
  const furtherToolCall = after.some((m: any) =>
    m?.role === "assistant" && Array.isArray(m?.content) && m.content.some((part: any) => part?.type === "toolCall"));
  if (furtherToolCall) return { gate: false, reason: "further-tool-call" };

  const toolName = String(result?.toolName ?? "tool");
  const toolCallId = String(result?.toolCallId ?? "");
  // Pi can emit the settle boundary twice for one stop, and those emissions see
  // the same transcript; a stop after an injected continue sees one extra
  // message and is therefore a new stop the budget must count (and then stop
  // counting).
  return { gate: true, block: { toolName, toolCallId, key: `${toolCallId || `${toolName}:${resultIndex}`}@${messages.length}` } };
}

// ---------------------------------------------------------------------------
// Budget: bounded, idempotent, reset by real progress
// ---------------------------------------------------------------------------
export interface GateResumeBudgetState { used: number; lastKey: string; reported: boolean }
const BUDGETS = Symbol.for("pi-swarm-task-gate-resume-budgets");
const sharedBudgets = (): Map<string, GateResumeBudgetState> => ((globalThis as any)[BUDGETS] ??= new Map<string, GateResumeBudgetState>());

/**
 * Per-session auto-continue accounting.
 *
 * - AT MOST `limit` continuations between two real-progress resets, so a
 *   genuine blocker is surfaced instead of looped over.
 * - `claim` is idempotent per blocked call: Pi can emit `agent_before_settle`
 *   more than once for one stop, and a second injection for the same call
 *   would be a duplicate continue, not a new one.
 * - The spent-budget notice is reported once per blocked call.
 */
export class TaskGateResumeBudget {
  private readonly states: Map<string, GateResumeBudgetState>;
  constructor(readonly limit: number = TASK_GATE_CONTINUE_LIMIT, states?: Map<string, GateResumeBudgetState>) {
    this.states = states ?? sharedBudgets();
  }
  private state(session: string): GateResumeBudgetState {
    const key = session.trim() || "session";
    let state = this.states.get(key);
    if (!state) { state = { used: 0, lastKey: "", reported: false }; this.states.set(key, state); }
    return state;
  }
  snapshot(session: string): GateResumeBudgetState & { limit: number } { return { ...this.state(session), limit: this.limit }; }
  /** Real progress: the block's precondition is gone (a task is focused) or a human intervened. */
  reset(session: string): void { this.states.delete(session.trim() || "session"); }
  claim(session: string, key: string): "continue" | "duplicate" | "exhausted" {
    const state = this.state(session);
    if (state.lastKey === key) return "duplicate";
    if (state.used >= this.limit) return "exhausted";
    state.used += 1;
    state.lastKey = key;
    return "continue";
  }
  /** True the first time this episode runs out of budget, so the notice is appended once, not every stop. */
  markReported(session: string): boolean {
    const state = this.state(session);
    if (state.reported) return false;
    state.reported = true;
    return true;
  }
}

// ---------------------------------------------------------------------------
// Injected text
// ---------------------------------------------------------------------------
export function taskGateContinueContent(block: GateBlockedCall, used: number, limit: number): string {
  return [
    `[TASK GATE — AUTO-CONTINUE ${used}/${limit}] Your turn ended immediately after the task-enforcement hook blocked \`${block.toolName}\`. That block is a correction, not a stop condition. Continue this same run now on one of these authorized paths:`,
    `1. Create a task and focus it: TaskManage {operations:[{op:"create", subject:"<specific work item>", questions:[{id:"q1",text:"<what must be true when done>"}]}]} then TaskManage {operations:[{op:"update", taskId:"<id>", status:"in_progress", active:true}]}.`,
    `2. Or focus the task you already have: TaskManage {operations:[{op:"update", taskId:"<id>", status:"in_progress", active:true}]}.`,
    `3. Or stay on a path the gate already exempts: TaskManage list/get, read-only tools and read-only Bash commands, Skill, plan-mode tools, ask_user_question.`,
    `Claw workers: claw_finish is allowed once any task is completed.`,
    `Do not replay the blocked call before a task is focused, and do not end the turn with a needs_user report unless the task list itself shows a real blocker. Auto-continue ${used} of ${limit} for this session.`,
  ].join("\n");
}

export function taskGateSpentContent(block: GateBlockedCall, limit: number): string {
  return [
    `[TASK GATE — AUTO-CONTINUE BUDGET SPENT] The task-enforcement hook blocked \`${block.toolName}\` (call ${block.toolCallId || "unknown"}) and the turn stopped there again. The auto-continue budget for this session is spent (${limit} of ${limit} used), so no further continue was injected.`,
    `The gate still stands: create a TaskManage task and mark it in_progress with active:true, focus the existing one, or finish on the exempt paths (TaskManage list/get, read-only tools and Bash, Skill, plan mode, ask_user_question). Claw worker: claw_finish is allowed once a task is completed.`,
    `If the task list cannot satisfy the gate, this is a genuine blocker: say which one and stop. Otherwise a human has to send continue.`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Decision entry point
// ---------------------------------------------------------------------------
export interface TaskGateResumeInput {
  session: string;
  messages: readonly any[];
  outcome?: string;
  alreadyContinuing?: boolean;
  hasPendingMessages?: boolean;
  /** True when a task is currently focused; the gate's precondition, i.e. real progress. */
  taskFocused?: boolean;
  budget?: TaskGateResumeBudget;
}

export interface TaskGateResumeDecision {
  action: "none" | "continue" | "exhausted";
  reason: string;
  block?: GateBlockedCall;
  content?: string;
  customType?: string;
  used?: number;
  limit?: number;
}

/**
 * The single decision the runtime calls from `agent_before_settle`.
 * `action: "continue"` means: append a hidden custom message and set continue.
 * `action: "exhausted"` means: append the visible notice and let the turn end.
 */
export function evaluateTaskGateResume(input: TaskGateResumeInput): TaskGateResumeDecision {
  const budget = input.budget ?? new TaskGateResumeBudget();
  if (input.taskFocused) { budget.reset(input.session); return { action: "none", reason: "task-focused" }; }

  const verdict = classifyTaskGateStop(input);
  if ("reason" in verdict) return { action: "none", reason: verdict.reason };
  const block = verdict.block;
  const claim = budget.claim(input.session, block.key);
  if (claim === "duplicate") return { action: "none", reason: "duplicate", block };
  if (claim === "exhausted") {
    if (!budget.markReported(input.session)) return { action: "none", reason: "exhausted-reported", block };
    return {
      action: "exhausted", reason: "budget-spent", block,
      content: taskGateSpentContent(block, budget.limit), customType: TASK_GATE_SPENT_TYPE, used: budget.limit, limit: budget.limit,
    };
  }
  const { used } = budget.snapshot(input.session);
  return {
    action: "continue", reason: "gate-blocked-tool", block,
    content: taskGateContinueContent(block, used, budget.limit), customType: TASK_GATE_CONTINUE_TYPE, used, limit: budget.limit,
  };
}
