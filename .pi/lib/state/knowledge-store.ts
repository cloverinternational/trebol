import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, readSync, mkdirSync, openSync, lstatSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, dirname, sep } from "node:path";
import { memoryIdentity, sharedMemoryRoot, type SharedScope } from "./shared-memory.ts";
import { redactContext } from "../context/page-index-memory.ts";

export type KnowledgeStatus = "candidate" | "verified";
export type KnowledgeKind = "fact" | "decision" | "process" | "context";
export interface EvidenceRef { ref: string; quote?: string; }
export interface KnowledgeInput {
  text: string; tags?: string[]; namespace?: string; status?: KnowledgeStatus;
  kind?: KnowledgeKind; evidence?: EvidenceRef[]; source?: string;
  id?: string; expectedRevision?: string;
}
export interface KnowledgeRecord extends Required<Omit<KnowledgeInput, "id" | "expectedRevision" | "evidence" | "source">> {
  id: string; revision: string; evidence: EvidenceRef[]; source: string;
  scope: SharedScope; createdAt: string; updatedAt: string; deleted?: boolean;
}
export interface KnowledgeEvent { type: "put" | "tombstone"; record: KnowledgeRecord; revision: string; at: string; }
export interface StoreOptions { cwd: string; scope?: SharedScope; allowGlobal?: boolean; root?: string; namespace?: string; }
export interface PageIndexSource { id: string; title: string; section: string; text: string; revision: string; status: KnowledgeStatus; evidence: EvidenceRef[]; }

const MAX_TEXT = 20_000, MAX_EVIDENCE = 32, MAX_READ = 100;
const digest = (v: string) => createHash("sha256").update(v).digest("hex").slice(0, 32);
const redactions: RegExp[] = [
  /(?<![A-Za-z0-9_./-])(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|xox[baprs]-[A-Za-z0-9-]{12,}|xai-[A-Za-z0-9_-]{12,})\b/gi,
  /\b(bearer\s+)[A-Za-z0-9._~+\/-]{12,}/gi,
  /\b((?:password|passwd|secret|api[_-]?key|token)\s*[:=]\s*)[^\s,;]+/gi,
];
export function redactKnowledge(value: string): string {
  let out = value;
  // redactContext carries the common credential rules; these cover Slack and
  // the store-specific forms. Never use a captured secret as the replacement.
  out = redactContext(out).replace(/\b(?:xox[baprs]-[A-Za-z0-9-]{12,})\b/gi, "[REDACTED]");
  out = out.replace(redactions[0], "[REDACTED]");
  for (const pattern of redactions.slice(1)) out = out.replace(pattern, "$1[REDACTED]");
  return out;
}
const clean = (s: string) => redactKnowledge(s).trim();
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_EVENT_BYTES = 2_000_000;
const requireId = (id: string) => { if (typeof id !== "string" || !SAFE_ID.test(id)) throw new Error("Invalid knowledge id"); return id; };
const validDate = (value: unknown) => typeof value === "string" && !Number.isNaN(Date.parse(value));

function validateEvent(value: unknown): KnowledgeEvent {
  if (!value || typeof value !== "object") throw new Error("Malformed knowledge event");
  const e = value as Partial<KnowledgeEvent>, r = e.record as Partial<KnowledgeRecord>;
  if ((e.type !== "put" && e.type !== "tombstone") || typeof e.revision !== "string" || !/^[a-f0-9]{32}$/.test(e.revision) || !r || !SAFE_ID.test(r.id ?? "") || typeof r.text !== "string" || !r.text.trim() || r.text.length > MAX_TEXT || (r.status !== "candidate" && r.status !== "verified") || !["fact", "decision", "process", "context"].includes(r.kind as string) || !["repository", "worktree", "global"].includes(r.scope as string) || typeof r.namespace !== "string" || !r.namespace.trim() || typeof r.source !== "string" || !validDate(r.createdAt) || !validDate(r.updatedAt) || !validDate(e.at) || !Array.isArray(r.tags) || r.tags.some(x => typeof x !== "string") || !Array.isArray(r.evidence)) throw new Error("Malformed knowledge event");
  if (r.evidence.length > MAX_EVIDENCE || r.evidence.some(x => !x || typeof x.ref !== "string" || !x.ref.trim() || x.ref.length > 2000 || (x.quote !== undefined && typeof x.quote !== "string"))) throw new Error("Malformed knowledge evidence");
  if (r.status === "verified" && r.evidence.length === 0) throw new Error("Verified knowledge requires evidence");
  if (r.deleted !== undefined && typeof r.deleted !== "boolean") throw new Error("Malformed tombstone");
  if ((e.type === "tombstone") !== (r.deleted === true)) throw new Error("Inconsistent tombstone");
  if (e.type === "put" && r.deleted === true) throw new Error("Put cannot be tombstone");
  if (r.revision !== e.revision) throw new Error("Inconsistent revision");
  return e as KnowledgeEvent;
}

export class KnowledgeStore {
  readonly directory: string; readonly scope: SharedScope; readonly namespace: string;
  constructor(private readonly options: StoreOptions) {
    this.scope = options.scope ?? "repository"; this.namespace = options.namespace?.trim() || "default";
    const identity = memoryIdentity(options.cwd), key = this.scope === "global" ? "shared" : digest(identity[this.scope]);
    if (!["repository", "worktree", "global"].includes(this.scope)) throw new Error("Invalid knowledge scope");
    const root = resolve(options.root ?? sharedMemoryRoot()); this.directory = resolve(root, "knowledge", this.scope, key);
    if (!this.directory.startsWith(root + sep)) throw new Error("Invalid knowledge store boundary");
    this.checkDirectory(false);
  }
  /** Reject existing symlink ancestors. Not a defense against hostile concurrent
   * ancestor replacement; the configured store root must be user-controlled. */
  private checkDirectory(create: boolean): void {
    const walk = (path: string): void => {
      const parent = dirname(path);
      if (parent !== path) walk(parent);
      try {
        const stat = lstatSync(path);
        if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Unsafe knowledge directory");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        if (create) mkdirSync(path, { mode: 0o700 });
      }
    };
    walk(this.directory);
  }

  private lock<T>(fn: () => T): T {
    this.checkDirectory(true);
    const lock = join(this.directory, ".lock");
    try { mkdirSync(lock, { mode: 0o700 }); } catch { throw new Error("Knowledge store is busy"); }
    try { return fn(); } finally { rmSync(lock, { recursive: true, force: true }); }
  }
  private events(): KnowledgeEvent[] {
    this.checkDirectory(false);
    let files: string[]; try { files = readdirSync(this.directory).filter(x => /^\d{16}-.+\.json$/.test(x)).sort(); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    if (files.length > 100_000) throw new Error("Knowledge store exceeds read bound");
    return files.map(file => {
      const path = join(this.directory, file);
      const st = lstatSync(path);
      if (!st.isFile() || st.isSymbolicLink()) throw new Error("Unsafe knowledge event");
      const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const opened = fstatSync(fd);
        if (!opened.isFile() || opened.size > MAX_EVENT_BYTES) throw new Error("Unsafe or oversized knowledge event");
        const buffer = Buffer.alloc(opened.size + 1);
        let size = 0, count = 0;
        while (size < buffer.length && (count = readSync(fd, buffer, size, buffer.length - size, null)) > 0) size += count;
        if (size > opened.size) throw new Error("Knowledge event changed during read");
        const event = validateEvent(JSON.parse(buffer.subarray(0, size).toString("utf8")));
        if (event.record.scope !== this.scope) throw new Error("Knowledge event scope mismatch");
        return event;
      } finally { closeSync(fd); }
    });
  }
  private current(): Map<string, KnowledgeRecord> {
    const out = new Map<string, KnowledgeRecord>();
    for (const event of this.events()) if (event.record.scope === this.scope && event.record.namespace === this.namespace) out.set(event.record.id, event.record);
    return out;
  }
  put(input: KnowledgeInput): KnowledgeRecord {
    if (input.id !== undefined) requireId(input.id);
    if (this.scope === "global" && !this.options.allowGlobal) throw new Error("Global knowledge mutation requires explicit approval");
    return this.lock(() => {
      const text = clean(input.text); if (!text || text.length > MAX_TEXT) throw new Error("Knowledge text must contain 1–20000 characters");
      const evidence = (input.evidence ?? []).map(e => ({ ref: clean(e.ref), ...(e.quote ? { quote: clean(e.quote) } : {}) }));
      if (input.status === "verified" && evidence.length === 0) throw new Error("Verified knowledge requires evidence");
      const records = this.current(), same = [...records.values()].find(r => !r.deleted && r.text === text && r.status === (input.status ?? "candidate") && r.kind === (input.kind ?? "fact"));
      if (same && !input.id) return same;
      const old = input.id ? records.get(input.id) : undefined;
      if (old?.deleted) throw new Error("Cannot resurrect tombstoned knowledge");
      if (old && input.expectedRevision !== old.revision) throw new Error("Expected revision does not match");
      if (!old && input.expectedRevision) throw new Error("Expected revision does not match");
      const now = new Date().toISOString(), record: KnowledgeRecord = { id: input.id ?? randomUUID(), revision: "", text, tags: [...new Set((input.tags ?? []).map(clean).filter(Boolean))].slice(0, 64), namespace: this.namespace, status: input.status ?? "candidate", kind: input.kind ?? "fact", evidence: evidence.slice(0, MAX_EVIDENCE), source: clean(input.source ?? "explicit"), scope: this.scope, createdAt: old?.createdAt ?? now, updatedAt: now, ...(old?.deleted ? {} : {}) };
      const revision = digest(JSON.stringify({ ...record, revision: old?.revision ?? "" })); record.revision = revision;
      this.append({ type: "put", record, revision, at: now }); return record;
    });
  }
  delete(id: string, expectedRevision: string): void { requireId(id); if (this.scope === "global" && !this.options.allowGlobal) throw new Error("Global knowledge mutation requires explicit approval"); this.lock(() => { const old = this.current().get(id); if (!old || old.deleted || old.revision !== expectedRevision) throw new Error("Expected revision does not match"); const now = new Date().toISOString(), revision = digest(id + now); this.append({ type: "tombstone", record: { ...old, deleted: true, updatedAt: now, revision }, revision, at: now }); }); }
  private append(event: KnowledgeEvent) { validateEvent(event); requireId(event.record.id); const count = this.events().length; const file = join(this.directory, `${String(count).padStart(16, "0")}-${event.record.id}.json`), tmp = `${file}.${randomUUID()}.tmp`; writeFileSync(tmp, JSON.stringify(event), { flag: "wx", mode: 0o600 }); renameSync(tmp, file); }
  read(id: string): KnowledgeRecord | undefined { requireId(id); const record = this.current().get(id); return record && !record.deleted ? record : undefined; }
  /** Capture one consistent projection of the event log. Callers may paginate
   * this array without rereading (and potentially mixing) later events. */
  snapshot(): KnowledgeRecord[] { return [...this.current().values()]; }
  page(snapshot: readonly KnowledgeRecord[], offset = 0, limit = 50): KnowledgeRecord[] {
    const start = Math.max(0, offset), count = Math.max(0, limit);
    return snapshot.filter(x => !x.deleted).slice(start, start + count);
  }
  listPage(snapshot: readonly KnowledgeRecord[], offset = 0, limit = 50): KnowledgeRecord[] { return this.page(snapshot, offset, limit); }
  list(limit = 50): KnowledgeRecord[] { return [...this.current().values()].filter(x => !x.deleted).slice(0, Math.min(MAX_READ, Math.max(0, limit))); }
  sources(limit = 50): PageIndexSource[] { return this.list(limit).map(r => ({ id: r.id, title: r.text.slice(0, 100), section: r.kind, text: r.text, revision: r.revision, status: r.status, evidence: r.evidence })); }
  readSource(id: string, maxChars = 4000): PageIndexSource | undefined { const r = this.read(id); return r && { id: r.id, title: r.text.slice(0, 100), section: r.kind, text: r.text.slice(0, Math.max(0, Math.min(maxChars, 20_000))), revision: r.revision, status: r.status, evidence: r.evidence }; }
}
export function openKnowledgeStore(options: StoreOptions): KnowledgeStore { return new KnowledgeStore(options); }
