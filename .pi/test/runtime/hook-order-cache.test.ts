import { describe, expect, it } from "vitest";
import transportParity from "../../../extensions/swarm-transport-parity/extension.ts";
import { prefixBreak } from "../../../extensions/cache-telemetry/extension.ts";

function contextPipeline() {
  const handlers = new Map<string, Array<(e: any) => any>>();
  const pi: any = new Proxy({}, {
    get: (_t, key) => key === "on" ? (name: string, h: any) => { (handlers.get(name) ?? handlers.set(name, []).get(name)!).push(h); }
      : key === "getAllTools" || key === "getActiveTools" ? () => [] : key === "setActiveTools" ? () => {} : undefined,
  });
  transportParity(pi);
  return (messages: any[]) => handlers.get("context")!.reduce((m, h) => h({ messages: m })?.messages ?? m, messages);
}

describe("prompt hook messages keep history append-only", () => {
  it("does not reorder an earlier [prompt, hook] pair when the next prompt arrives", () => {
    const send = contextPipeline();
    const p1 = { role: "user", content: "p1", timestamp: 1 };
    const hook = { role: "custom", customType: "swarm-hook-context", content: "<hook>", details: {}, timestamp: 2 };
    const a1 = { role: "assistant", content: "a1", timestamp: 3 };
    const first = send([p1, hook, a1]);
    const second = send([p1, hook, a1, { role: "user", content: "p2", timestamp: 4 }]);
    expect(prefixBreak({ messages: first }, { messages: second })).toBeUndefined();
  });
});
