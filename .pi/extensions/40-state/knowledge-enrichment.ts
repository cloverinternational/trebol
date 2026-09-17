import { captureEvidence, knowledgeCapturePrompt, parseKnowledgeCandidates } from "../../lib/context/knowledge-capture.ts";
import { consultWithPi } from "../../lib/context/context-consult.ts";
import { openKnowledgeStore } from "../../lib/state/knowledge-store.ts";

export const ENRICHMENT_ENTRY = "pi-swarm-knowledge-enrichment";
const registered = new WeakSet<object>();

/** Candidate capture only: the model cannot self-certify its extraction.
 * No wake-up turns, global writes, or automatic rewriting of existing facts.
 */
export default function knowledgeEnrichment(pi: any): void {
  if (registered.has(pi)) return;
  registered.add(pi);
  let generation = 0;
  let cursor: string | undefined;
  let busy: Promise<void> | undefined;
  let controller: AbortController | undefined;
  let enabled = process.env.PI_SWARM_MEMORY_CAPTURE !== "off";
  let status = "idle";
  const invalidate = () => { generation++; controller?.abort(); controller = undefined; busy = undefined; };
  pi.on("session_start", (_event: unknown, ctx: any) => {
    invalidate(); cursor = undefined; status = "idle";
    const entries = ctx.sessionManager?.getBranch?.() ?? ctx.sessionManager?.getEntries?.() ?? [];
    const saved = [...entries].reverse().find((entry: any) => entry.type === "custom" && entry.customType === ENRICHMENT_ENTRY && entry.data?.version === 1);
    if (typeof saved?.data?.cursor === "string") cursor = saved.data.cursor;
  });
  pi.on("session_shutdown", invalidate);
  pi.registerCommand("memory-capture", {
    description: "Memory candidate capture: on|off|status (session setting)",
    handler: async (args: string, ctx: any) => {
      const action = args.trim() || "status";
      if (action === "on") enabled = true;
      else if (action === "off") { enabled = false; invalidate(); }
      else if (action !== "status") { ctx.ui?.notify?.("Usage: /memory-capture on|off|status", "warning"); return; }
      ctx.ui?.notify?.(`Memory capture ${enabled ? "on" : "off"}; ${status}. Extracted knowledge remains candidate until verified.`, "info");
    },
  });
  const run = (ctx: any): Promise<void> => {
    if (!enabled || process.env.PI_SWARM_SUBAGENT === "1") return Promise.resolve();
    if (busy) return busy;
    const ownGeneration = generation;
    const ownController = new AbortController(); controller = ownController;
    const job = async () => {
      try {
        const entries = ctx.sessionManager?.getBranch?.() ?? ctx.sessionManager?.getEntries?.() ?? [];
        const batch = captureEvidence(entries, cursor);
        if (batch.status === "cursor-missing") { status = "cursor-missing: capture paused"; return; }
        if (!batch.evidence.length) return;
        status = "extracting";
        const response = await consultWithPi(pi, { prompt: knowledgeCapturePrompt(batch.evidence), cwd: ctx.cwd, model: ctx.model, signal: ownController.signal, generation: ownGeneration, currentGeneration: () => generation });
        if (response.status !== "completed") { if (generation === ownGeneration) status = response.status; return; }
        const candidates = parseKnowledgeCandidates(JSON.stringify(response.value), batch.evidence);
        if (ownController.signal.aborted || generation !== ownGeneration) return;
        const session = String(ctx.sessionManager?.getSessionFile?.() ?? "session");
        for (const candidate of candidates) {
          // Do not persist large raw evidence excerpts; IDs resolve back to the
          // original transcript. Partial retries deduplicate identical facts.
          openKnowledgeStore({ cwd: ctx.cwd, scope: candidate.scope }).put({
            text: candidate.text, tags: [candidate.title], status: "candidate",
            evidence: candidate.evidenceIds.map(id => ({ ref: `${session}#${id}` })), source: "lifecycle-extraction",
          });
        }
        pi.appendEntry(ENRICHMENT_ENTRY, { version: 1, cursor: batch.cursor, candidateCount: candidates.length });
        cursor = batch.cursor; status = candidates.length ? `captured ${candidates.length} candidates` : "no new knowledge";
      } catch { if (generation === ownGeneration) status = "capture-failed: retryable"; }
    };
    const promise = job().finally(() => { if (generation === ownGeneration) { busy = undefined; controller = undefined; } });
    busy = promise; return promise;
  };
  // Awaiting keeps persistence ordered before shutdown/compaction; the isolated
  // consultation has a timeout. This can add latency, never a new agent turn.
  pi.on("agent_end", (_event: unknown, ctx: any) => run(ctx));
  pi.on("session_before_compact", (_event: unknown, ctx: any) => run(ctx));
}
