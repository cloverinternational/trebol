/**
 * Regression: a hook block must NEVER stop the agent run.
 *
 * Root cause fixed: correctionBlock (.pi/lib/runtime/hook-correction.ts) returned
 * `terminate: true` from the third blocked call in a prompt, and Pi's agent loop
 * ends the run when every result in a tool batch carries it
 * (pi-agent-core agent-loop.js shouldTerminateToolBatch / hasMoreToolCalls).
 *
 * These tests cover the adapter result, Pi's real agent loop, and a source
 * tripwire so no hook can reintroduce `terminate`.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runAgentLoop } from "@earendil-works/pi-agent-core";
import { registerTaskManageExtension } from "../../../extensions/taskmanage/extension.ts";
import { establishedHookContext } from "../support/hook-session.ts";

function adapter() {
  const handlers = new Map<string, Function[]>();
  const pi = { on: (n: string, f: Function) => handlers.set(n, [...(handlers.get(n) ?? []), f]), appendEntry() {}, registerTool() {}, sendMessage() {} };
  const { manager } = registerTaskManageExtension(pi as any);
  const base = establishedHookContext({ hasUI: true }) as any;
  const ctx = { ...base, sessionManager: { ...base.sessionManager, getEntries: () => [], getBranch: () => [] } };
  const emit = async (name: string, event: any) => {
    const out: any[] = [];
    for (const f of handlers.get(name) ?? []) out.push(await f(event, ctx));
    return out;
  };
  // Same contract as Pi's ExtensionRunner.emitToolCall: first block wins.
  const emitToolCall = async (event: any) => {
    let result: any;
    for (const f of handlers.get("tool_call") ?? []) {
      const r = await f({ type: "tool_call", ...event }, ctx);
      if (r) { result = r; if (r.block) return r; }
    }
    return result;
  };
  return { manager, emit, emitToolCall };
}

describe("hook block never carries terminate", () => {
  it("no blocked result sets terminate, however many blocks occur in one prompt", async () => {
    const { emit, emitToolCall } = adapter();
    await emit("session_start", { type: "session_start" });
    for (let i = 1; i <= 25; i++) {
      const r = await emitToolCall({ toolName: "apply_patch", toolCallId: `c${i}`, input: { input: "p" } });
      expect(r?.block).toBe(true);
      expect(r).not.toHaveProperty("terminate");
    }
  });

  it("repeated-block guidance tells the agent to continue, not to stop", async () => {
    const { emit, emitToolCall } = adapter();
    await emit("session_start", { type: "session_start" });
    let last: any;
    for (let i = 1; i <= 4; i++) last = await emitToolCall({ toolName: "apply_patch", toolCallId: `g${i}`, input: { input: "p" } });
    expect(last.reason).toContain("continue the same run");
    expect(last.reason).not.toMatch(/stop repeating this action/i);
  });
});

// ---------------------------------------------------------------------------
// Pi's real agent loop: the run continues past any number of hook blocks.
// ---------------------------------------------------------------------------
type Step = { calls: { name: string; args?: any }[] } | { text: string };

function scriptedModel(steps: Step[]) {
  let turn = 0;
  const seen: number[] = [];
  const streamFn = (_model: any, context: any) => {
    seen.push(context.messages.length);
    const step = steps[Math.min(turn, steps.length - 1)];
    const index = turn++;
    const content = "text" in step
      ? [{ type: "text", text: step.text }]
      : step.calls.map((c, j) => ({ type: "toolCall", id: `t${index}-${j}`, name: c.name, arguments: c.args ?? {} }));
    const message = {
      role: "assistant", content, api: "test", provider: "test", model: "scripted",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "text" in step ? "stop" : "toolUse", timestamp: Date.now(),
    };
    return { async *[Symbol.asyncIterator]() {}, result: async () => message };
  };
  return { streamFn, turns: () => turn };
}

const tool = (name: string) => ({
  name, label: name, description: name,
  parameters: { type: "object", properties: {}, additionalProperties: true },
  execute: async () => ({ content: [{ type: "text", text: `${name} ran` }], details: {} }),
});

async function run(steps: Step[], toolExecution: "sequential" | "parallel" = "sequential") {
  const { emit, emitToolCall } = adapter();
  await emit("session_start", { type: "session_start" });
  const model = scriptedModel(steps);
  const messages = await runAgentLoop(
    [{ role: "user", content: [{ type: "text", text: "go" }], timestamp: Date.now() }] as any,
    { systemPrompt: "", messages: [], tools: [tool("apply_patch"), tool("write")] } as any,
    {
      model: { id: "scripted", provider: "test", api: "test" },
      convertToLlm: (m: any[]) => m,
      toolExecution,
      beforeToolCall: ({ toolCall, args }: any) => emitToolCall({ toolName: toolCall.name, toolCallId: toolCall.id, input: args }),
    } as any,
    async () => {},
    undefined,
    model.streamFn as any,
  );
  return { messages: messages as any[], turns: model.turns() };
}

describe("Pi agent loop keeps running after hook blocks", () => {
  it("ten consecutive blocked turns, then the model still gets its next turn", async () => {
    const steps: Step[] = [...Array.from({ length: 10 }, () => ({ calls: [{ name: "apply_patch" }] })), { text: "done" }];
    const { messages, turns } = await run(steps);
    expect(turns).toBe(11);
    const results = messages.filter(m => m.role === "toolResult");
    expect(results).toHaveLength(10);
    expect(results.every(r => r.isError === true)).toBe(true);
    expect(messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
  });

  it("a parallel batch where every call is blocked does not end the run", async () => {
    const batch = { calls: [{ name: "apply_patch" }, { name: "write" }, { name: "apply_patch" }] };
    const { turns, messages } = await run([batch, batch, batch, { text: "done" }], "parallel");
    expect(turns).toBe(4);
    expect(messages.filter(m => m.role === "toolResult")).toHaveLength(9);
  });

  it("after blocks, focusing a task lets the same run execute the tool", async () => {
    const { emit, emitToolCall, manager } = adapter();
    await emit("session_start", { type: "session_start" });
    let focused = false;
    const model = scriptedModel([
      { calls: [{ name: "apply_patch" }] }, { calls: [{ name: "apply_patch" }] }, { calls: [{ name: "apply_patch" }] },
      { calls: [{ name: "apply_patch" }] }, { text: "done" },
    ]);
    const messages: any[] = await runAgentLoop(
      [{ role: "user", content: [{ type: "text", text: "go" }], timestamp: Date.now() }] as any,
      { systemPrompt: "", messages: [], tools: [tool("apply_patch")] } as any,
      {
        model: { id: "scripted", provider: "test", api: "test" },
        convertToLlm: (m: any[]) => m,
        toolExecution: "sequential",
        beforeToolCall: async ({ toolCall, args }: any) => {
          // The model satisfies the gate before its 4th attempt (after 3 blocks, where terminate used to fire).
          if (toolCall.id === "t3-0" && !focused) {
            manager.execute({ operations: [{ key: "t", op: "create", subject: "Work", questions: [{ id: "q", text: "Done?" }], status: "in_progress", active: true }] });
            focused = true;
          }
          return emitToolCall({ toolName: toolCall.name, toolCallId: toolCall.id, input: args });
        },
      } as any,
      async () => {}, undefined, model.streamFn as any,
    );
    const results = messages.filter(m => m.role === "toolResult");
    expect(results.slice(0, 3).every(r => r.isError)).toBe(true);
    expect(results[3]).toMatchObject({ isError: false });
    expect(model.turns()).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Tripwire: no Trebol hook source may return `terminate` on a block.
// ---------------------------------------------------------------------------
// Tool results, not hook blocks: a run-ending result is the tool's own contract.
const TOOL_RESULT_TERMINATE: Record<string, string> = {
  "extensions/swarm-plan-mode/extension.ts":
    "exit_plan_mode approved-with-clear returns terminate so the host resumes from the cleared session",
};

describe("source tripwire", () => {
  it("no runtime, extension or package source sets terminate on a hook result", () => {
    const root = join(__dirname, "../../..");
    const dirs = [".pi/lib", "extensions", "packages"];
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name === "node_modules" || name === "test" || name === "dist") continue;
        const path = join(dir, name);
        if (statSync(path).isDirectory()) { walk(path); continue; }
        if (!/\.(ts|mjs|js)$/.test(name)) continue;
        // Comments may document the invariant; only code counts.
        const text = readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
        if (/\bterminate\s*:\s*(true|[a-zA-Z_$(])/.test(text) || /\{\s*terminate\s*[,}]/.test(text)) offenders.push(path.slice(root.length + 1));
      }
    };
    for (const d of dirs) walk(join(root, d));
    // The invariant is about a *block* (a denial). A successful tool result may
    // legitimately end the turn, and exit_plan_mode does exactly that: approved
    // with a cleared context is a tool result, and the host resumes from the
    // cleaned session once this turn is over. Nothing else is allowed, and an
    // entry that stops matching fails, so a stale allowance cannot hide a block.
    const unexpected = offenders.filter((p) => !(p in TOOL_RESULT_TERMINATE));
    expect(unexpected).toEqual([]);
    for (const path of Object.keys(TOOL_RESULT_TERMINATE)) expect(offenders).toContain(path);
  });
});
