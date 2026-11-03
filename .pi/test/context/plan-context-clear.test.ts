import { afterEach, describe, expect, it, vi } from "vitest";
import {
  installPlanContextClearHandler,
  planContextClearAvailable,
  planResumePrompt,
  requestPlanContextClear,
} from "../../lib/context/plan-context-clear.ts";
import { startPlanContextClearHost, type PlanContextRuntime } from "../../lib/tern/plan-context.ts";

const request = (overrides: Partial<{ requestId: string; plan: string; planPath: string }> = {}) => ({
  requestId: overrides.requestId ?? "approval-1",
  plan: overrides.plan ?? "# Plan\n\n1. Do the thing",
  planPath: overrides.planPath ?? "/tmp/conversations/session/plan.md",
});

function runtime(overrides: Partial<PlanContextRuntime> = {}) {
  const calls: Array<{ session: number; message?: string; triggerTurn?: boolean }> = [];
  let session = 1;
  const base: PlanContextRuntime = {
    sessionFile: () => (session === 1 ? "/tmp/first.jsonl" : "/tmp/second.jsonl"),
    waitForIdle: async () => {},
    newSession: async (options) => {
      session += 1;
      calls.push({ session });
      await options?.withSession?.({
        sendUserMessage: async (message, options) => {
          calls.push({ session, message, triggerTurn: options?.triggerTurn });
        },
      });
      return { cancelled: false };
    },
  };
  return { runtime: { ...base, ...overrides }, calls, currentSession: () => session };
}

describe("plan context clear host", () => {
  afterEach(() => {
    delete (globalThis as Record<symbol, unknown>)[Symbol.for("pi-swarm-plan-context-clear-handler")];
  });

  it("reports availability only while a host handler is installed", () => {
    delete (globalThis as Record<symbol, unknown>)[Symbol.for("pi-swarm-plan-context-clear-handler")];
    expect(planContextClearAvailable()).toBe(false);
    expect(requestPlanContextClear(request()).status).toBe("unavailable");
    const uninstall = installPlanContextClearHandler(() => ({ status: "scheduled" }));
    expect(planContextClearAvailable()).toBe(true);
    expect(requestPlanContextClear(request()).status).toBe("scheduled");
    uninstall();
    expect(planContextClearAvailable()).toBe(false);
  });

  it("waits for idle, replaces the session once, and sends the approved plan exactly once", async () => {
    const host = runtime();
    const idle = vi.fn(async () => {});
    host.runtime.waitForIdle = idle;
    const clear = startPlanContextClearHost(host.runtime);
    try {
      expect(requestPlanContextClear(request()).status).toBe("scheduled");
      await clear.settled();
      expect(idle).toHaveBeenCalledTimes(1);
      expect(host.currentSession()).toBe(2);
      expect(host.calls).toHaveLength(2);
      const resume = host.calls.find((call) => call.message);
      expect(resume?.triggerTurn).toBe(true);
      expect(resume?.message).toBe(planResumePrompt("# Plan\n\n1. Do the thing", "/tmp/conversations/session/plan.md"));
      expect(resume?.message?.match(/# Plan/g)).toHaveLength(1); // the plan is preserved verbatim, exactly once
      expect(resume?.message?.match(/Implement the approved plan now\./g)).toHaveLength(1);
    } finally {
      clear.uninstall();
    }
  });

  it("deduplicates a replayed approval id", async () => {
    const host = runtime();
    const clear = startPlanContextClearHost(host.runtime);
    try {
      expect(requestPlanContextClear(request({ requestId: "same" })).status).toBe("scheduled");
      expect(requestPlanContextClear(request({ requestId: "same" })).status).toBe("duplicate");
      await clear.settled();
      expect(host.calls.filter((call) => !call.message)).toHaveLength(1);
    } finally {
      clear.uninstall();
    }
  });

  it("skips the clear when the user changed session while the turn finished", async () => {
    const host = runtime();
    let session = "/tmp/first.jsonl";
    host.runtime.sessionFile = () => session;
    host.runtime.waitForIdle = async () => { session = "/tmp/elsewhere.jsonl"; };
    const notices: string[] = [];
    const clear = startPlanContextClearHost(host.runtime, { notify: (text) => notices.push(text) });
    try {
      requestPlanContextClear(request());
      await clear.settled();
      expect(host.calls).toHaveLength(0);
      expect(notices).toEqual([
        "Plan approved; context clear skipped because the session changed. The approved plan is at /tmp/conversations/session/plan.md.",
      ]);
    } finally {
      clear.uninstall();
    }
  });

  it("reports a cancelled replacement and never resumes", async () => {
    const host = runtime({ newSession: async () => ({ cancelled: true }) });
    const notices: string[] = [];
    const clear = startPlanContextClearHost(host.runtime, { notify: (text) => notices.push(text) });
    try {
      requestPlanContextClear(request());
      await clear.settled();
      expect(host.calls).toHaveLength(0);
      expect(notices).toEqual([
        "Plan approved; context clear was cancelled. The approved plan is at /tmp/conversations/session/plan.md.",
      ]);
    } finally {
      clear.uninstall();
    }
  });

  it("reports a replacement failure without claiming implementation started", async () => {
    const host = runtime({ newSession: async () => { throw new Error("session store unavailable"); } });
    const notices: string[] = [];
    const clear = startPlanContextClearHost(host.runtime, { notify: (text) => notices.push(text) });
    try {
      expect(requestPlanContextClear(request()).status).toBe("scheduled");
      await clear.settled();
      expect(notices).toEqual([
        "Plan approved, but clearing context failed: session store unavailable. The approved plan is at /tmp/conversations/session/plan.md; implementation was not started.",
      ]);
    } finally {
      clear.uninstall();
    }
  });

  it("bounds the dedupe memory", async () => {
    const host = runtime();
    const clear = startPlanContextClearHost(host.runtime, { maxRemembered: 2 });
    try {
      requestPlanContextClear(request({ requestId: "a" }));
      requestPlanContextClear(request({ requestId: "b" }));
      requestPlanContextClear(request({ requestId: "c" }));
      await clear.settled();
      expect(requestPlanContextClear(request({ requestId: "a" })).status).toBe("scheduled");
      await clear.settled();
      expect(host.calls.filter((call) => !call.message)).toHaveLength(4);
    } finally {
      clear.uninstall();
    }
  });
});
