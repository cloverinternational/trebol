import { ContextIndex, type ContextCitation } from "./page-index-memory.ts";
import { RetrievalSession } from "./context-retrieval.ts";
import { openKnowledgeStore, redactKnowledge, type KnowledgeRecord } from "../state/knowledge-store.ts";
import type { SharedScope } from "../state/shared-memory.ts";

export const KNOWLEDGE_CANDIDATE_LIMIT = 12;
const STOP_WORDS = new Set(["about", "after", "answer", "are", "can", "candidate", "cite", "could", "does", "each", "evidence", "file", "find", "for", "from", "have", "how", "into", "its", "live", "memory", "must", "not", "question", "record", "result", "section", "should", "source", "that", "the", "their", "there", "this", "tool", "tools", "was", "were", "what", "when", "where", "which", "with", "would"]);
const words = (text: string) => [...new Set((text.toLocaleLowerCase().match(/[\p{L}\p{N}_.-]+/gu) ?? [])
  .map(word => word.replace(/^[._-]+|[._-]+$/g, "")).filter(word => word.length >= 3 && !STOP_WORDS.has(word)))];
const identifierQuery = (query: string) => /^[A-Za-z_$][A-Za-z0-9_.$-]{8,}$/.test(query.trim());
/** Task answers about the retrieval evaluation itself are not project facts.
 * Only suppress these narrowly identified TaskManage subjects for ordinary
 * topical lookup; a query explicitly about memory retrieval may inspect them. */
function isRetrievalEvaluation(record: KnowledgeRecord): boolean {
  if (!record.source.startsWith("taskmanage:")) return false;
  try {
    const task = JSON.parse(record.text);
    const subject = String(task?.subject ?? "").toLocaleLowerCase();
    const questionText = Array.isArray(task?.questions) ? task.questions.map((q: any) => String(q?.question ?? "")).join(" ").toLocaleLowerCase() : "";
    const evaluation = /(?:audit|assess|evaluate|evaluation|re-test|review|verify|relevance|discoverability|query calls|before\/after query)/;
    const retrieval = /(?:pageindex|memory_history|memory system|memory retrieval|candidate memory|context_search|retrieval)/;
    return (evaluation.test(subject) && retrieval.test(subject + " " + questionText)) ||
      (retrieval.test(subject) && /(?:calls|outputs|limits|failure|contract|boundary|ranking|selection)/.test(questionText));
  } catch { return false; }
}
const mechanismQuery = (query: string) => /\b(?:pageindex|memory_history|memory (?:retrieval|system|index)|candidate (?:memory|retrieval))\b/i.test(query);

/** Rank knowledge sections by distinctive query terms rather than generic
 * question words. Require evidence for multiple query concepts before an LLM
 * can see a card; a single common overlap is not a supported lead. */
function rankedSections(index: ContextIndex, scope: { namespace: string; workspace: string; session: string }, query: string, limit: number) {
  const terms = words(query);
  if (!terms.length) return [];
  const exactIdentifier = identifierQuery(query);
  const matches: Array<{ sourceId: string; nodeId: string; score: number; hits: number }> = [];
  const walk = (sourceId: string, nodes: ReturnType<ContextIndex["inspect"]>[number]["tree"]) => {
    for (const node of nodes) {
      const haystack = `${node.title}\n${node.text}`.toLocaleLowerCase();
      const hits = terms.filter(term => haystack.includes(term));
      // A parent contains all child prose; matching it duplicates the same
      // answer and can bury the precise question section in a tiny card budget.
      const answerless = /\bAnswer: unanswered\b/i.test(node.text);
      // One distinctive term is enough for an exact identifier query. A broad
      // question needs at least two independently present concepts.
      if (!node.children.length && !answerless && hits.length >= Math.min(2, terms.length) && hits.length / terms.length >= (exactIdentifier ? 0.3 : 0.6)) {
        const title = node.title.toLocaleLowerCase();
        matches.push({ sourceId, nodeId: node.nodeId, hits: hits.length,
          score: hits.reduce((score, term) => score + (title.includes(term) ? 2 : 1) + (term.length >= 12 ? 2 : 0), 0) / terms.length });
      }
      walk(sourceId, node.children);
    }
  };
  for (const source of index.inspect(scope)) walk(source.id, source.tree);
  return matches.sort((a, b) => b.score - a.score || b.hits - a.hits).slice(0, limit);
}

/** Render task Q&A as natural sections instead of indexing its JSON blob.
 * A candidate remains a lead; status and original evidence remain attached. */
export function knowledgeMarkdown(record: KnowledgeRecord): string {
  let task: any;
  if (record.source.startsWith("taskmanage:")) {
    try { task = JSON.parse(record.text); } catch { /* use ordinary record */ }
  }
  if (task && typeof task.subject === "string" && Array.isArray(task.questions)) {
    const lines = [`# ${redactKnowledge(task.subject).slice(0, 200)}`,
      `TaskManage task ${String(task.taskId ?? "")} · ${record.status} · ${record.scope} · revision ${record.revision}`,
      redactKnowledge(String(task.description ?? "")).slice(0, 900)];
    for (const question of task.questions.slice(0, 12)) {
      if (typeof question?.question !== "string") continue;
      lines.push(`## ${redactKnowledge(question.question).slice(0, 240)}`,
        `Question ID: ${String(question.id ?? "")}`,
        `Answer: ${question.answer == null ? "unanswered" : redactKnowledge(String(question.answer)).slice(0, 1000)}`,
        `Evidence: ${question.evidence == null ? "none" : redactKnowledge(String(question.evidence)).slice(0, 512)}`);
    }
    return lines.join("\n");
  }
  return `# ${record.kind}\n${redactKnowledge(record.text)}`;
}

/** Read-only request projection; the canonical KnowledgeStore still owns all
 * writes, revisions, scope, and status. No record is promoted by indexing. */
export function projectKnowledge(cwd: string, options: {
  root?: string; namespace?: string; scopes?: SharedScope[]; status?: "candidate" | "verified";
} = {}) {
  const namespace = options.namespace ?? "default";
  const scope = { namespace, workspace: cwd, session: "knowledge-pageindex" };
  const index = new ContextIndex();
  const origins = new Map<string, KnowledgeRecord>();
  for (const selected of options.scopes ?? ["repository", "worktree", "global"]) {
    const store = openKnowledgeStore({ cwd, root: options.root, scope: selected, namespace });
    for (const record of store.snapshot()) {
      if (record.deleted || options.status && record.status !== options.status) continue;
      const markdown = knowledgeMarkdown(record);
      const source = index.index(`${selected}/${record.id}@${record.revision}`, markdown, scope);
      origins.set(source.data.id, record);
    }
  }
  return { index, scope, origins };
}

export function searchKnowledgeTree(cwd: string, query: string, options: {
  root?: string; namespace?: string; scopes?: SharedScope[]; status?: "candidate" | "verified";
  limit?: number; excludeMeta?: boolean;
} = {}) {
  const { index, scope, origins } = projectKnowledge(cwd, options);
  const count = Math.min(KNOWLEDGE_CANDIDATE_LIMIT, Math.max(0, options.limit ?? 5));
  const matches = rankedSections(index, scope, query, KNOWLEDGE_CANDIDATE_LIMIT)
    .filter(match => !options.excludeMeta || mechanismQuery(query) || !isRetrievalEvaluation(origins.get(match.sourceId)!)).slice(0, count);
  const reader = new RetrievalSession(index, scope, { maxReads: KNOWLEDGE_CANDIDATE_LIMIT, maxChars: 14400 });
  reader.outline();
  const evidence = matches.flatMap(match => reader.read(match.sourceId, [match.nodeId]).evidence.map(item => {
    const record = origins.get(item.citation.sourceId)!;
    return { id: record.id, revision: record.revision, scope: record.scope, status: record.status,
      source: record.source, excerpt: item.excerpt, citation: item.citation as ContextCitation,
      evidence: record.evidence, untrusted: true };
  }));
  return { status: !origins.size ? "not-indexed" : evidence.length ? "ok" : "no-result",
    evidence, untrusted: true, scannedSources: origins.size };
}
