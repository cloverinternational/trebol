import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import enrichment, { ENRICHMENT_ENTRY } from "../../extensions/40-state/knowledge-enrichment.ts";
import { openKnowledgeStore } from "../../lib/state/knowledge-store.ts";

const original = { root: process.env.PI_SWARM_MEMORY_DIR, capture: process.env.PI_SWARM_MEMORY_CAPTURE, child: process.env.PI_SWARM_SUBAGENT };
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  for (const [key, value] of Object.entries({ PI_SWARM_MEMORY_DIR: original.root, PI_SWARM_MEMORY_CAPTURE: original.capture, PI_SWARM_SUBAGENT: original.child })) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});
function harness(exec?: (...args: any[]) => Promise<any>) {
  const root = mkdtempSync(join(tmpdir(), "enrichment-test-")); roots.push(root);
  process.env.PI_SWARM_MEMORY_DIR = join(root, "store"); delete process.env.PI_SWARM_SUBAGENT; delete process.env.PI_SWARM_MEMORY_CAPTURE;
  const entries: any[] = [{ id: "u1", type: "message", message: { role: "user", content: "Project Orion uses SQLite." } }];
  const handlers = new Map<string, any>(), commands = new Map<string, any>();
  const execute = vi.fn(exec ?? (async () => ({ code: 0, stdout: JSON.stringify({ candidates: [{ title: "Storage", text: "Orion uses SQLite.", evidenceIds: ["u1"], scope: "repository" }] }) })));
  const pi = { exec: execute, on: (name: string, fn: any) => handlers.set(name, fn), registerCommand: (name: string, spec: any) => commands.set(name, spec), appendEntry: (customType: string, data: any) => entries.push({ id: `c${entries.length}`, type: "custom", customType, data }) };
  enrichment(pi); enrichment(pi);
  const ctx = { cwd: root, model: { provider: "test", id: "model" }, sessionManager: { getBranch: () => entries, getSessionFile: () => join(root, "session.jsonl") }, ui: { notify: vi.fn() } };
  handlers.get("session_start")({}, ctx);
  return { root, entries, handlers, commands, execute, ctx, run: () => handlers.get("agent_end")({}, ctx), store: () => openKnowledgeStore({ cwd: root }) };
}
it("captures cited candidates once across repeated hooks and reload", async () => {
  const h = harness(); await h.run();
  expect(h.store().list()).toMatchObject([{ status: "candidate", text: "Orion uses SQLite.", evidence: [{ ref: expect.stringContaining("#u1") }] }]);
  expect(h.entries.at(-1).customType).toBe(ENRICHMENT_ENTRY);
  await h.handlers.get("session_before_compact")({}, h.ctx);
  h.handlers.get("session_start")({}, h.ctx); await h.run();
  expect(h.execute).toHaveBeenCalledTimes(1);
});
it("leaves failed extraction retryable and advances on an honest no-write result", async () => {
  let calls = 0;
  const h = harness(async () => ({ code: 0, stdout: ++calls === 1 ? "not json" : '{"candidates":[]}' }));
  await h.run(); expect(h.entries).toHaveLength(1);
  await h.run(); expect(h.entries.at(-1).data.candidateCount).toBe(0);
  await h.run(); expect(h.execute).toHaveBeenCalledTimes(2);
});
it("cancels stale work without writes and suppresses nested capture", async () => {
  let finish!: (result: any) => void;
  const h = harness(() => new Promise(resolve => { finish = resolve; }));
  const pending = h.run(); h.handlers.get("session_shutdown")();
  finish({ code: 0, stdout: '{"candidates":[]}' }); await pending;
  expect(h.entries).toHaveLength(1);
  expect(h.execute.mock.calls[0][2].signal.aborted).toBe(true);
  process.env.PI_SWARM_SUBAGENT = "1"; await h.run(); expect(h.execute).toHaveBeenCalledTimes(1);
});
it("honors explicit capture off and refuses invented citations", async () => {
  const h = harness(async () => ({ code: 0, stdout: '{"candidates":[{"title":"X","text":"Y","scope":"repository","evidenceIds":["invented"]}]}' }));
  await h.commands.get("memory-capture").handler("off", h.ctx); await h.run(); expect(h.execute).not.toHaveBeenCalled();
  await h.commands.get("memory-capture").handler("on", h.ctx); await h.run(); expect(h.store().list()).toEqual([]); expect(h.entries).toHaveLength(1);
});
