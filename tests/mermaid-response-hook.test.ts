import { describe, expect, it } from "vitest";
import register from "../extensions/mermaid-response/extension.ts";

const LONG = "The hook watches the prompt, the final answer, and the turn end. ".repeat(2);
const BAD = "```mermaid\nflowchart TD\nA -- > B\n```";
const GOOD = "```mermaid\nflowchart TD\nA --> B\n```";

/** Minimal Pi surface: records handlers and follow-up dispatches, nothing else. */
function harness() {
  const handlers = new Map<string, (event: any, ctx?: any) => any>();
  const sent: Array<{ message: any; options: any }> = [];
  const pi = {
    on: (name: string, handler: (event: any, ctx?: any) => any) => handlers.set(name, handler),
    sendMessage: (message: any, options: any) => { sent.push({ message, options }); },
  };
  register(pi);
  const emit = (name: string, event: any, ctx: any = {}) => handlers.get(name)!(event, ctx);
  return { emit, sent };
}

const prompt = (text: string) => ({ source: "interactive", text });
const assistant = (text: string, stopReason = "stop") => ({ role: "assistant", stopReason, content: [{ type: "text", text }] });

describe("Mermaid response hook, end to end through the extension events", () => {
  it("requests exactly one hidden follow-up when a requested explanation has no diagram", async () => {
    const h = harness();
    await h.emit("input", prompt("explain how the hook architecture works in this workflow"));
    await h.emit("turn_end", { message: assistant(LONG) });
    await h.emit("turn_end", { message: assistant(LONG) });

    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].message.customType).toBe("pi-swarm-mermaid-followup");
    expect(h.sent[0].message.display).toBe(false);
    expect(h.sent[0].options).toEqual({ deliverAs: "followUp", triggerTurn: true });
  });

  it("does not request a follow-up for a prompt without diagram intent", async () => {
    const h = harness();
    await h.emit("input", prompt("rename the variable in parser.ts and run the tests"));
    await h.emit("turn_end", { message: assistant(LONG) });
    expect(h.sent).toHaveLength(0);
  });

  it("treats a broken diagram as present, so the hook neither repairs-and-retries nor requests a second one", async () => {
    const h = harness();
    await h.emit("input", prompt("draw a flowchart of the hook"));
    const broken = assistant(`${LONG}\n${BAD}`);
    const out = await h.emit("message_end", { message: broken });
    await h.emit("turn_end", { message: out?.message ?? broken });

    expect(h.sent).toHaveLength(0);
  });

  it("repairs a malformed flowchart arrow in the final assistant message", async () => {
    const h = harness();
    await h.emit("input", prompt("draw a flowchart of the hook"));
    const out = await h.emit("message_end", { message: assistant(`${LONG}\n${BAD}`) });

    expect(out?.message?.content[0].text).toContain(GOOD);
  });

  it("does not repair or follow up on a tool-call turn", async () => {
    const h = harness();
    await h.emit("input", prompt("draw a flowchart of the hook"));
    const msg = { role: "assistant", stopReason: "stop", content: [{ type: "toolCall", name: "Bash" }, { type: "text", text: `${LONG}\n${BAD}` }] };
    expect(await h.emit("message_end", { message: msg })).toBeUndefined();
    await h.emit("turn_end", { message: msg });
    expect(h.sent).toHaveLength(0);
  });
});
