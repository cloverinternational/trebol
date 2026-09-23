import { onAgentSettled } from "../../lib/runtime/agent-settled.ts";
import { consultWithPi } from "../../lib/context/context-consult.ts";
import { loadSessionEvidence, reviewOneCandidate } from "../../lib/state/candidate-memory-review.ts";

export const CANDIDATE_REVIEW_ENTRY = "pi-swarm-candidate-memory-review";
const registered = new WeakSet<object>();

export default function candidateMemoryReview(pi: any, deps = { consult: consultWithPi }): void {
  if (registered.has(pi)) return;
  registered.add(pi);
  let generation = 0;
  let busy: Promise<void> | undefined;
  let controller: AbortController | undefined;
  let ctx: any;
  const attempted = new Set<string>();
  let model = process.env.PI_SWARM_MEMORY_REVIEW_MODEL || "clover-plexus/luna";
  const cancel = () => { generation++; controller?.abort(); controller = undefined; busy = undefined; };
  pi.on("session_start", (_event: unknown, next: any) => { cancel(); attempted.clear(); ctx = next; model = process.env.PI_SWARM_MEMORY_REVIEW_MODEL || "clover-plexus/luna"; });
  pi.on("session_switch", (_event: unknown, next: any) => { cancel(); attempted.clear(); ctx = next; });
  pi.on("session_before_switch", cancel);
  pi.on("session_before_fork", cancel);
  pi.on("session_shutdown", cancel);
  pi.registerCommand("memory-review", { description: "Review one pending candidate memory", handler: async (_args: string, commandCtx: any) => { ctx = commandCtx; await run(ctx); } });
  const run = (current: any): Promise<void> => {
    if (process.env.PI_SWARM_SUBAGENT === "1" || busy) return busy ?? Promise.resolve();
    ctx = current;
    const own = generation, ctrl = new AbortController(); controller = ctrl;
    const job = async () => {
      const [provider, id] = model.split("/");
      const resolved = provider && id ? current.modelRegistry?.find?.(provider, id) : undefined;
      const outcome = await reviewOneCandidate({ cwd: current.cwd, ctx: current, model: current.modelRegistry ? resolved : model,
        signal: ctrl.signal, generation: own, currentGeneration: () => generation,
        attempted, deps: { pi, consult: deps.consult, loadSource: (ref, sourceCtx) => loadSessionEvidence(ref, sourceCtx) } });
      if (own !== generation || ctrl.signal.aborted) return;
      pi.appendEntry(CANDIDATE_REVIEW_ENTRY, { version: 1, outcome });
    };
    const promise = job().catch(() => {}).finally(() => { if (generation === own) { busy = undefined; controller = undefined; } });
    busy = promise; return promise;
  };
  onAgentSettled(pi, (_event: unknown, settledCtx: any) => run(settledCtx));
}
