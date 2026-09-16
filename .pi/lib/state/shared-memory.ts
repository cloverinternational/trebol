import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

export type SharedScope = "repository" | "worktree" | "global";
export interface SharedMemory { id: string; text: string; tags: string[]; namespace: string; scope: SharedScope; createdAt: string; source: string; }
const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 32);
export function memoryIdentity(cwd: string) {
  const git = (args: string[]) => execFileSync("git", ["-C", cwd, "rev-parse", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  try { return { repository: resolve(cwd, git(["--git-common-dir"])), worktree: resolve(git(["--show-toplevel"])) }; }
  catch { return { repository: resolve(cwd), worktree: resolve(cwd) }; }
}
export function sharedMemoryRoot() { return process.env.PI_SWARM_MEMORY_DIR || join(homedir(), ".swarm", "memory"); }
function directory(cwd: string, scope: SharedScope) {
  const identity = memoryIdentity(cwd);
  return join(sharedMemoryRoot(), scope, scope === "global" ? "shared" : hash(identity[scope]));
}
/** One immutable file per entry avoids lost updates between concurrent writers. */
export function rememberShared(cwd: string, scope: SharedScope, text: string, tags: string[] = [], namespace = "default"): SharedMemory {
  namespace = namespace.trim() || "default";
  if (!text.trim() || text.length > 20_000) throw new Error("Memory must contain 1–20000 characters");
  const record: SharedMemory = { id: randomUUID(), text: text.trim(), tags, namespace, scope, createdAt: new Date().toISOString(), source: scope === "global" ? "explicit-global" : memoryIdentity(cwd)[scope] };
  const dir = directory(cwd, scope); mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = join(dir, record.id + ".json"), temporary = target + ".tmp";
  writeFileSync(temporary, JSON.stringify(record), { flag: "wx", mode: 0o600 }); renameSync(temporary, target);
  return record;
}
export function searchShared(cwd: string, query = "", scopes: SharedScope[] = ["repository", "worktree", "global"], limit = 20, namespace = "default", ranked = false): SharedMemory[] {
  namespace = namespace.trim() || "default";
  const records: SharedMemory[] = [];
  for (const scope of scopes) {
    const dir = directory(cwd, scope); let files: string[];
    try { files = readdirSync(dir).filter(f => /^[a-f0-9-]+\.json$/.test(f)); } catch { continue; }
    for (const file of files.slice(-2000)) {
      try {
        const path = join(dir, file); if (statSync(path).size > 40_000) continue;
        const value = JSON.parse(readFileSync(path, "utf8"));
        if (value.scope === scope && (value.namespace || "default") === namespace && typeof value.text === "string" && typeof value.createdAt === "string" && (ranked || `${value.text} ${(Array.isArray(value.tags) ? value.tags : []).join(" ")}`.toLowerCase().includes(query.toLowerCase()))) records.push(value);
      } catch { /* A corrupt entry cannot make all recall unavailable. */ }
    }
  }
  const terms = [...new Set(query.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? [])].filter(word => !["the", "and", "for", "with", "from", "this", "that", "into"].includes(word));
  const score = (record: SharedMemory) => { const words = new Set(`${record.text} ${(Array.isArray(record.tags) ? record.tags : []).join(" ")}`.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? []); return terms.reduce((n, term) => n + Number(words.has(term)), 0); };
  return records.filter(record => !ranked || !terms.length || score(record) > 0)
    .sort((a, b) => (ranked ? score(b) - score(a) : 0) || b.createdAt.localeCompare(a.createdAt))
    .slice(0, Math.max(0, Math.min(100, limit)));
}

/** Task-aware lexical recall; scopes and scan/output bounds match shared search. */
export function recallShared(cwd: string, task: string, limit = 60): SharedMemory[] {
  return searchShared(cwd, task, ["repository", "worktree", "global"], limit, "default", true);
}
