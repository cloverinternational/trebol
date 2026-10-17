import { readFileSync } from "node:fs";

/** When a section is included. `forge` and `plain` are exclusive; see prompts/swarm-system-prompt.md. */
export type PromptCondition = "forge" | "plain" | "always" | "swarm-flow";

export interface PromptSection {
  id: string;
  when: PromptCondition;
  body: string;
}

const PROMPT_FILE = new URL("../../../../prompts/swarm-system-prompt.md", import.meta.url);
const SECTION_PATTERN = /<!-- section: ([a-z-]+) when: ([a-z-]+) -->\n([\s\S]*?)\n<!-- end -->/g;

/** Every section in file order. The markdown file is the only prompt source. */
export const swarmPromptSections: readonly PromptSection[] = Object.freeze(
  [...readFileSync(PROMPT_FILE, "utf8").matchAll(SECTION_PATTERN)].map((match) => ({
    id: match[1],
    when: match[2] as PromptCondition,
    body: match[3],
  })),
);

/** Body of the first section with this id. Throws if the file lacks it. */
export function promptSection(id: string): string {
  const section = swarmPromptSections.find((candidate) => candidate.id === id);
  if (!section) throw new Error(`prompts/swarm-system-prompt.md has no section "${id}"`);
  return section.body;
}

export const forgeSwarmSystemPrompt: string = promptSection("forge");
export const swarmForgeDelegationAddendum: string = promptSection("delegation");
export const swarmForgeSystemPrompt: string = forgeSwarmSystemPrompt + swarmForgeDelegationAddendum;

/** Provenance reference recorded by prompt-assembling extensions. */
export const PROMPT_SOURCE = "prompts/swarm-system-prompt.md";
