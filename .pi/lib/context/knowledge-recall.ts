import { openKnowledgeStore, type KnowledgeRecord } from "../state/knowledge-store.ts";
import { type SharedScope } from "../state/shared-memory.ts";
import { ContextIndex } from "./page-index-memory.ts";
import { RetrievalSession } from "./context-retrieval.ts";

/** A request-local projection. Durable records remain authoritative; the tree is
 * rebuilt from verified revisions and cannot resurrect deleted/candidate facts.
 * Each scoped record has its own source; no cross-project source is enumerated.
 */
export function recallKnowledge(cwd: string, query: string, options: {
  root?: string; namespace?: string; scopes?: SharedScope[]; limit?: number;
} = {}) {
  const namespace = options.namespace ?? "default";
  const scope = { namespace, workspace: cwd, session: "knowledge-projection" };
  const index = new ContextIndex();
  const origins = new Map<string, KnowledgeRecord>();
  let candidatesExcluded = 0;
  let scannedRecords = 0;
  const scannedScopes: SharedScope[] = [];
  try {
    for (const selected of options.scopes ?? ["repository", "worktree", "global"]) {
      const store = openKnowledgeStore({ cwd, root: options.root, scope: selected, namespace });
      scannedScopes.push(selected);
      for (const record of store.snapshot()) {
        scannedRecords++;
        if (record.deleted) continue;
        if (record.status !== "verified") { candidatesExcluded++; continue; }
        const source = index.index(`${selected}/${record.id}`, `# ${record.kind}\n${record.text}`, scope);
        origins.set(source.data.id, record);
      }
    }
    const count = Math.max(0, Math.min(8, options.limit ?? 8));
    const matches = index.retrieve(query, scope, count);
    const reader = new RetrievalSession(index, scope, { maxReads: 8, maxChars: 9600 });
    reader.outline();
    const memories = matches.flatMap(match => reader.read(match.citation.sourceId, [match.citation.nodeId]).evidence.map(item => {
      const origin = origins.get(item.citation.sourceId)!;
      return {
        id: `knowledge:${origin.scope}:${origin.id}:${origin.revision}:${item.citation.nodeId}`,
        text: item.excerpt.slice(0, 1200), scope: origin.scope, tags: origin.tags,
        source: origin.source, evidenceRefs: origin.evidence, revision: origin.revision,
        updatedAt: origin.updatedAt, citation: item.citation, untrusted: true,
      };
    }));
    return { status: origins.size === 0 ? "empty" as const : memories.length ? "ok" as const : "no-match" as const,
      memories, candidatesExcluded, scannedScopes, scannedRecords, scanned: scannedRecords, sourceLimitPerScope: null, untrusted: true };
  } catch {
    // Do not turn a corrupt/unreadable store into an apparently empty index, or
    // expose arbitrary persisted contents through a parse error message.
    return { status: "unavailable" as const, memories: [], candidatesExcluded, scannedScopes, scannedRecords, scanned: scannedRecords, sourceLimitPerScope: null, untrusted: true };
  }
}
