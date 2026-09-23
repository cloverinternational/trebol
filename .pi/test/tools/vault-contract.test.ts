import { describe, expect, it } from "vitest";
import { registerVaultTool } from "../../extensions/30-tools/vault.ts";
import { VAULT_CONTRACT } from "../../lib/tools/swarm-vault-tools.contract.ts";

describe("vault tool contract", () => {
  const register = () => {
    const tools: any[] = [];
    registerVaultTool({ registerTool: (t: any) => tools.push(t) } as any);
    return tools.find((t) => t.name === "vault");
  };

  it("advertises every action the executor implements", () => {
    // The tool handles get alongside add/list/remove; a stale contract that
    // omitted get told the model the capability did not exist.
    const action = (VAULT_CONTRACT.parameters as any).properties.action;
    expect(action.enum).toEqual(["add", "list", "get", "remove"]);
  });

  it("advertises the search and pagination parameters the executor reads", () => {
    const props = Object.keys((VAULT_CONTRACT.parameters as any).properties);
    expect(props).toEqual(expect.arrayContaining(["query", "scope", "tags", "limit", "cursor", "details"]));
  });

  it("registers the contract it owns rather than a placeholder", () => {
    const tool = register();
    expect(tool.description).toBe(VAULT_CONTRACT.description);
    expect(tool.parameters).toBe(VAULT_CONTRACT.parameters);
  });
});
