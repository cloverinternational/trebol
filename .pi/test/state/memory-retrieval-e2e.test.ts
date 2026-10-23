import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension from "../../../extensions/memory-history/extension.ts";

const previous = process.env.PI_SWARM_MEMORY_DIR;
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  if (previous === undefined) delete process.env.PI_SWARM_MEMORY_DIR;
  else process.env.PI_SWARM_MEMORY_DIR = previous;
});

it("retrieves reordered search terms and admits broad recall candidates without crossing scope or status", async () => {
  const dir = mkdtempSync(join(tmpdir(), "memory-retrieval-e2e-")); dirs.push(dir);
  process.env.PI_SWARM_MEMORY_DIR = join(dir, "store");
  let tool: any, start: any;
  extension({ on(name: string, fn: any) { if (name === "session_start") start = fn; }, registerTool(value: any) { tool = value; } });
  start({}, { cwd: dir, sessionManager: { getEntries: () => [], getSessionFile: () => join(dir, "session.jsonl") } });
  const call = async (params: any) => {
    const result = await tool.execute("e2e", params);
    expect(result.isError).not.toBe(true);
    return ["ask", "recall"].includes(params.operation) ? result.details : JSON.parse(result.content[0].text);
  };
  const records = [
    ["repository", "Amber otter habitat is the quiet marsh."],
    ["repository", "Amber fox habitat is the open field."],
    ["worktree", "Amber otter habitat is the quiet marsh."],
  ] as const;
  for (const [scope, text] of records) await call({ operation: "remember", scope, text });
  const exact = await call({ operation: "search", scope: "repository", query: "amber otter habitat" });
  const reordered = await call({ operation: "search", scope: "repository", query: "habitat amber otter", limit: 1 });
  // Since 7be3677 (ranked memory_history search: BM25 any-term + optional dense
  // RRF) a record matches on any query term and is ordered by BM25 score, so the
  // fox record ("amber", "habitat") ranks behind the otter record, which matches
  // all three terms.
  expect(exact.knowledge.map((r: any) => r.text)).toEqual([records[0][1], records[1][1]]);
  // Reordering the terms changes neither membership nor the top hit.
  expect(reordered.knowledge.map((r: any) => r.text)).toEqual([records[0][1]]);
  expect((await call({ operation: "search", scope: "repository", query: "amber otter", status: "verified" })).knowledge).toEqual([]);
  expect((await call({ operation: "search", scope: "repository", query: "quasar zeppelin" })).knowledge).toEqual([]);
  // No child agent is configured: "unavailable" means the real recall path
  // found a candidate and reached consultation, rather than claiming selection.
  const broad = await call({ operation: "recall", scope: "repository", query: "amber otter habitat unknown chronology elsewhere" });
  expect(broad.status).toBe("unavailable");
  expect((await call({ operation: "recall", scope: "repository", status: "verified", query: "amber otter habitat unknown chronology elsewhere" })).status).toBe("not-indexed");
  expect((await call({ operation: "recall", scope: "repository", query: "quasar zeppelin taxonomy" })).status).toBe("no-result");
  expect((await call({ operation: "recall", scope: "global", query: "amber otter habitat" })).status).toBe("not-indexed");
});
