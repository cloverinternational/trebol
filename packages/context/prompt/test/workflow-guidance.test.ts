import { describe, expect, it } from "vitest";
import { applyWorkflowGuidance, workflowWordingOverrides } from "../src/workflow-guidance.js";
import { forgeSwarmSystemPrompt, swarmForgeDelegationAddendum, swarmPromptPresets } from "../src/index.js";
import { TOOL_CONTRACTS } from "../../../../.pi/lib/runtime/tool-contracts.ts";

/** Tool descriptions are owned locally with guidance already applied, so only
 * the prompt presets still carry un-adapted upstream wording. */
const toolDescriptions = Object.values(TOOL_CONTRACTS).map(contract => contract.description);

describe("local workflow guidance", () => {
  it("rewrites every override to its adapted wording", () => {
    for (const [before, after] of workflowWordingOverrides) expect(applyWorkflowGuidance(before)).toBe(after);
  });
  it("leaves no un-adapted wording in the advertised tool contracts", () => {
    for (const [before] of workflowWordingOverrides) {
      for (const description of toolDescriptions) expect(description, before).not.toContain(before);
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
    for (const description of [...toolDescriptions, forgeSwarmSystemPrompt, swarmForgeDelegationAddendum]) {
      const adapted = applyWorkflowGuidance(description);
      expect(applyWorkflowGuidance(adapted)).toBe(adapted);
    }
    expect(applyWorkflowGuidance("IMAGES ONLY; expected_revision is required; approval required")).toBe("IMAGES ONLY; expected_revision is required; approval required");
  });
});
