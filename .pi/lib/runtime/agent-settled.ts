/**
 * `agent_settled`: the turn is over and nothing more will follow it.
 *
 * Pi emits `agent_end` at the end of every attempt, including ones that are
 * about to be retried, and it strips the `willRetry` flag before extensions
 * see the event (agent-session.ts `_emitExtensionEvent`). A listener that only
 * watches `agent_end` therefore fires once per attempt, which is wrong for
 * anything that persists state, summarises the turn, or calls a model: that
 * work would run against a transcript the runtime is about to discard.
 *
 * This module derives the missing signal. A turn is settled once an
 * `agent_end` has been followed by a quiet period with no `agent_start`,
 * because a retry, a compaction retry, or a queued continuation all begin by
 * starting another agent run. If a new run does start, the pending settle is
 * cancelled and the next `agent_end` takes over.
 */

/** Quiet period after `agent_end` before a turn counts as settled. */
export const SETTLE_DELAY_MS = 250;

type Handler = (event: unknown, ctx: unknown) => unknown;

export interface SettleOptions {
  /** Overrides the quiet period; tests use 0 to settle on the next tick. */
  delayMs?: number;
  /** Injectable timer so tests do not wait on real time. */
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

/**
 * Bridges `agent_end` to `agent_settled` for one Pi instance.
 *
 * Returns the listener set so a caller can drive it directly; `attach` wires
 * it to `pi.on` for normal use.
 */
export function createSettleBridge(emit: (event: unknown, ctx: unknown) => Promise<void> | void, options: SettleOptions = {}) {
  const delayMs = options.delayMs ?? SETTLE_DELAY_MS;
  const schedule = options.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  const cancel = options.clearTimeout ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  let pending: unknown;
  // Retained so the settled event carries the final attempt's transcript.
  let lastEvent: unknown;
  let lastCtx: unknown;
  // Set while a settle is in flight so callers can await the emit itself
  // rather than the timer, which is what makes shutdown ordering testable.
  let inFlight: Promise<void> | undefined;

  const clearPending = () => {
    if (pending !== undefined) { cancel(pending); pending = undefined; }
  };

  const fire = async () => {
    pending = undefined;
    const event = lastEvent, ctx = lastCtx;
    lastEvent = undefined; lastCtx = undefined;
    if (event === undefined) return;
    inFlight = Promise.resolve(emit(event, ctx)).finally(() => { inFlight = undefined; });
    await inFlight;
  };

  return {
    /** A new run began, so the previous `agent_end` was not the last word. */
    onAgentStart() { clearPending(); lastEvent = undefined; lastCtx = undefined; },
    onAgentEnd(event: unknown, ctx: unknown) {
      clearPending();
      lastEvent = event; lastCtx = ctx;
      pending = schedule(() => { void fire(); }, delayMs);
    },
    /**
     * Settle immediately instead of waiting out the quiet period. Shutdown and
     * compaction use this: both are points where no further run can start, and
     * pending work must complete before the session goes away.
     */
    async flush() { if (pending !== undefined) { clearPending(); await fire(); } await inFlight; },
    /** Drop a pending settle without running it, for shutdown and teardown. */
    discard() { clearPending(); lastEvent = undefined; lastCtx = undefined; },
    get isPending() { return pending !== undefined; },
  };
}

/**
 * One bridge per Pi instance, shared by every subscriber on it. The runner
 * dispatches only to handlers registered for an event it actually emits, so a
 * central extension cannot deliver `agent_settled` to other extensions; each
 * subscriber instead joins the bridge belonging to its own `pi`.
 */
const bridges = new WeakMap<object, ReturnType<typeof createSettleBridge>>();
const subscribers = new WeakMap<object, Handler[]>();

/**
 * Runs `handler` once the turn has settled: after `agent_end`, and only when no
 * retry or queued continuation follows.
 *
 * The handler is also registered under `agent_settled` so it stays visible to
 * the runner and can be invoked directly in tests.
 */
export function onAgentSettled(pi: any, handler: Handler, options?: SettleOptions): void {
  pi.on?.("agent_settled", handler);

  const existing = subscribers.get(pi);
  if (existing) { existing.push(handler); return; }

  const handlers: Handler[] = [handler];
  subscribers.set(pi, handlers);
  const bridge = createSettleBridge(async (event, ctx) => {
    // One failing subscriber must not strand the others.
    for (const fn of handlers) { try { await fn(event, ctx); } catch { /* reported by the runner */ } }
  }, options);
  bridges.set(pi, bridge);

  pi.on?.("agent_start", () => bridge.onAgentStart());
  pi.on?.("agent_end", (event: unknown, ctx: unknown) => bridge.onAgentEnd(event, ctx));
  // Compaction is terminal for the turn and rewrites the transcript, so settle
  // now rather than report against messages that are about to be replaced.
  pi.on?.("session_before_compact", () => bridge.flush());
  // Shutdown deliberately has no handler here. Subscribers already use
  // `session_shutdown` to cancel in-flight work, so a settle at that point
  // would run the very work they are aborting; a pending settle simply dies
  // with the session. Registering one would also displace a subscriber's own
  // shutdown handler on hosts that keep a single handler per event.
}

/** The settle bridge for `pi`, when one has been created. */
export function settleBridgeFor(pi: object) { return bridges.get(pi); }
