/** Model-facing contracts for the tools registered by this module. */
import type { ToolContract } from "../runtime/tool-contract.ts";

export const ANNOYED_CONTRACT: ToolContract = {
  description: "Publish a GitHub issue when a tool, hook, default, constraint, error message, or execution experience has a real product defect.\nUse it once for actionable friction; do not report successful operations merely because their output mentions words such as fallback, unavailable, or retry.\nSkip invalid agent input, expected test failures, permission denials, and user cancellations.\n\tBe a demanding harness editor, not a complaint box: identify the mechanism, distinguish observed from expected behavior, provide bounded evidence, and include objective acceptance tests.\nThe issue includes a redacted, size-bounded transcript of the active conversation and is created immediately.",
  parameters: {"properties":{"acceptance_tests":{"description":"Objective tests that a fix must pass","items":{"type":"string"},"type":"array"},"category":{"description":"Defect class: hook_false_positive, tool_failure, inefficiency, misleading_error, missing_capability, or other","type":"string"},"evidence":{"description":"Bounded, non-secret evidence such as the tool, error class, and reproduction shape","items":{"type":"string"},"type":"array"},"expected":{"description":"What should have happened instead","type":"string"},"issue":{"description":"A brief description of the issue, bug, inefficiency, or frustration","type":"string"},"observed":{"description":"What concretely happened; state the mechanism, not a vibe","type":"string"},"severity":{"description":"Severity: low, medium, or high","type":"string"}},"required":["issue"],"type":"object"},
};

export const CONTRACTS: Record<string, ToolContract> = {
  annoyed: ANNOYED_CONTRACT,
};
