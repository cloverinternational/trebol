/**
 * Host bridge for Plan Mode's "Approve + Clear Context" choice.
 *
 * The plan-mode tool itself cannot replace the session: Pi exposes session
 * replacement only through a command context (`ctx.newSession()`), while tools
 * receive a plain `ExtensionContext`. The host that owns a command-capable
 * session runtime installs a handler here; the tool then reports the approved
 * plan plus clear intent and returns with `terminate` set. The handler waits for
 * the current turn to become idle, replaces the session, and sends the approved
 * plan back as the first (and only) message of the new session.
 *
 * This module stays host-independent: it defines the contract and a registry,
 * not the replacement itself.
 */

export const PLAN_CONTEXT_CLEAR_HANDLER = Symbol.for("pi-swarm-plan-context-clear-handler");

export interface PlanContextClearRequest {
  /** Opaque approval id; the host deduplicates repeated deliveries. */
  requestId: string;
  /** Final approved (possibly edited) Markdown plan. */
  plan: string;
  /** Canonical conversation-storage copy the user reviewed. */
  planPath: string;
}

export type PlanContextClearStatus = "scheduled" | "duplicate" | "unavailable";
export interface PlanContextClearResult {
  status: PlanContextClearStatus;
}

export type PlanContextClearHandler = (request: PlanContextClearRequest) => PlanContextClearResult;

function currentHandler(): PlanContextClearHandler | undefined {
  const handler = (globalThis as Record<symbol, unknown>)[PLAN_CONTEXT_CLEAR_HANDLER];
  return typeof handler === "function" ? (handler as PlanContextClearHandler) : undefined;
}

/** True when the running host can actually clear and resume from the approved plan. */
export function planContextClearAvailable(): boolean {
  return currentHandler() !== undefined;
}

/**
 * Installs the host handler and returns an uninstall function. Installing a
 * second handler replaces the first, mirroring how a Tern connect replaces its
 * runtime rather than stacking session hosts.
 */
export function installPlanContextClearHandler(handler: PlanContextClearHandler): () => void {
  (globalThis as Record<symbol, unknown>)[PLAN_CONTEXT_CLEAR_HANDLER] = handler;
  return () => {
    if ((globalThis as Record<symbol, unknown>)[PLAN_CONTEXT_CLEAR_HANDLER] === handler) {
      delete (globalThis as Record<symbol, unknown>)[PLAN_CONTEXT_CLEAR_HANDLER];
    }
  };
}

/**
 * Asks the host to clear context and resume. A host failure is reported as
 * `unavailable` so the tool can fail closed instead of claiming a clear that
 * never happened.
 */
export function requestPlanContextClear(request: PlanContextClearRequest): PlanContextClearResult {
  const handler = currentHandler();
  if (!handler) return { status: "unavailable" };
  try {
    return handler(request) ?? { status: "scheduled" };
  } catch {
    return { status: "unavailable" };
  }
}

/**
 * The single user message that restarts implementation in the cleared session.
 * It carries the approved plan verbatim (the plan is the only thing the clear
 * preserves) and names its canonical copy.
 */
export function planResumePrompt(plan: string, planPath: string): string {
  return [
    "Plan approved with context cleared.",
    "",
    `The approved plan is saved at ${planPath} and reproduced below.`,
    "",
    "```markdown",
    plan,
    "```",
    "",
    "Implement the approved plan now. Follow it precisely; do not restart plan discovery or ask for approval again.",
  ].join("\n");
}
