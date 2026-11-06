import { describe, expect, it } from "vitest";
import { applySwarmModelCompat } from "../../lib/runtime/swarm-transport-parity.ts";

describe("applySwarmModelCompat", () => {
  it("never injects reasoning_effort, in interactive or headless mode", () => {
    for (const mode of [{ interactive: true }, { interactive: false }, {}]) {
      const model: Record<string, any> = { compat: {}, samplingParams: {} };
      applySwarmModelCompat(model, mode);
      expect(model.samplingParams).not.toHaveProperty("reasoning_effort");
    }
  });

  it("leaves a model with no sampling params untouched by thinking", () => {
    const model: Record<string, any> = { compat: {} };
    applySwarmModelCompat(model, { interactive: true });
    expect(model.samplingParams?.reasoning_effort).toBeUndefined();
  });

  it("keeps the compat defaults and still drops a model-default temperature", () => {
    const model: Record<string, any> = { compat: {}, samplingParams: { temperature: 0.7, top_p: 0.9 } };
    expect(applySwarmModelCompat(model, { interactive: true })).toBe(true);
    expect(model.compat).toMatchObject({ supportsStrictMode: false, supportsStore: false, maxTokensField: "max_tokens" });
    expect(model.samplingParams).not.toHaveProperty("temperature");
    expect(model.samplingParams.top_p).toBe(0.9);
  });

  it("preserves a user-supplied sampling key it never owned", () => {
    const model: Record<string, any> = { compat: {}, samplingParams: { reasoning_effort: "low" } };
    applySwarmModelCompat(model, { interactive: true });
    expect(model.samplingParams.reasoning_effort).toBe("low");
  });
});
