import { expect, it } from "vitest";
import { MEMORY_KNOWLEDGE_GUIDANCE, MEMORY_SCOPE_GUIDANCE, MEMORY_REVIEW_GUIDANCE } from "../../lib/context/memory-guidance.ts";
import memoryExtension from "../../extensions/40-state/memory-history.ts";
import contextExtension from "../../extensions/10-context/swarm-context.ts";
import { readFileSync } from "node:fs";

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
it("keeps bootstrap review consistent without silently widening write scopes", () => {
  expect(MEMORY_REVIEW_GUIDANCE).toContain("procedural advice");
  expect(MEMORY_REVIEW_GUIDANCE).toContain("Do not duplicate a fact");
  expect(MEMORY_REVIEW_GUIDANCE).toContain("later corrections may invalidate");
  const source = readFileSync(new URL("../../extensions/00-runtime/bootstrap.ts", import.meta.url), "utf8");
  expect(source).toContain("memoryReview: MEMORY_REVIEW_GUIDANCE");
  expect(source).not.toContain("save durable decisions, constraints, or failure/recovery lessons");
});
