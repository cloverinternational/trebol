/**
 * Every tool's model-facing contract, aggregated from the modules that own them.
 *
 * Each tool's description and JSON Schema live in a `*.contract.ts` file beside
 * that tool's implementation; this module only collects them so the surface and
 * gating layers can look a contract up by name. Edit a contract where it lives.
 */
import { CONTRACTS as agentTools } from "../tools/swarm-agent-tools.contract.ts";
import { CONTRACTS as annoyed } from "../tools/swarm-annoyed.contract.ts";
import { CONTRACTS as bash } from "../tools/swarm-bash.contract.ts";
import { CONTRACTS as fsTools } from "../tools/swarm-fs-tools.contract.ts";
import { CONTRACTS as historyTools } from "../tools/swarm-history-tools.contract.ts";
import { CONTRACTS as interaction } from "../tools/swarm-interaction.contract.ts";
import { CONTRACTS as search } from "../tools/swarm-search.contract.ts";
import { CONTRACTS as skills } from "../tools/swarm-skills.contract.ts";
import { CONTRACTS as taskmanage } from "../tools/swarm-taskmanage.contract.ts";
import { CONTRACTS as vault } from "../tools/swarm-vault-tools.contract.ts";
import type { ToolContract } from "./tool-contract.ts";

export type { ToolContract } from "./tool-contract.ts";

export const TOOL_CONTRACTS: Record<string, ToolContract> = {
  ...agentTools, ...annoyed, ...bash, ...fsTools, ...historyTools,
  ...interaction, ...search, ...skills, ...taskmanage, ...vault,
};
