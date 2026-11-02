import { describe, expect, it } from "vitest";
import { loadSwarmCanonicalTools, VALIDATES_OWN_ARGUMENTS } from "../../lib/runtime/swarm-tool-surface.ts";
import { TOOL_CONTRACTS } from "../../lib/runtime/tool-contracts.ts";
import { withDescriptionField } from "../../lib/runtime/tool-contract.ts";

const surface = () => loadSwarmCanonicalTools();
const schema = (name: string) => surface().get(name)!.parameters as any;

describe("tool description field", () => {
  // Drift guard: a new tool cannot join the surface without a label, and nobody
  // has to remember to add one by hand in 40 registrations.
  it("advertises a description on every tool in the canonical surface", () => {
    for (const name of Object.keys(TOOL_CONTRACTS)) {
      expect(surface().has(name), `${name} missing from surface`).toBe(true);
      expect(schema(name).properties?.description, name).toMatchObject({ type: "string" });
    }
  });

  // Pi's prepareToolCall validates the registered schema before any hook runs and
  // a hook cannot rewrite arguments, so requiring the label on a schema-validated
  // tool would turn a cosmetic omission into a hard failure. This test pins that
  // boundary so it cannot be flipped by accident.
  it("requires the label only where the call cannot be rejected before the tool runs", () => {
    for (const name of surface().keys()) {
      const required: string[] = schema(name).required ?? [];
      if (VALIDATES_OWN_ARGUMENTS.has(name)) expect(required, name).toContain("description");
      else expect(required, name).not.toContain("description");
    }
  });

  it("keeps a tool's own description property when it already declares one", () => {
    const own = { type: "object", properties: { description: { type: "string", description: "mine" } } };
    expect((withDescriptionField(own).properties as any).description.description).toBe("mine");
  });

  it("keeps existing required entries and does not duplicate the label", () => {
    const once = withDescriptionField({ type: "object", required: ["command"], properties: {} }, { required: true });
    const twice = withDescriptionField(once, { required: true });
    expect(twice.required).toEqual(["command", "description"]);
  });

  it("leaves a schema with no properties object usable", () => {
    const bare = withDescriptionField({ type: "object" });
    expect((bare.properties as any).description.type).toBe("string");
    expect(bare.required).toBeUndefined();
  });
});
