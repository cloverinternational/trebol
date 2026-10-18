import { expect, it } from "vitest";
import { MEMORY_KNOWLEDGE_GUIDANCE, MEMORY_SCOPE_GUIDANCE } from "../../lib/context/memory-guidance.ts";
import memoryExtension from "../../../extensions/memory-history/extension.ts";
import contextExtension from "../../../extensions/swarm-context/extension.ts";

it("shares the knowledge/procedure distinction across actual tool registrations", () => {
  const tools = new Map<string, any>();
  const pi = { registerTool: (tool: any) => tools.set(tool.name, tool), registerCommand() {}, on() {} };
  memoryExtension(pi);
  contextExtension(pi);
  for (const name of ["memory_history", "context_remember"]) {
    expect(tools.get(name).description).toContain(MEMORY_KNOWLEDGE_GUIDANCE);
  }
  expect(tools.get("memory_history").description).toContain(MEMORY_SCOPE_GUIDANCE);
  expect(tools.get("context_remember").description).toContain("does not promote notes");
});
