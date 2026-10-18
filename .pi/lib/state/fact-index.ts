/** Ranked retrieval over knowledge records: BM25 (any query term) fused with an
 * optional dense ranking by reciprocal rank fusion (k=60), as in project_context.
 * Dense vectors come from an OpenAI-compatible embeddings endpoint
 * (PI_SWARM_MEMORY_EMBED_URL, e.g. an ssh tunnel to the spark embeddinggemma
 * server; model PI_SWARM_MEMORY_EMBED_MODEL, default "embeddinggemma-2") and are
 * cached per record revision in `embeddings.jsonl` beside the store's events
 * (the store only reads `NNNN-*.json` event files). Embedding failure degrades
 * to BM25 and is reported, never thrown. */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { KnowledgeRecord } from "./knowledge-store.ts";

const TOKEN = /[\p{L}\p{N}_]+/gu;
const STOP = new Set("the a an and or of to in on for with is are was were be by as at it this that from how what where why when which who does do did not no can into via vs".split(" "));
export const tokenize = (s: string) => (s.toLocaleLowerCase().match(TOKEN) ?? []).flatMap(t => {
  const parts = t.split("_").filter(Boolean); return parts.length > 1 ? [t, ...parts] : [t];
}).filter(t => t.length > 1 && !STOP.has(t));
const docText = (r: KnowledgeRecord) => `${r.text} ${r.tags.join(" ")} ${r.evidence.map(e => e.ref).join(" ")}`;

export function bm25Rank(records: readonly KnowledgeRecord[], query: string, k1 = 1.2, b = 0.75): { id: string; score: number }[] {
  const q = [...new Set(tokenize(query))]; if (!q.length) return [];
  const docs = records.map(r => tokenize(docText(r))), avg = docs.reduce((n, d) => n + d.length, 0) / Math.max(1, docs.length);
  const df = new Map<string, number>(); for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1);
  return records.map((r, i) => {
    const tf = new Map<string, number>(); for (const t of docs[i]) tf.set(t, (tf.get(t) ?? 0) + 1);
    let score = 0;
    for (const t of q) { const f = tf.get(t); if (!f) continue; const n = df.get(t)!; score += Math.log(1 + (records.length - n + 0.5) / (n + 0.5)) * f * (k1 + 1) / (f + k1 * (1 - b + b * docs[i].length / avg)); }
    return { id: r.id, score };
  }).filter(x => x.score > 0).sort((x, y) => y.score - x.score);
}

export interface EmbedConfig { url: string; model: string; timeoutMs: number }
export function embedConfig(env: NodeJS.ProcessEnv = process.env): EmbedConfig | undefined {
  const url = env.PI_SWARM_MEMORY_EMBED_URL?.trim(); if (!url) return undefined;
  return { url: url.replace(/\/+$/, ""), model: env.PI_SWARM_MEMORY_EMBED_MODEL?.trim() || "embeddinggemma-2", timeoutMs: Number(env.PI_SWARM_MEMORY_EMBED_TIMEOUT_MS) || 8000 };
}
async function embed(cfg: EmbedConfig, model: string, input: string[], signal?: AbortSignal): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < input.length; i += 8) {
    const res = await fetch(`${cfg.url}/v1/embeddings`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model, input: input.slice(i, i + 8).map(s => s.slice(0, 6000)) }), signal: signal ?? AbortSignal.timeout(cfg.timeoutMs) });
    if (!res.ok) throw new Error(`embeddings ${res.status}`);
    const body = await res.json() as { data: { embedding: number[] }[] }; out.push(...body.data.map(d => d.embedding));
  }
  return out;
}
const cos = (a: number[], b: number[]) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

/** Vectors for records, reading/writing the per-directory revision cache. */
export async function recordVectors(cfg: EmbedConfig, groups: { directory: string; records: readonly KnowledgeRecord[] }[]): Promise<Map<string, number[]>> {
  const vectors = new Map<string, number[]>();
  for (const { directory, records } of groups) {
    const cache = new Map<string, number[]>(), file = join(directory, "embeddings.jsonl");
    if (existsSync(file)) for (const line of readFileSync(file, "utf8").split("\n")) { if (!line) continue; try { const x = JSON.parse(line); if (x.model === cfg.model) cache.set(x.revision, x.v); } catch { /* skip torn line */ } }
    const missing = records.filter(r => !cache.has(r.revision));
    if (missing.length) {
      const v = await embed(cfg, cfg.model, missing.map(r => r.text));
      if (existsSync(directory)) appendFileSync(file, missing.map((r, i) => JSON.stringify({ model: cfg.model, revision: r.revision, v: v[i] })).join("\n") + "\n", { mode: 0o600 });
      missing.forEach((r, i) => cache.set(r.revision, v[i]));
    }
    for (const r of records) vectors.set(r.id, cache.get(r.revision)!);
  }
  return vectors;
}

export interface RankedResult { ids: string[]; mode: "hybrid" | "bm25"; embedError?: string }
/** Exact-phrase matches first (prior behavior), then RRF of BM25 and dense ranks. */
export async function rankKnowledge(groups: { directory: string; records: readonly KnowledgeRecord[] }[], query: string, cfg = embedConfig()): Promise<RankedResult> {
  const records = groups.flatMap(g => g.records), q = query.trim().toLocaleLowerCase();
  const exact = records.filter(r => `${r.text} ${r.tags.join(" ")}`.toLocaleLowerCase().includes(q)).map(r => r.id);
  const lists: string[][] = [bm25Rank(records, query).map(x => x.id)];
  let mode: RankedResult["mode"] = "bm25", embedError: string | undefined;
  if (cfg && records.length) {
    try {
      const vectors = await recordVectors(cfg, groups), [qv] = await embed(cfg, `${cfg.model}:query`, [query]);
      lists.push(records.map(r => ({ id: r.id, s: cos(qv, vectors.get(r.id)!) })).sort((a, b) => b.s - a.s).slice(0, 100).map(x => x.id)); mode = "hybrid";
    } catch (error) { embedError = String((error as Error)?.message ?? error).slice(0, 200); }
  }
  const score = new Map<string, number>();
  for (const list of lists) list.forEach((id, i) => score.set(id, (score.get(id) ?? 0) + 1 / (60 + i + 1)));
  const fused = [...score.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id).filter(id => !exact.includes(id));
  return { ids: [...exact, ...fused], mode, ...(embedError ? { embedError } : {}) };
}
