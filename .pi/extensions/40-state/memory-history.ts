import { MEMORY_KNOWLEDGE_GUIDANCE, MEMORY_SCOPE_GUIDANCE } from "../../lib/context/memory-guidance.ts";
import { createHash } from "node:crypto";
import { rememberShared, searchShared } from "../../lib/state/shared-memory.ts";
import { openKnowledgeStore, redactKnowledge, type EvidenceRef, type KnowledgeKind, type KnowledgeStatus } from "../../lib/state/knowledge-store.ts";
import { sharedMemoryRoot } from "../../lib/state/shared-memory.ts";
import { promoteGlobalKnowledge } from "../../lib/state/knowledge-promotion.ts";
import { withDefaultToolRenderer } from "../../../packages/runtime/core/src/tool-renderer.ts";

export const MEMORY_ENTRY_TYPE = "pi-swarm-memory";
export const MEMORY_VERSION = 1;

export interface MemoryScope {
  namespace: string;
  workspace: string;
  session: string;
}

export interface MemoryRecord {
  id: string;
  version: number;
  namespace: string;
  workspace: string;
  session: string;
  text: string;
  tags: string[];
  createdAt: string;
  source?: string;
}

export interface MemoryEntry {
  type: typeof MEMORY_ENTRY_TYPE;
  data: MemoryRecord;
}

const secretPatterns = [
  /(sk-[A-Za-z0-9_-]{12,})/g,
  /(gh[pousr]_[A-Za-z0-9_]{20,})/g,
  /(xai-[A-Za-z0-9_-]{12,})/g,
  /((?:api[_-]?key|token|secret|password)\s*[:=]\s*)([^\s,;]+)/gi,
  /(Bearer\s+)[A-Za-z0-9._~+\/-]{12,}/gi,
];

/** Redacts common credentials before memory is persisted or returned. */
export function redact(text: string): string {
  let result = String(text);
  result = result.replace(secretPatterns[0], "[REDACTED]");
  result = result.replace(secretPatterns[1], "[REDACTED]");
  result = result.replace(secretPatterns[2], "[REDACTED]");
  result = result.replace(secretPatterns[3], "$1[REDACTED]");
  return result.replace(secretPatterns[4], "$1[REDACTED]");
}

function normalize(value: string, fallback: string): string {
  const result = value.trim().replace(/[\\/]+/g, "/");
  return result || fallback;
}

export function scopeOf(input: Partial<MemoryScope> = {}, cwd = process.cwd()): MemoryScope {
  return {
    namespace: normalize(input.namespace ?? "default", "default"),
    workspace: normalize(input.workspace ?? cwd, cwd),
    session: normalize(input.session ?? "current", "current"),
  };
}

function sameScope(a: MemoryScope, b: MemoryScope): boolean {
  return a.namespace === b.namespace && a.workspace === b.workspace && a.session === b.session;
}

function stableId(scope: MemoryScope, text: string, createdAt: string): string {
  return createHash("sha256").update(JSON.stringify([scope, text, createdAt])).digest("hex").slice(0, 24);
}

export class MemoryHistory {
  private records: MemoryRecord[] = [];
  constructor(private readonly now: () => Date = () => new Date()) {}

  /** Imports durable Pi entries. Unknown versions are ignored rather than guessed. */
  load(entries: unknown[]): void {
    this.records = entries.flatMap((entry: any) => {
      const data = entry?.type === MEMORY_ENTRY_TYPE ? entry.data : undefined;
      if (!data || data.version !== MEMORY_VERSION || typeof data.text !== "string") return [];
      return [{ ...data, text: redact(data.text), tags: Array.isArray(data.tags) ? data.tags.map(String) : [] }];
    });
  }

  remember(text: string, scopeInput: Partial<MemoryScope>, tags: string[] = [], source?: string): MemoryEntry {
    const scope = scopeOf(scopeInput);
    const clean = redact(text).trim();
    if (!clean) throw new Error("Memory text must not be empty");
    const createdAt = this.now().toISOString();
    const data: MemoryRecord = { id: stableId(scope, clean, createdAt), version: MEMORY_VERSION, ...scope, text: clean, tags: [...new Set(tags.map(String).filter(Boolean))], createdAt, ...(source ? { source: redact(source) } : {}) };
    this.records.push(data);
    return { type: MEMORY_ENTRY_TYPE, data };
  }

  search(query: string, scopeInput: Partial<MemoryScope>, limit = 20): MemoryRecord[] {
    const scope = scopeOf(scopeInput);
    const q = query.trim().toLocaleLowerCase();
    return this.records.filter(record => sameScope(record, scope) && (!q || `${record.text} ${record.tags.join(" ")}`.toLocaleLowerCase().includes(q))).slice(-Math.max(0, limit)).reverse();
  }

  replay(scopeInput: Partial<MemoryScope>): MemoryRecord[] { return this.search("", scopeInput, Number.MAX_SAFE_INTEGER).reverse(); }
  all(): MemoryRecord[] { return this.records.map(record => ({ ...record, tags: [...record.tags] })); }

  /** Converts older unversioned memory records into the current schema. */
  migrate(entries: unknown[], scopeInput: Partial<MemoryScope>): MemoryEntry[] {
    const scope = scopeOf(scopeInput);
    return entries.flatMap((entry: any) => {
      const old = entry?.type === "memory" ? entry.data ?? entry : entry?.memory;
      if (!old || typeof old.text !== "string") return [];
      const clean = redact(old.text).trim();
      if (!clean) return [];
      const createdAt = typeof old.createdAt === "string" ? old.createdAt : this.now().toISOString();
      const data: MemoryRecord = { id: stableId(scope, clean, createdAt), version: MEMORY_VERSION, ...scope, text: clean, tags: Array.isArray(old.tags) ? old.tags.map(String) : [], createdAt, source: "migration" };
      return [{ type: MEMORY_ENTRY_TYPE as typeof MEMORY_ENTRY_TYPE, data }];
    });
  }
}

const schema = { type: "object", required: ["operation"], additionalProperties: false, properties: { operation: { type: "string", enum: ["remember", "search", "replay", "migrate", "correct", "delete", "get"] }, text: { type: "string" }, query: { type: "string" }, tags: { type: "array", items: { type: "string" } }, evidence: { type: "array", items: { type: "object", required: ["ref"], additionalProperties: false, properties: { ref: { type: "string" }, quote: { type: "string" } } } }, status: { type: "string", enum: ["candidate", "verified"] }, kind: { type: "string", enum: ["fact", "decision", "process", "context"] }, source: { type: "string" }, id: { type: "string" }, expectedRevision: { type: "string" }, namespace: { type: "string" }, limit: { type: "number" } } } as const;

export default function memoryHistoryExtension(pi: any): void {
  const history = new MemoryHistory();
  let cwd = process.cwd();
  let scope = scopeOf();
  let sessionEntries: unknown[] = [];
  let generation = 0;
  pi.on?.("session_start", (_event: any, ctx: any) => {
    generation++;
    cwd = ctx?.cwd ?? process.cwd();
    const session = ctx?.sessionManager?.getSessionFile?.() ?? ctx?.sessionManager?.sessionFile ?? "current";
    scope = scopeOf({ workspace: cwd, session: String(session) }, cwd);
    sessionEntries = ctx?.sessionManager?.getEntries?.() ?? [];
    history.load(sessionEntries.map((e: any) => e.type === "custom" ? { type: e.customType, data: e.data } : e));
  });
  pi.on?.("session_shutdown", () => { generation++; });
  pi.registerCommand?.("memory-promote", {
    description: "Review and explicitly promote verified project knowledge: repository|worktree ID [namespace]",
    handler: async (args: string, ctx: any) => {
      const ownGeneration = generation;
      try {
        const [selected, id, namespace, ...extra] = args.trim().split(/\s+/);
        if (!["repository", "worktree"].includes(selected) || !id || extra.length) throw new Error("Usage: /memory-promote repository|worktree ID [namespace]");
        if (!ctx.hasUI || typeof ctx.ui?.confirm !== "function") throw new Error("Global promotion requires interactive confirmation; no write performed");
        const result = await promoteGlobalKnowledge({ cwd: ctx.cwd, scope: selected as "repository" | "worktree", id, namespace,
          confirm: (title, body) => ctx.ui.confirm(title, body), isCurrent: () => ownGeneration === generation });
        if (ownGeneration === generation) ctx.ui.notify(result.status === "promoted" ? `Global knowledge saved: ${result.record.id}` : "Promotion declined; no write performed", "info");
      } catch (error) { if (ownGeneration === generation) ctx.ui?.notify?.(error instanceof Error ? error.message : "Promotion failed", "warning"); }
    },
  });
  pi.registerTool?.(withDefaultToolRenderer({ name: "memory_history", label: "Memory History", description: `Recall and enrich durable redacted memory. ${MEMORY_KNOWLEDGE_GUIDANCE} ${MEMORY_SCOPE_GUIDANCE} Search before saving to avoid duplicates. Include evidence references; exclude secrets and raw transcripts. Defaults to repository scope. Search scope all includes repository/worktree/global. Use search with status candidate to find pending knowledge, then get by id to inspect its full evidence. Review source evidence and later corrections before using correct to mark a candidate verified; leave unsupported claims pending. Writes default to candidate; verified records require evidence references (verification is an attributed claim, not automatic proof). correct/delete require id and expectedRevision. Agent tool calls cannot write global memory. Ask the user to review an existing verified record with /memory-promote repository|worktree ID [namespace]; global reads remain available.`, parameters: { ...schema, properties: { ...schema.properties, scope: { type: "string", enum: ["repository", "worktree", "global", "session", "all"] } } }, async execute(_id: string, params: any) {
    try {
      if (!["remember", "search", "replay", "migrate", "correct", "delete", "get"].includes(params.operation)) throw new Error("Unknown memory operation");
      const selectedScope = params.scope ?? "repository";
      if (!["repository", "worktree", "global", "session", "all"].includes(selectedScope)) throw new Error("Invalid memory scope");
      if (selectedScope === "session" && ["correct", "delete", "get"].includes(params.operation)) throw new Error("Legacy session memory does not support correction/deletion; use scoped knowledge records");
      if (params.operation === "correct" && (!params.id || !params.expectedRevision)) throw new Error("correct requires id and expectedRevision");
      const limit = params.limit === undefined ? 20 : params.limit;
      if (!Number.isInteger(limit) || limit < 0 || limit > 100) throw new Error("limit must be an integer from 0 to 100");
      if (selectedScope !== "session" && params.operation !== "migrate") {
        if (["remember", "correct", "delete"].includes(params.operation) && selectedScope === "all") throw new Error("Choose a single write scope");
        const scopes = selectedScope === "all" ? ["repository", "worktree", "global"] as const : [selectedScope] as const;
        const namespace = params.namespace ?? "default";
        if (params.operation === "get") {
          if (!params.id || selectedScope === "all") throw new Error("get requires id and one scope");
          const record = openKnowledgeStore({ cwd, scope: selectedScope, namespace }).read(params.id);
          return { content: [{ type: "text", text: JSON.stringify({ knowledge: record ? [record] : [], legacy: [],
            review: record?.status === "candidate" ? "Inspect cited evidence and later corrections before deciding. Confirm project knowledge rather than procedural advice. If supported, correct this exact id/revision with status verified and evidence; otherwise leave candidate or delete with revision. Do not certify from the extraction alone." : undefined }) }], details: {} };
        }
        const storeRecords = scopes.flatMap((storeScope) => openKnowledgeStore({ cwd, scope: storeScope, root: sharedMemoryRoot(), namespace }).list(100));
        const query = String(params.operation === "replay" ? "" : params.query ?? "").trim().toLocaleLowerCase();
        const knowledge = storeRecords.filter(record => (!params.status || record.status === params.status) && (!query || `${record.text} ${record.tags.join(" ")}`.toLocaleLowerCase().includes(query)));
        if (["remember", "correct"].includes(params.operation)) {
          const store = openKnowledgeStore({ cwd, scope: selectedScope, root: sharedMemoryRoot(), namespace });
          if (params.operation === "correct" && !store.read(params.id)) throw new Error("Cannot correct an unknown knowledge record");
          const evidence: EvidenceRef[] = Array.isArray(params.evidence) ? params.evidence.map((item: any) => ({ ref: redactKnowledge(String(item?.ref ?? "")), ...(item?.quote ? { quote: redactKnowledge(String(item.quote)) } : {}) })) : [];
          const record = store.put({ id: params.id || undefined, expectedRevision: params.expectedRevision || undefined, text: redactKnowledge(params.text ?? ""), tags: (params.tags ?? []).map((s: string) => redactKnowledge(String(s))), evidence, status: (params.status ?? "candidate") as KnowledgeStatus, kind: (params.kind ?? "fact") as KnowledgeKind, source: redactKnowledge(params.source ?? "memory_history") });
          return { content: [{ type: "text", text: JSON.stringify({ knowledge: [record], legacy: [] }) }], details: {} };
        }
        if (params.operation === "delete") {
          if (!params.id || !params.expectedRevision) throw new Error("delete requires id and expectedRevision");
          openKnowledgeStore({ cwd, scope: selectedScope, root: sharedMemoryRoot(), namespace }).delete(params.id, params.expectedRevision);
          return { content: [{ type: "text", text: JSON.stringify({ knowledge: [], legacy: [] }) }], details: {} };
        }
        const legacy = searchShared(cwd, params.operation === "replay" ? "" : params.query ?? "", scopes as any, limit, namespace).map(record => ({ ...record, status: "unverified", verified: false, source: "legacy-shared-memory" }));
        return { content: [{ type: "text", text: JSON.stringify({ knowledge: knowledge.slice(0, limit), legacy, scanLimitPerScope: 100 }) }], details: {} };
      }
      if (params.operation === "remember") {
        const entry = history.remember(params.text ?? "", { ...scope, namespace: params.namespace ?? scope.namespace }, params.tags ?? [], "memory_history");
        pi.appendEntry?.(MEMORY_ENTRY_TYPE, entry.data);
        return { content: [{ type: "text", text: JSON.stringify(entry.data) }], details: {} };
      }
      const requested = { ...scope, namespace: params.namespace ?? scope.namespace };
      if (params.operation === "migrate") {
        const migrated = history.migrate(sessionEntries, requested);
        for (const entry of migrated) pi.appendEntry?.(MEMORY_ENTRY_TYPE, entry.data);
        return { content: [{ type: "text", text: JSON.stringify(migrated) }], details: {} };
      }
      const result = params.operation === "replay" ? history.replay(requested) : history.search(params.query ?? "", requested, params.limit ?? 20);
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: {} };
    } catch (error) { return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true, details: {} }; }
  } }));
}
