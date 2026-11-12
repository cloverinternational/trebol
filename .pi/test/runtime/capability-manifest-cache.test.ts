import { describe, expect, it } from "vitest";
import { CapabilityManifestState } from "../../lib/runtime/swarm-transport-parity.ts";

const tools = [{ name: "bash", description: "run" }] as any;
const user = (text: string, ts: number) => ({ role: "user", content: text, timestamp: ts });

describe("capability manifest keeps earlier requests byte-stable", () => {
  it("keeps the manifest on its original turn after a new prompt", () => {
    const state = new CapabilityManifestState();
    const turn1 = [user("one", 1)];
    const first = state.apply(turn1, "auto", tools)!;
    expect(String(first[0].content)).toContain("<effective_capabilities>");
    const turn2 = [...turn1, { role: "assistant", content: "ok" }, user("two", 2)];
    const second = state.apply(turn2, "auto", tools)!;
    expect(second[0]).toEqual(first[0]);
    expect(String(second[2].content)).toBe("two");
  });

  it("adds a fresh manifest when the tool set changes, keeping the earlier one", () => {
    const state = new CapabilityManifestState();
    const turn1 = [user("one", 1)];
    const first = state.apply(turn1, "auto", tools)!;
    const turn2 = [...turn1, { role: "assistant", content: "ok" }, user("two", 2)];
    const second = state.apply(turn2, "auto", [...tools, { name: "read", description: "r" }])!;
    expect(second[0]).toEqual(first[0]);
    expect(String(second[2].content)).toContain("read");
  });
});
