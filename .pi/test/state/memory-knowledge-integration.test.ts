import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import memoryHistoryExtension from "../../extensions/40-state/memory-history.ts";
import { rememberShared } from "../../lib/state/shared-memory.ts";
import { openKnowledgeStore } from "../../lib/state/knowledge-store.ts";

describe("memory_history knowledge integration", () => {
  const roots: string[] = []; const oldRoot = process.env.PI_SWARM_MEMORY_DIR;
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); if (oldRoot === undefined) delete process.env.PI_SWARM_MEMORY_DIR; else process.env.PI_SWARM_MEMORY_DIR = oldRoot; });
  function harness(root: string) { let start: any; let tool: any; const pi: any = { on: (name: string, fn: any) => { if (name === "session_start") start = fn; }, registerTool: (value: any) => { tool = value; }, appendEntry: vi.fn() }; memoryHistoryExtension(pi); start({}, { cwd: root, sessionManager: { getSessionFile: () => join(root, "session.jsonl"), getEntries: () => [] } }); return tool; }
  const call = (tool: any, params: any) => tool.execute("id", params).then((result: any) => JSON.parse(result.content[0].text));
  it("writes durable candidates, reloads, corrects and tombstones without legacy duplication", async () => {
    const root = mkdtempSync(join(tmpdir(), "memory-history-")); roots.push(root); process.env.PI_SWARM_MEMORY_DIR = join(root, "store");
    const tool = harness(root); const first = await call(tool, { operation: "remember", scope: "repository", text: "durable fact", id: "", expectedRevision: "", evidence: [{ ref: "test:1" }] });
    expect(first.knowledge[0].status).toBe("candidate"); expect(first.legacy).toEqual([]);
    const reloaded = harness(root); const found = await call(reloaded, { operation: "search", scope: "repository", query: "durable" }); expect(found.knowledge).toHaveLength(1);
    expect((await call(reloaded, { operation: "search", status: "verified" })).knowledge).toEqual([]);
    const review = await call(reloaded, { operation: "get", id: found.knowledge[0].id });
    expect(review.knowledge[0].evidence).toEqual([{ ref: "test:1" }]);
    expect(review.review).toContain("later corrections");
    const corrected = await call(reloaded, { operation: "correct", scope: "repository", id: found.knowledge[0].id, expectedRevision: found.knowledge[0].revision, text: "corrected fact", evidence: [{ ref: "test:2" }] });
    await call(reloaded, { operation: "delete", scope: "repository", id: corrected.knowledge[0].id, expectedRevision: corrected.knowledge[0].revision });
    expect((await call(reloaded, { operation: "search", scope: "repository", query: "fact" })).knowledge).toEqual([]);
  });
  it("labels legacy reads unverified, preserves them, and denies global mutation", async () => {
    const root = mkdtempSync(join(tmpdir(), "memory-history-")); roots.push(root); process.env.PI_SWARM_MEMORY_DIR = join(root, "store"); rememberShared(root, "repository", "old legacy fact");
    const tool = harness(root); const result = await call(tool, { operation: "search", scope: "repository", query: "legacy" }); expect(result.legacy[0]).toMatchObject({ status: "unverified", verified: false });
    const denied = await tool.execute("id", { operation: "remember", scope: "global", text: "not approved" }); expect(denied.isError).toBe(true); expect(denied.content[0].text).toMatch(/approval/);
  });
});

it("rejects missing correction identity and unsupported session deletion", async () => {
  let tool: any;
  memoryHistoryExtension({on() {}, registerTool(value: any) { tool=value; }});
  for (const params of [{operation:'correct',text:'oops'}, {operation:'delete',scope:'session',id:'x',expectedRevision:'x'}, {operation:'search',limit:-1}, {operation:'invented'}]) {
    expect((await tool.execute('id',params)).isError).toBe(true);
  }
});
