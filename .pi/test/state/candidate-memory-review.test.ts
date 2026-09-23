import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension from "../../extensions/40-state/candidate-memory-review.ts";
import { openKnowledgeStore } from "../../lib/state/knowledge-store.ts";
import { loadSessionEvidence } from "../../lib/state/candidate-memory-review.ts";
import { recallKnowledge } from "../../lib/context/knowledge-recall.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); delete process.env.PI_SWARM_MEMORY_DIR; });
function harness(verdict: any = { supported: true, quote: "The service uses SQLite." }) {
  const root = mkdtempSync(join(tmpdir(), "memory-review-")); roots.push(root); process.env.PI_SWARM_MEMORY_DIR = join(root, "store");
  const session = join(root, "session.jsonl"), entries: any[] = [{ id: "s1", type: "message", message: { role: "user", content: "The service uses SQLite." } }];
  const handlers = new Map<string, any>(), commands = new Map<string, any>();
  const consult = vi.fn(async () => ({ status: "completed", value: verdict }));
  const pi = { on: (name: string, fn: any) => handlers.set(name, fn), registerCommand: (name: string, spec: any) => commands.set(name, spec), appendEntry: vi.fn() };
  extension(pi, { consult: consult as any });
  const ctx = { cwd: root, model: "clover-plexus/luna", sessionManager: { getBranch: () => entries, getSessionFile: () => session } };
  const store = openKnowledgeStore({ cwd: root, scope: "repository" });
  const candidate = store.put({ text: "Service uses SQLite.", status: "candidate", evidence: [{ ref: `session#s1` }] });
  return { root, entries, handlers, commands, consult, pi, ctx, store, candidate };
}
it("verifies one supported candidate and writes only its exact revision", async () => {
  const h = harness(); await h.handlers.get("agent_settled")({}, h.ctx);
  expect(h.consult).toHaveBeenCalledTimes(1);
  expect(h.store.read(h.candidate.id)).toMatchObject({ status: "verified", evidence: [{ quote: "The service uses SQLite." }] });
  expect(h.store.read(h.candidate.id)?.revision).not.toBe(h.candidate.revision);
  expect(recallKnowledge(h.root, "SQLite").memories.some(m => m.id.includes(h.candidate.id))).toBe(true);
  await h.handlers.get("agent_settled")({}, h.ctx);
  expect(h.consult).toHaveBeenCalledTimes(1);
  expect(h.consult.mock.calls[0][1]).toMatchObject({ model: "clover-plexus/luna" });
});
it("resolves a cited older Pi session entry, but not paths outside the session root", async () => {
  const h = harness(); const root = join(h.root, "pi-sessions"); mkdirSync(root);
  const project = join(root, `--${h.root.slice(1).replaceAll("/", "-")}--`); mkdirSync(project);
  const old = join(project, "older.jsonl");
  writeFileSync(old, JSON.stringify({ type: "message", id: "old-1", message: { role: "user", content: "The service uses SQLite." } }) + "\n");
  expect(await loadSessionEvidence(`${old}#old-1`, h.ctx, root)).toMatchObject({ role: "user", text: "The service uses SQLite." });
  expect(await loadSessionEvidence(`${join(h.root, "session.jsonl")}#old-1`, h.ctx, root)).toBeUndefined();
});
it("requires a configured Pi model when a registry is present", async () => {
  const h = harness(); const ctx = { ...h.ctx, modelRegistry: { find: vi.fn(() => undefined) } };
  await h.commands.get("memory-review").handler("", ctx);
  expect(h.consult).not.toHaveBeenCalled();
  expect(h.store.read(h.candidate.id)?.status).toBe("candidate");
});
it("resolves a registered Luna model before consultation", async () => {
  const h = harness(); const model = { provider: "clover-plexus", id: "luna" };
  const ctx = { ...h.ctx, modelRegistry: { find: vi.fn(() => model) } };
  await h.commands.get("memory-review").handler("", ctx);
  expect(ctx.modelRegistry.find).toHaveBeenCalledWith("clover-plexus", "luna");
  expect(h.consult.mock.calls[0][1]).toMatchObject({ model });
});
it("does not certify a multi-source candidate from only one matching quote", async () => {
  const h = harness(); h.store.put({ id: h.candidate.id, expectedRevision: h.candidate.revision,
    text: h.candidate.text, status: "candidate", evidence: [...h.candidate.evidence, { ref: "session#missing" }] });
  await h.commands.get("memory-review").handler("", h.ctx);
  expect(h.consult).not.toHaveBeenCalled();
  expect(h.store.read(h.candidate.id)?.status).toBe("candidate");
});
it.each([null, { supported: true, quote: "invented" }, { supported: true, quote: "SQLite" }, { supported: "yes", quote: "The service uses SQLite." }, { supported: true, quote: "The service uses SQLite.", extra: 1 }])("leaves invalid model output unchanged (%s)", async verdict => {
  const h = harness(verdict); await h.commands.get("memory-review").handler("", h.ctx); expect(h.store.read(h.candidate.id)?.status).toBe("candidate");
});
it("does not write after abort or unavailable consultation", async () => {
  const h = harness(); h.consult.mockResolvedValueOnce({ status: "cancelled", error: "cancelled" } as any);
  await h.commands.get("memory-review").handler("", h.ctx); expect(h.store.read(h.candidate.id)?.status).toBe("candidate");
  const h2 = harness(); h2.consult.mockResolvedValueOnce({ status: "model-failure", error: "unavailable" } as any);
  await h2.commands.get("memory-review").handler("", h2.ctx); expect(h2.store.read(h2.candidate.id)?.status).toBe("candidate");
});
it("does not write if the session changes while the model response is pending", async () => {
  const h = harness(); let finish!: (value: any) => void;
  h.consult.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const pending = h.commands.get("memory-review").handler("", h.ctx);
  await new Promise(resolve => setTimeout(resolve, 0));
  h.handlers.get("session_before_switch")();
  finish({ status: "completed", value: { supported: true, quote: "The service uses SQLite." } });
  await pending;
  expect(h.store.read(h.candidate.id)?.status).toBe("candidate");
});
it("rejects unsupported claims and does not accept another session citation", async () => {
  const h = harness({ supported: false, quote: "The service uses SQLite." }); await h.handlers.get("agent_settled")({}, h.ctx);
  expect(h.store.read(h.candidate.id)?.status).toBe("candidate");
  const h2 = harness(); h2.store.put({ text: "Another candidate", status: "candidate", evidence: [{ ref: "/other/session#s1" }] });
  await h2.handlers.get("agent_settled")({}, h2.ctx); expect(h2.consult).toHaveBeenCalledTimes(1);
});
it("leaves stale concurrent revisions unchanged and recall excludes candidates", async () => {
  const h = harness(); h.consult.mockImplementationOnce(async () => {
    h.store.put({ id: h.candidate.id, expectedRevision: h.candidate.revision, text: "New candidate text", status: "candidate", evidence: h.candidate.evidence });
    return { status: "completed", value: { supported: true, quote: "The service uses SQLite." } } as any;
  });
  await h.handlers.get("agent_settled")({}, h.ctx); expect(h.store.read(h.candidate.id)?.text).toBe("New candidate text");
});
