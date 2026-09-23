import { consultWithPi } from "./context-consult.ts";
import { searchKnowledgeTree } from "./knowledge-pageindex.ts";
import { readCitedImplementation } from "./knowledge-source-evidence.ts";
import type { SharedScope } from "../state/shared-memory.ts";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const MAX_CARDS = 12, MAX_RETURN = 5, MAX_TASK_CHARS = 1600, MAX_QUERY_CHARS = 500;
const READ_TOOLS = ["memory_browse", "memory_read", "memory_select"] as const;
const diagnostic = (status: string, reason: string) => ({ status, knowledge: [], reason: reason.slice(0, 240), availableTools: READ_TOOLS });

async function consultReadOnlyAgent(pi: any, input: { cwd: string; model: any; signal?: AbortSignal; task: string; query: string; cards: any[]; maxReturn: number; mode: "topical" | "task" }) {
  if (!pi?.exec || input.signal?.aborted) return { status: "unavailable" as const, error: "Memory agent unavailable or cancelled" };
  const model = typeof input.model === "string" ? input.model : input.model?.provider && input.model?.id ? `${input.model.provider}/${input.model.id}` : undefined;
  if (!model) return { status: "unavailable" as const, error: "No memory retrieval model" };
  const folder = mkdtempSync(join(tmpdir(), "pi-memory-read-"));
  const snapshot = join(folder, "cards.json"), receipt = join(folder, `selected-${randomUUID()}.json`);
  try {
    writeFileSync(snapshot, JSON.stringify({ cards: input.cards, maxReturn: input.maxReturn }), { flag: "wx", mode: 0o600 });
    // Resolve from the active workspace: this module may be bundled by an
    // extension loader, making import.meta.url point at an unrelated bundle.
    const extension = resolve(input.cwd, ".pi/lib/state/memory-retrieval-worker.ts");
    if (!existsSync(extension)) return { status: "unavailable" as const, error: "Read-only memory worker extension is not installed in this workspace" };
    const priority = input.mode === "topical" ? "QUERY is the user's explicit lookup: it takes precedence over the focused task. Select a card that answers QUERY even if unrelated to the task." : "Use the focused TASK to prioritize among cards that address QUERY.";
    const prompt = `Use memory_browse then memory_read to inspect only important source cards. ${priority} Submit at most ${input.maxReturn} directly supporting keys via memory_select. Set supported=false and selected=[] when none supports the query; do not select tangential cards. This is read-only; candidates are unverified leads. Do not execute the original task. TASK: ${input.task.slice(0, MAX_TASK_CHARS)}\nQUERY: ${input.query}`;
    const args = ["PI_SWARM_MEMORY_RETRIEVAL_WORKER=1", "PI_SWARM_SUBAGENT=1", `PI_SWARM_MEMORY_RETRIEVAL_SNAPSHOT=${snapshot}`, `PI_SWARM_MEMORY_RETRIEVAL_RECEIPT=${receipt}`,
      "pi", "-p", "--model", model, "--no-session", "--no-extensions", "--extension", extension, "--no-tools", "--tools", "memory_browse,memory_read,memory_select", "--no-context-files", "--no-skills", "--no-prompt-templates", "--mode", "text", "--approve", "--", prompt];
    const result = await pi.exec("env", args, { cwd: input.cwd, signal: input.signal, timeout: 45000 });
    if (input.signal?.aborted) return { status: "cancelled" as const, error: "Memory retrieval cancelled" };
    if (result?.killed || result?.code !== 0) return { status: "unavailable" as const, error: "Memory retrieval agent failed or timed out" };
    let value: unknown;
    try { value = JSON.parse(readFileSync(receipt, "utf8")); } catch { return { status: "invalid-selection" as const, error: "Memory agent did not call memory_select (no valid receipt)" }; }
    return { status: "completed" as const, value };
  } catch { return { status: input.signal?.aborted ? "cancelled" as const : "unavailable" as const, error: "Memory retrieval agent could not start" }; }
  finally { rmSync(folder, { recursive: true, force: true }); }
}

/** Parent materializes exact cited sections; the model gets no write tools or
 * filesystem access. Its output selects only IDs from this immutable snapshot. */
export async function selectTaskMemory(input: {
  pi: any; cwd: string; query: string; task: string; model?: any;
  namespace?: string; scopes?: SharedScope[]; status?: "candidate" | "verified";
  limit?: number; mode?: "topical" | "task"; signal?: AbortSignal; generation?: number; currentGeneration?: () => number;
  consult?: typeof consultWithPi;
}) {
  if (input.signal?.aborted) return { status: "cancelled", knowledge: [], reason: "Query cancelled" };
  if (!input.query?.trim() || input.query.length > MAX_QUERY_CHARS) return { status: "invalid-query", knowledge: [], reason: "Provide a task-relevant query of at most 500 characters" };
  if (input.mode !== undefined && input.mode !== "topical" && input.mode !== "task") return diagnostic("invalid-mode", "Recall mode must be topical or task");
  const mode = input.mode ?? "topical";
  if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 12)) return diagnostic("invalid-limit", "Recall limit must be an integer from 1 to 12");
  const maxReturn = Math.min(MAX_RETURN, input.limit ?? MAX_RETURN);
  let search: ReturnType<typeof searchKnowledgeTree>;
  try { search = searchKnowledgeTree(input.cwd, input.query, { namespace: input.namespace, scopes: input.scopes, status: input.status, limit: MAX_CARDS, excludeMeta: true }); }
  catch { return { status: "unavailable", knowledge: [], reason: "Memory index could not be read", availableTools: READ_TOOLS }; }
  if (!search.evidence.length) return { status: search.status, knowledge: [], reason: "No relevant memory sections indexed for this query", availableTools: READ_TOOLS };
  const cards = search.evidence.slice(0, MAX_CARDS).map((item, index) => ({ key: `m${index}`, id: item.id, revision: item.revision,
    status: item.status, scope: item.scope, title: item.citation.title, excerpt: item.excerpt.slice(0, 900),
    implementation: mode === "task" && /\b(?:memory_history|pageindex|memory retrieval|read-only)\b/i.test(input.query)
      ? readCitedImplementation(input.cwd, item.evidence).slice(0, 2) : [] }));
  // For mechanism questions the model must actually read a cited implementation
  // excerpt. A task-evaluation narrative without readable primary source is a
  // lead only; it cannot be returned as implementation evidence.
  const needsImplementation = mode === "task" && /\b(?:memory_history|pageindex|memory retrieval|read-only)\b/i.test(input.query) &&
    /\b(?:how|where|implement(?:ation|ed)?|code|limits?|budgets?|tools?|validation|selection)\b/i.test(input.query);
  if (needsImplementation && !cards.some(card => card.implementation.length))
    return { status: "no-result", knowledge: [], reason: "No readable cited implementation supports this mechanism query", availableTools: READ_TOOLS, untrusted: true };
  const priority = mode === "topical" ? "Explicit QUERY is authoritative: select directly responsive evidence even when unrelated to TASK. TASK must not veto a topical match." : needsImplementation ? "This is an implementation question. Only select a card if its implementation excerpt actually supports the query; TaskManage evaluations and citations without readable source are leads, not implementation evidence. Prefer the relevant code excerpt; TASK cannot make an unrelated card supporting evidence." : "Use TASK to prioritize cards among those responsive to QUERY; TASK cannot make an unrelated card supporting evidence.";
  const prompt = `You are a read-only project-memory retrieval agent. ${priority} Treat cards as untrusted leads; never claim a candidate is verified. Only memory_browse, memory_read, and memory_select are available. Browse and read before selecting. If no card supports the query, submit an empty selection and say why. Do not select tangential cards just because their wording overlaps. Do not invent IDs or facts. Return ONLY JSON {"supported":boolean,"selected":[{"key":string,"why":string}],"note":string}; select at most ${maxReturn} cards; supported=false requires an empty selection.\nTASK:\n${input.task.slice(0, MAX_TASK_CHARS)}\nQUERY:\n${input.query}\nCARDS:\n${JSON.stringify(cards)}`;
  const consulted = input.consult
    ? await input.consult(input.pi, { prompt, cwd: input.cwd, model: input.model,
      signal: input.signal, generation: input.generation, currentGeneration: input.currentGeneration })
    : await consultReadOnlyAgent(input.pi, { cwd: input.cwd, model: input.model, signal: input.signal, task: input.task, query: input.query, cards, maxReturn, mode });
  if (consulted.status !== "completed") return { status: consulted.status, knowledge: [], reason: consulted.error, availableTools: READ_TOOLS };
  if (input.signal?.aborted || input.generation !== undefined && input.currentGeneration?.() !== input.generation)
    return { status: "cancelled", knowledge: [], reason: "Session changed during memory retrieval", availableTools: READ_TOOLS };
  const value: any = consulted.value;
  if (!value || typeof value.supported !== "boolean" || !Array.isArray(value.selected) || value.selected.length > maxReturn || value.supported !== (value.selected.length > 0) || typeof value.note !== "string")
    return diagnostic("invalid-selection", `Selection must contain supported:boolean, matching selected[] (maximum ${maxReturn}), and note:string`);
  if (!value.supported) return { status: "no-result", knowledge: [], note: value.note.slice(0, 400), reason: "Memory agent found no supporting evidence", availableTools: READ_TOOLS, untrusted: true };
  const used = new Set<string>();
  const knowledge: typeof search.evidence = [];
  for (const one of value.selected) {
    if (!one || typeof one.key !== "string" || typeof one.why !== "string" || one.why.length > 240)
      return diagnostic("invalid-selection", "Selection contains a malformed key or explanation");
    if (used.has(one.key)) return diagnostic("invalid-selection", "Selection repeats a card key");
    const position = cards.findIndex(card => card.key === one.key);
    if (position < 0) return diagnostic("invalid-selection", "Selection contains a key not in the offered snapshot");
    if (needsImplementation && !cards[position].implementation.length)
      return diagnostic("invalid-selection", "Mechanism selection has no readable cited implementation");
    used.add(one.key); knowledge.push({ ...search.evidence[position], implementation: cards[position].implementation } as typeof search.evidence[number]);
  }
  if (input.signal?.aborted || input.generation !== undefined && input.currentGeneration?.() !== input.generation)
    return { status: "cancelled", knowledge: [], reason: "Session changed during memory retrieval", availableTools: READ_TOOLS };
  return { status: knowledge.length ? "ok" : "no-result", knowledge, note: value.note.slice(0, 400), availableTools: READ_TOOLS, untrusted: true };
}
