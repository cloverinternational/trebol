import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { applyWorkflowGuidance, workflowWordingOverrides } from "../src/workflow-guidance.js";
import { forgeSwarmSystemPrompt, swarmForgeDelegationAddendum, swarmPromptPresets } from "../src/index.js";

const tools = ["swarm-tools.json", "swarm-interactive-tools.json"].flatMap(name =>
  JSON.parse(readFileSync(new URL(`../../../../tools/parity/fixtures/${name}`, import.meta.url), "utf8"))
    .map((entry: any) => entry.function.description as string));

describe("local workflow guidance", () => {
  it("keeps overrides anchored to actual upstream wording", () => {
    const sources = [forgeSwarmSystemPrompt, swarmForgeDelegationAddendum, ...tools];
    for (const [before, after] of workflowWordingOverrides) {
      expect(sources.some(source => source.includes(before)), before).toBe(true);
      expect(applyWorkflowGuidance(before)).toBe(after);
    }
  });
  it("removes blanket restrictions from shipped presets", () => {
    for (const preset of swarmPromptPresets) {
      expect(preset.content).not.toContain("NEVER create documentation files");
      expect(preset.content).not.toContain("Only output code when explicitly requested");
      expect(preset.content).not.toContain("never judgment");
      expect(preset.content).toContain("Do not delete failing tests without a compelling reason");
    }
  });
  it("preserves capability and integrity constraints and is idempotent", () => {
    for (const description of tools) {
      const adapted = applyWorkflowGuidance(description);
      expect(applyWorkflowGuidance(adapted)).toBe(adapted);
    }
    expect(applyWorkflowGuidance("IMAGES ONLY; expected_revision is required; approval required")).toBe("IMAGES ONLY; expected_revision is required; approval required");
  });
});
