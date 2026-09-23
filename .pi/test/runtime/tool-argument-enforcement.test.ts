import { describe, expect, it } from "vitest";
import { validateToolArguments } from "../../../vendor/pi-mono/packages/ai/src/utils/validation.ts";
import { applySwarmSurface, PERMISSIVE_PARAMETERS, VALIDATES_OWN_ARGUMENTS } from "../../lib/runtime/swarm-tool-surface.ts";
import { TOOL_CONTRACTS } from "../../lib/runtime/tool-contracts.ts";

const surfaced = (name: string) => applySwarmSurface({ name, description: "", parameters: {} } as any) as any;
const validate = (name: string, args: unknown) =>
  validateToolArguments({ name, parameters: surfaced(name).parameters } as any, { name, arguments: args } as any);

describe("tool argument enforcement", () => {
  it("enforces the real schema for every tool that does not validate its own input", () => {
    for (const name of Object.keys(TOOL_CONTRACTS)) {
      if (VALIDATES_OWN_ARGUMENTS.has(name)) continue;
      expect(surfaced(name).parameters, name).toEqual(TOOL_CONTRACTS[name].parameters);
    }
  });

  it("keeps a permissive schema only for tools that report their own errors", () => {
    for (const name of VALIDATES_OWN_ARGUMENTS) {
      if (!TOOL_CONTRACTS[name]) continue;
      expect(surfaced(name).parameters, name).toEqual({ ...PERMISSIVE_PARAMETERS });
    }
  });

  it("rejects a malformed call instead of letting it reach the tool", () => {
    expect(() => validate("vault", {})).toThrow(/must have required properties action/);
    expect(() => validate("vault", { action: "destroy" })).toThrow(/must be equal to one of the allowed values/);
    expect(() => validate("apply_patch", {})).toThrow(/must have required properties input/);
    expect(() => validate("Skill", { skill: "x", bogus: 1 })).toThrow(/schema is false/);
  });

  it("still accepts well-formed calls", () => {
    expect(() => validate("vault", { action: "get", id: "x" })).not.toThrow();
    expect(() => validate("apply_patch", { input: "patch" })).not.toThrow();
  });

  it("leaves Read permissive because it accepts four spellings of its path argument", () => {
    // file_path | file | path | filename all work at runtime; the advertised
    // schema names only file_path, so enforcing it would reject valid calls.
    for (const key of ["file_path", "file", "path", "filename"]) {
      expect(() => validate("Read", { [key]: "/x.png" }), key).not.toThrow();
    }
  });
});
