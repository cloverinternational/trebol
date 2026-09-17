import { expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openKnowledgeStore } from "../../lib/state/knowledge-store.ts";
import { promoteGlobalKnowledge } from "../../lib/state/knowledge-promotion.ts";

it("requires explicit approval of the exact revision and preserves the project record", async () => {
  const root = mkdtempSync(join(tmpdir(), "promotion-test-"));
  const options = { cwd: join(root, "project"), root: join(root, "store") };
  try {
    const local = openKnowledgeStore(options);
    const record = local.put({ text: "User prefers concise execution summaries.", status: "verified", evidence: [{ ref: "user:explicit-preference" }] });
    const input = { ...options, scope: "repository" as const, id: record.id, isCurrent: () => true };
    expect((await promoteGlobalKnowledge({ ...input, confirm: async () => false })).status).toBe("declined");
    expect(openKnowledgeStore({ ...options, scope: "global" }).list()).toEqual([]);
    const result = await promoteGlobalKnowledge({ ...input, confirm: async (_title, body) => { expect(body).toContain(record.revision); expect(body).toContain(record.text); return true; } });
    expect(result.status).toBe("promoted");
    expect(local.read(record.id)?.revision).toBe(record.revision);
    expect(openKnowledgeStore({ ...options, cwd: join(root,"foreign"), scope: "global" }).list()).toMatchObject([{ source: "user-approved-global-promotion" }]);
    await expect(promoteGlobalKnowledge({ ...input, isCurrent: () => false, confirm: async () => true })).rejects.toThrow(/Session changed/);
    await expect(promoteGlobalKnowledge({ ...input, confirm: async () => { local.put({ id: record.id, expectedRevision: record.revision, text: "Changed", status: "verified", evidence: record.evidence }); return true; } })).rejects.toThrow(/Record changed/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
it("does not promote a candidate merely because a dialog could approve it", async () => {
  const root = mkdtempSync(join(tmpdir(), "promotion-test-"));
  try {
    const record = openKnowledgeStore({ cwd: root, root }).put({ text: "Unverified claim" });
    await expect(promoteGlobalKnowledge({ cwd: root, root, scope: "repository", id: record.id, confirm: async () => true, isCurrent: () => true })).rejects.toThrow(/verified/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
