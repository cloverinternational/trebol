/**
 * Work registration: the agent registers every user request as TaskManage work and reconciles it before it ends
 * its turn, so the user never has to remind it (HOJA-757).
 *
 * The Swarm hooks in swarm-builtin-hooks.ts gate on "is any task focused". Once one task is focused, a new request
 * arriving three messages later passes every gate, and nothing runs when the agent ends its turn. Traces of real
 * sessions showed the result: 18 of 91 working prompts were registered, later requests were folded into an
 * unrelated task, and users had to type "please update your task". This policy closes the two gaps and only adds
 * short, model-visible context. It never blocks a tool.
 *
 *  - `onUserPrompt`: every message the user wrote opens a request. One line tells the model what registering it
 *    means right now: create a task, activate an open one, or decide whether the message belongs to the focused
 *    task (same goal: a child task, which Hoja files as a sub-issue; different goal: a new root task).
 *  - `onToolResult`: counts acting calls (anything not read-only and not task bookkeeping) since the last
 *    successful TaskManage call and during this turn.
 *  - `onSettle`: when the agent is about to end its turn after acting, continue it once. If a task is still focused
 *    and the work since its last update is unreconciled, ask for completion with evidence or a progress note. If no
 *    task covered acting work this turn, ask the agent to register it. Once per turn, so it cannot loop.
 *
 * Pure state: the Pi runtime (swarm-builtin-hooks-runtime.ts) and the Claude Code/Codex/Antigravity bridge feed it
 * events and deliver its text.
 */
import {
  isBashReadOnly, isBashTool, isCodeModeTool, isPlanModeTool, isReadOnlyDomainTool, isReadOnlyExplorationTool,
  isReadOnlyMemoryCall, isReadOnlyVaultCall, isSkillTool, isTaskManagementTool, isUserInteractionTool,
} from "./swarm-toolclass.ts";

export const WORK_REGISTRATION_HOOK = "work-registration-hook";
export const WORK_REGISTRATION_CUSTOM_TYPE = "pi-swarm-work-registration";

export interface RegistrationTask { id: string; subject: string; status: string; active?: boolean; owner?: string }
export interface WorkRegistrationConfig {
  /** Acting calls after the last TaskManage update that make an unreconciled focused task worth a reminder. */
  reconcileThreshold?: number;
  /** Acting calls in one turn without any task that make the turn's work worth registering. */
  registerThreshold?: number;
}

/** Messages a harness injects as a user turn: background-job notices, cross-session mail, hook reminders. */
const INJECTED = /^\s*(?:<(?:task-notification|cross-session-message|system-reminder|local-command-stdout|local-command-stderr|bash-stdout|bash-stderr|user-prompt-submit-hook)\b|\[SYSTEM NOTIFICATION)/i;
/** A reply that carries no new request: thanks, an acknowledgement, or a bare "continue". */
const ACKNOWLEDGEMENT = /^(?:ok(?:ay)?|k|yes|yep|yeah|sure|thanks?(?: you)?|thx|ty|great|nice|cool|perfect|good|got it|continue|keep going|carry on|go on|proceed|resume)[\s.!,]*$/i;

/** True for a message the person typed; false for harness-injected turns (they do not open a new request). */
export function isUserAuthoredPrompt(prompt: string): boolean {
  const text = prompt.trim();
  return text !== "" && !INJECTED.test(text);
}
export const isAcknowledgement = (prompt: string) => ACKNOWLEDGEMENT.test(prompt.trim());

/**
 * A call that changes something: not task bookkeeping, planning, a question to the user, a skill load or a
 * read-only lookup. Hosts with their own read-only tools pass `hostReadOnly`.
 */
export function isActingCall(toolName: string, params: unknown, hostReadOnly = false): boolean {
  if (!toolName || hostReadOnly) return false;
  if (isTaskManagementTool(toolName) || isPlanModeTool(toolName) || isUserInteractionTool(toolName) || isSkillTool(toolName) || isCodeModeTool(toolName)) return false;
  if (isReadOnlyExplorationTool(toolName) || isReadOnlyDomainTool(toolName) || isReadOnlyMemoryCall(toolName, params) || isReadOnlyVaultCall(toolName, params)) return false;
  if (isBashTool(toolName)) {
    const command = (params as any)?.command;
    if (typeof command === "string" && isBashReadOnly(command)) return false;
  }
  return true;
}

const quote = (subject: string) => `"${subject.length > 80 ? `${subject.slice(0, 77)}…` : subject}"`;
const focusedOf = (tasks: readonly RegistrationTask[]) => tasks.find(t => t.status === "in_progress" && t.active === true && !t.owner);
const openOf = (tasks: readonly RegistrationTask[]) => tasks.filter(t => (t.status === "pending" || t.status === "in_progress") && !t.owner);

export class WorkRegistrationPolicy {
  private turn = 0;
  private settledTurn = -1;
  private actingSinceTaskUpdate = 0;
  private actingThisTurn = 0;
  private taskToolThisTurn = false;
  private readonly reconcileThreshold: number;
  private readonly registerThreshold: number;

  constructor(config: WorkRegistrationConfig = {}) {
    this.reconcileThreshold = Math.max(1, config.reconcileThreshold ?? 2);
    this.registerThreshold = Math.max(1, config.registerThreshold ?? 2);
  }

  /**
   * Any prompt opens a turn (for the settle check); only a message the user wrote gets the registration line.
   * Returns the line to add to the model's context, or undefined.
   */
  onUserPrompt(prompt: string, tasks: readonly RegistrationTask[]): string | undefined {
    this.turn++;
    this.actingThisTurn = 0;
    this.taskToolThisTurn = false;
    if (!isUserAuthoredPrompt(prompt)) return undefined;
    const focus = focusedOf(tasks);
    if (focus) {
      if (isAcknowledgement(prompt)) return undefined;
      return `[Work registration] New user message while task #${focus.id} ${quote(focus.subject)} is active. ` +
        `If it asks for more of the same goal, keep going (a distinct deliverable gets a child task with parentTaskId="${focus.id}", filed as a sub-issue). ` +
        `If it asks for anything else, create a new task for it with status "in_progress" and active=true before acting. Do not fold a new request into #${focus.id}.`;
    }
    const open = openOf(tasks);
    if (open.length) {
      const list = open.slice(0, 3).map(t => `#${t.id} ${quote(t.subject)}`).join(", ");
      return `[Work registration] New user message. Open tasks: ${list}${open.length > 3 ? ", …" : ""}; none is active. ` +
        "Before acting, set the one this message continues to in_progress with active=true, or create a new task for new work.";
    }
    if (isAcknowledgement(prompt)) return undefined;
    return "[Work registration] New user message. If answering it needs more than read-only lookups, create a TaskManage task for it " +
      "(status \"in_progress\", active=true) before acting. Give each separate deliverable its own child task (parentTaskId) so it is tracked on its own.";
  }

  /** Record one finished tool call. `taskManageSucceeded` is true for a TaskManage batch that succeeded. */
  onToolResult(event: { toolName: string; params?: unknown; failed?: boolean; hostReadOnly?: boolean; taskManageSucceeded?: boolean }): void {
    if (isTaskManagementTool(event.toolName)) {
      if (event.taskManageSucceeded !== false && !event.failed) { this.actingSinceTaskUpdate = 0; this.taskToolThisTurn = true; }
      return;
    }
    if (!isActingCall(event.toolName, event.params, event.hostReadOnly)) return;
    this.actingSinceTaskUpdate++;
    this.actingThisTurn++;
  }

  /**
   * The agent is about to end its turn. Returns a continuation instruction at most once per turn, or undefined.
   * The caller delivers it the way its host continues a turn (Pi agent_before_settle, Claude Code Stop).
   */
  onSettle(tasks: readonly RegistrationTask[]): string | undefined {
    if (this.turn === 0 || this.settledTurn === this.turn) return undefined;
    const focus = focusedOf(tasks);
    if (focus && this.actingThisTurn > 0 && this.actingSinceTaskUpdate >= this.reconcileThreshold) {
      this.settledTurn = this.turn;
      return `[Work registration] Before you end this reply, reconcile task #${focus.id} ${quote(focus.subject)} ` +
        `(${this.actingSinceTaskUpdate} acting tool call${this.actingSinceTaskUpdate === 1 ? "" : "s"} since its last update). ` +
        "If its acceptance criteria are verified, update it to status \"completed\" with answers and evidence. " +
        "If not, keep it in_progress and add a note (addNote) saying what is done and what is left. " +
        "If this reply also did work outside it, register that as its own task. Then finish your reply; the user should not have to ask for this.";
    }
    if (!focus && !this.taskToolThisTurn && this.actingThisTurn >= this.registerThreshold) {
      this.settledTurn = this.turn;
      return `[Work registration] This reply made ${this.actingThisTurn} acting tool calls without a task, so the work is not tracked. ` +
        "Create a task for what you did now (one TaskManage batch: create it, then update it to \"completed\" with answers and evidence, " +
        "or leave it in_progress with a note if work remains). Then finish your reply.";
    }
    return undefined;
  }

  /** Visible for tests and diagnostics. */
  state() {
    return { turn: this.turn, settledTurn: this.settledTurn, actingSinceTaskUpdate: this.actingSinceTaskUpdate, actingThisTurn: this.actingThisTurn, taskToolThisTurn: this.taskToolThisTurn };
  }
}
