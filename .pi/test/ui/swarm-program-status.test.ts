import { afterEach, beforeEach, describe, expect, it } from "vitest";
import extension from "../../../extensions/swarm-program-status/extension.ts";

function harness() {
  const hooks = new Map<string, Function[]>();
  const pi = {
    on: (name: string, fn: Function) => hooks.set(name, [...(hooks.get(name) ?? []), fn]),
  };
  const written: string[] = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  const originalEnv = process.env.TREBOL_PROGRAM_STATUS;
  process.env.TREBOL_PROGRAM_STATUS = "1";
  (process.stderr as any).write = (data: string) => {
    written.push(String(data));
    return true;
  };
  extension(pi);
  const emit = async (name: string, event: any = {}) => {
    for (const fn of hooks.get(name) ?? []) await fn(event, {});
  };
  const restore = () => {
    (process.stderr as any).write = originalWrite;
    if (originalEnv === undefined) delete process.env.TREBOL_PROGRAM_STATUS;
    else process.env.TREBOL_PROGRAM_STATUS = originalEnv;
  };
  const stateOf = (index: number) => written[index].match(/state=([a-z]+)/)![1];
  return { pi, emit, written, restore, stateOf };
}

describe("swarm-program-status extension", () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => {
    h = harness();
  });
  afterEach(() => h.restore());

  it("reports the session lifecycle: idle -> working -> done -> clear", async () => {
    await h.emit("session_start");
    await h.emit("before_agent_start", { prompt: "refactor the login flow\nmore detail" });
    await h.emit("agent_before_settle", { outcome: "completed" });
    await h.emit("session_shutdown");
    expect(h.written).toHaveLength(4);
    expect(h.stateOf(0)).toBe("idle");
    expect(h.stateOf(1)).toBe("working");
    expect(h.stateOf(2)).toBe("done");
    expect(h.stateOf(3)).toBe("clear");
    for (const seq of h.written) {
      expect(seq.startsWith("\u001b]7501;")).toBe(true);
      expect(seq.endsWith("\u001b\\")).toBe(true);
      expect(seq).toContain("app=trebol");
    }
    const msg = h.written[1].split(":").find((p) => p.startsWith("msg="))!;
    expect(Buffer.from(msg.slice(4), "base64").toString("utf8")).toContain(
      "refactor the login flow",
    );
  });

  it("reports blocked while ask_user_question waits and resumes on answer", async () => {
    await h.emit("session_start");
    await h.emit("before_agent_start", { prompt: "deploy" });
    await h.emit("tool_call", {
      toolName: "ask_user_question",
      input: { questions: [{ id: "q1", text: "Deploy to production now?" }] },
    });
    expect(h.stateOf(2)).toBe("blocked");
    expect(h.written[2]).toContain("kind=question");
    const msg = h.written[2].split(":").find((p) => p.startsWith("msg="))!;
    expect(Buffer.from(msg.slice(4), "base64").toString("utf8")).toBe(
      "Deploy to production now?",
    );
    await h.emit("tool_result", { toolName: "ask_user_question", isError: false });
    expect(h.stateOf(3)).toBe("working");
  });

  it("reports error when the run does not complete", async () => {
    await h.emit("session_start");
    await h.emit("agent_before_settle", { outcome: "aborted" });
    expect(h.stateOf(1)).toBe("error");
  });

  it("keeps the working record when the agent continues after settling", async () => {
    await h.emit("session_start");
    await h.emit("before_agent_start", { prompt: "work" });
    await h.emit("agent_before_settle", { outcome: "completed", continue: true });
    expect(h.stateOf(2)).toBe("working");
  });

  it("refreshes working on turn_start for continuations", async () => {
    await h.emit("session_start");
    await h.emit("before_agent_start", { prompt: "work" });
    await h.emit("turn_start", { turnIndex: 2 });
    expect(h.stateOf(2)).toBe("working");
  });

  it("ignores unrelated tool calls", async () => {
    await h.emit("session_start");
    await h.emit("tool_call", { toolName: "bash", input: {} });
    expect(h.written).toHaveLength(1);
  });

  it("never splits a surrogate pair when truncating the prompt", async () => {
    await h.emit("session_start");
    await h.emit("before_agent_start", { prompt: `${"x".repeat(158)}🔥${"y".repeat(20)}` });
    const msg = h.written[1].split(":").find((p) => p.startsWith("msg="))!;
    const decoded = Buffer.from(msg.slice(4), "base64").toString("utf8");
    expect(decoded).toContain("🔥");
    expect(decoded).not.toContain("�");
  });

  it("registers handlers only once per pi instance", async () => {
    extension(h.pi);
    await h.emit("session_start");
    expect(h.written).toHaveLength(1);
  });
});
