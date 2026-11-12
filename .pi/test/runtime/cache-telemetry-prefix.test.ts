import { describe, expect, it } from "vitest";
import { prefixBreak } from "../../../extensions/cache-telemetry/extension.ts";

const base = { messages: [{ role: "system", content: "S" }, { role: "user", content: "hi" }] };

describe("cache telemetry prefixBreak", () => {
  it("treats an append-only request as cache-safe", () => {
    expect(prefixBreak(base, { messages: [...base.messages, { role: "assistant", content: "x" }] })).toBeUndefined();
  });
  it("reports the first rewritten message", () => {
    expect(prefixBreak(base, { messages: [base.messages[0], { role: "user", content: "changed" }] })).toMatchObject({ index: 1, role: "user" });
  });
  it("reports a tool-list change before any message", () => {
    expect(prefixBreak({ ...base, tools: [1] }, { ...base, tools: [2] })).toMatchObject({ index: -1 });
  });
});
