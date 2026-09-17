import { expect, it } from "vitest";
import extension from "../../extensions/10-context/swarm-context.ts";
import { gateActiveTools } from "../../lib/runtime/swarm-tool-gating.ts";

it("keeps context tools visible, registers context_read, and reloads Pi custom entries", async () => {
  const tools = new Map<string, any>();
  const entries: any[] = [];
  let start: any;
  extension({
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand() {},
    appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
    on: (name: string, handler: any) => { if (name === "session_start") start = handler; },
  });
  const ctx = { cwd: process.cwd(), sessionManager: { getSessionFile: () => "diagnostic", getEntries: () => entries }, ui: { notify() {} } };
  start({}, ctx);
  const call = (name: string, params: any) => tools.get(name).execute("diagnostic", params);
  await call("context_remember", { operation: "remember", note: "Diagnostic fact: storage uses SQLite", topic: "Diagnostic" });
  expect((await call("context_outline", { operation: "outline" })).details.sources).toHaveLength(1);
  const active = [...tools.keys()];
  expect(gateActiveTools(active, { interactive: false, env: {}, home: "/nonexistent" }, {}) ?? active).toContain("context_read");
  const search = await call("context_search", { operation: "search", query: "storage" });
  expect(search.details.status).toBe("model-failure");
  expect(search.details.next_steps.options.join(" ")).toContain("context_read");
  expect(tools.has("context_read")).toBe(true);
  const outline = await call("context_outline", { operation: "outline" });
  const sourceId = outline.details.sources[0].sourceId;
  expect((await call("context_read", { operation: "read", sourceId, nodeIds: ["0002"] })).details.evidence[0].excerpt).toContain("SQLite");
  start({}, ctx);
  expect((await call("context_outline", { operation: "outline" })).details.sources).toHaveLength(1);
});
