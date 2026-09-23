import { it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import extension from "../../extensions/40-state/candidate-memory-review.ts";
import { openKnowledgeStore } from "../../lib/state/knowledge-store.ts";
import { consultWithPi } from "../../lib/context/context-consult.ts";
import { recallKnowledge } from "../../lib/context/knowledge-recall.ts";

function runFile(bin: string, args: string[], options: any): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(bin, args, { cwd: options.cwd, timeout: options.timeout, signal: options.signal, maxBuffer: 300_000 }, (error, stdout, stderr) => error ? reject(Object.assign(error, { stderr })) : resolve({ stdout, stderr }));
    // Pi print mode waits for stdin EOF when launched through execFile.
    child.stdin?.end();
  });
}
it.skipIf(process.env.PI_SWARM_MEMORY_REVIEW_LIVE !== "1")("reviews an isolated candidate through real Luna, retaining the actual call and output", async () => {
  const root = mkdtempSync(join(tmpdir(), "luna-review-live-"));
  const oldRoot = process.env.PI_SWARM_MEMORY_DIR;
  process.env.PI_SWARM_MEMORY_DIR = join(root, "store");
  try {
    const handlers = new Map<string, any>(), commands = new Map<string, any>();
    const calls: any[] = [];
    const pi = { on: (name: string, fn: any) => handlers.set(name, fn), registerCommand: (name: string, spec: any) => commands.set(name, spec),
      appendEntry: () => {}, exec: async (bin: string, args: string[], options: any) => {
        calls.push({ bin, model: args[args.indexOf("--model") + 1], prompt: args.at(-1)?.slice(0, 350), cwd: options.cwd });
        try {
          const { stdout, stderr } = await runFile(bin, args, { cwd: options.cwd, timeout: options.timeout, signal: options.signal, maxBuffer: 300_000 });
          calls.at(-1).stdout = stdout.trim();
          calls.at(-1).stderr = stderr.slice(0, 200);
          return { code: 0, stdout, stderr };
        } catch (error: any) {
          calls.at(-1).failure = { code: error.code, signal: error.signal, stderr: String(error.stderr ?? "").slice(0, 200) };
          throw error;
        }
      } };
    extension(pi, { consult: consultWithPi });
    const source = "Project Lumen records its pilot invoices in SQLite.";
    const entries = [{ type: "message", id: "source-1", message: { role: "user", content: source } }];
    const ctx = { cwd: root, sessionManager: { getBranch: () => entries, getSessionFile: () => join(root, "session.jsonl") } };
    const store = openKnowledgeStore({ cwd: root, scope: "repository" });
    const before = store.put({ text: "Project Lumen records its pilot invoices in SQLite.", status: "candidate", evidence: [{ ref: "session#source-1" }] });
    await commands.get("memory-review").handler("", ctx);
    const after = store.read(before.id)!;
    console.log("LUNA REVIEW TRACE", JSON.stringify({ call: calls[0], before: { id: before.id, revision: before.revision, status: before.status }, after: { id: after.id, revision: after.revision, status: after.status, evidence: after.evidence }, recalled: recallKnowledge(root, "Lumen invoices SQLite").memories.some(item => item.id.includes(before.id)) }));
    expect(calls).toHaveLength(1);
    expect(after.status).toBe("verified");
    expect(after.revision).not.toBe(before.revision);
  } finally {
    if (oldRoot === undefined) delete process.env.PI_SWARM_MEMORY_DIR; else process.env.PI_SWARM_MEMORY_DIR = oldRoot;
    rmSync(root, { recursive: true, force: true });
  }
}, 45_000);
