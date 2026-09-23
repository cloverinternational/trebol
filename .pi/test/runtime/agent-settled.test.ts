import { describe, expect, it, vi } from "vitest";
import { createSettleBridge, onAgentSettled } from "../../lib/runtime/agent-settled.ts";

const immediate = { delayMs: 0, setTimeout: (fn: () => void) => { const h = setTimeout(fn, 0); return h; } };

describe("agent_settled bridge", () => {
  it("settles once after a turn that is not retried", async () => {
    const emit = vi.fn();
    const b = createSettleBridge(emit, immediate);
    b.onAgentEnd({ messages: ["a"] }, { cwd: "/x" });
    await b.flush();
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith({ messages: ["a"] }, { cwd: "/x" });
  });

  it("does not settle the attempt that a retry supersedes", async () => {
    const emit = vi.fn();
    const b = createSettleBridge(emit, immediate);
    b.onAgentEnd({ messages: ["attempt 1"] }, {});
    b.onAgentStart();                       // the retry begins
    b.onAgentEnd({ messages: ["attempt 2"] }, {});
    await b.flush();
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith({ messages: ["attempt 2"] }, {});
  });

  it("emits nothing when a run is still in flight", async () => {
    const emit = vi.fn();
    const b = createSettleBridge(emit, immediate);
    b.onAgentEnd({ messages: [] }, {});
    b.onAgentStart();
    await b.flush();
    expect(emit).not.toHaveBeenCalled();
  });

  it("flush is idempotent and safe with nothing pending", async () => {
    const emit = vi.fn();
    const b = createSettleBridge(emit, immediate);
    b.onAgentEnd({ messages: [] }, {});
    await b.flush();
    await b.flush();
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it("awaits the subscriber so shutdown cannot race persistence", async () => {
    let done = false;
    const b = createSettleBridge(async () => { await new Promise((r) => setTimeout(r, 5)); done = true; }, immediate);
    b.onAgentEnd({}, {});
    await b.flush();
    expect(done).toBe(true);
  });

  it("discards pending work instead of running it at shutdown", async () => {
    // Subscribers use session_shutdown to cancel; a flush there would run the
    // very work they are aborting.
    const emit = vi.fn();
    const b = createSettleBridge(emit, immediate);
    b.onAgentEnd({ messages: [] }, {});
    b.discard();
    await b.flush();
    expect(emit).not.toHaveBeenCalled();
  });

  it("keeps other subscribers running when one throws", async () => {
    const pi: any = { handlers: new Map<string, any[]>(), on(n: string, f: any) { (this.handlers.get(n) ?? this.handlers.set(n, []).get(n))!.push(f); } };
    const good = vi.fn();
    onAgentSettled(pi, () => { throw new Error("boom"); }, immediate);
    onAgentSettled(pi, good, immediate);
    for (const f of pi.handlers.get("agent_end")!) f({ messages: [] }, {});
    for (const f of pi.handlers.get("session_before_compact")!) await f({}, {});
    expect(good).toHaveBeenCalledTimes(1);
  });

  it("still registers under agent_settled so the handler stays callable", () => {
    const pi: any = { handlers: new Map<string, any[]>(), on(n: string, f: any) { (this.handlers.get(n) ?? this.handlers.set(n, []).get(n))!.push(f); } };
    const fn = vi.fn();
    onAgentSettled(pi, fn, immediate);
    expect(pi.handlers.get("agent_settled")).toEqual([fn]);
  });
});
