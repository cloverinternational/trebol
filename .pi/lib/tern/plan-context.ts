import {
  installPlanContextClearHandler,
  planResumePrompt,
  type PlanContextClearRequest,
  type PlanContextClearResult,
} from "../context/plan-context-clear.ts";

export interface PlanResumeContext {
  sendUserMessage(content: string, options?: { triggerTurn?: boolean }): Promise<void>;
}

/**
 * The subset of Pi's runtime that session clearing needs. Tern's `run.ts` wires
 * the real `AgentSessionRuntime`; tests can wire an equivalent host.
 */
export interface PlanContextRuntime {
  sessionFile(): string | undefined;
  waitForIdle(): Promise<void>;
  newSession(options?: {
    withSession?: (ctx: PlanResumeContext) => Promise<void>;
  }): Promise<{ cancelled?: boolean }>;
}

export interface PlanContextHostOptions {
  notify?: (text: string) => void;
  /** Bounded dedupe memory for replayed requests. */
  maxRemembered?: number;
}

export interface PlanContextHost {
  /** Resolves once every scheduled clear has settled; used by tests and shutdown. */
  settled(): Promise<void>;
  uninstall(): void;
}

const DEFAULT_MAX_REMEMBERED = 100;

/**
 * Performs the part of "Approve + Clear Context" that only a command-capable
 * session runtime can do:
 *
 * 1. wait for the terminating turn to go idle (the tool returned with
 *    `terminate` so the old session never starts implementation),
 * 2. replace the session through `newSession`,
 * 3. send the approved plan as the only message of the new session and trigger
 *    exactly one implementation turn.
 *
 * Failures are reported to the user and never retried: a clear that could not
 * be applied must not silently become a second approval.
 */
export function startPlanContextClearHost(
  runtime: PlanContextRuntime,
  options: PlanContextHostOptions = {},
): PlanContextHost {
  const remembered = new Set<string>();
  const maxRemembered = Math.max(1, options.maxRemembered ?? DEFAULT_MAX_REMEMBERED);
  const notify = options.notify ?? (() => {});
  let queue: Promise<void> = Promise.resolve();

  async function clear(request: PlanContextClearRequest): Promise<void> {
    const before = runtime.sessionFile();
    await runtime.waitForIdle();
    // A user who switched sessions while the turn finished keeps their choice.
    if (runtime.sessionFile() !== before) {
      notify(`Plan approved; context clear skipped because the session changed. The approved plan is at ${request.planPath}.`);
      return;
    }
    const result = await runtime.newSession({
      withSession: async (ctx) => {
        await ctx.sendUserMessage(planResumePrompt(request.plan, request.planPath), { triggerTurn: true });
      },
    });
    if (result?.cancelled) {
      notify(`Plan approved; context clear was cancelled. The approved plan is at ${request.planPath}.`);
    }
  }

  const uninstall = installPlanContextClearHandler((request): PlanContextClearResult => {
    if (!request?.requestId || seen(request.requestId)) return { status: "duplicate" };
    remember(request.requestId);
    queue = queue.then(() => clear(request)).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      notify(`Plan approved, but clearing context failed: ${message}. The approved plan is at ${request.planPath}; implementation was not started.`);
    });
    return { status: "scheduled" };
  });

  function seen(requestId: string): boolean {
    return remembered.has(requestId);
  }

  function remember(requestId: string): void {
    remembered.add(requestId);
    if (remembered.size <= maxRemembered) return;
    const oldest = remembered.values().next().value;
    if (oldest !== undefined) remembered.delete(oldest);
  }

  return {
    settled: () => queue,
    uninstall,
  };
}
