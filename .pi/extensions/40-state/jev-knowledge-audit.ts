import { executionLog } from "../../lib/context/execution-log.ts";
import { registerSupervisorAdapter } from "../../lib/context/supervisor-control.ts";
import { loadSupervisorSettings, type SupervisorSettings } from "../../lib/context/supervisor-settings.ts";
import { resolveJevCredential } from "../../lib/context/jev-credential.ts";
import { observeSupervisorTool, observeSupervisorCompletion, resetSupervisorInput, readSupervisorLiveState, clearSupervisorLiveState } from "../../lib/context/supervisor-live-state.ts";
import { collectSupervisorState } from "../../lib/context/jev-operational-supervisor.ts";
import { dispatchMemoryMaintenance } from "../../lib/context/memory-maintenance-bridge.ts";
import { createHash } from "node:crypto";
import { auditWithJev, collectJevEvidence, renderJevReview } from "../../lib/context/jev-knowledge-audit.ts";
import { redactContext } from "../../lib/context/page-index-memory.ts";
import { jevAuditEnabled, setJevAuditEnabled, bindJevAuditMode } from "../../lib/context/jev-audit-mode.ts";
import { onAgentSettled } from "../../lib/runtime/agent-settled.ts";

export const JEV_ENTRY = "pi-swarm-jev-audit";
export const JEV_REVIEW = "pi-swarm-jev-review";
const registered = new WeakSet<object>();
/** Jev reviews operational state only; memory candidate review is independent. */
export default function jevKnowledgeAudit(pi: any, deps = { audit: auditWithJev }): void {
  if (registered.has(pi)) return;
  registered.add(pi);
  let generation = 0, turns = 0, auditedAt = 0, attemptedAt = -1;
  let stopFingerprint: string | undefined;
  let config:SupervisorSettings|undefined,unregister:(()=>void)|undefined,credentialSource="unchecked";
  let goal="", supervisorOn=process.env.PI_SWARM_JEV_SUPERVISOR === "on";
  pi.on("before_agent_start",(event:any)=>{goal=redactContext(String(event.prompt??"")).slice(0,2000);});

  pi.on("tool_result",(e:any,ctx:any)=>observeSupervisorTool(ctx,e));
  pi.on("message_end",(e:any,ctx:any)=>{const m=e.message;if(m?.role==="custom")observeSupervisorCompletion(ctx,String(m.content??""));});
  pi.on("input",(e:any,ctx:any)=>{if(["interactive","rpc"].includes(e.source))resetSupervisorInput(ctx);});
  pi.on("session_shutdown",(_e:any,ctx:any)=>clearSupervisorLiveState(ctx));
  const cache = new Map<string, Awaited<ReturnType<typeof auditWithJev>>>();
  let cursor: string | undefined, pending: { id: string; content: string } | undefined;
  let delivered: string[] = [], status = "idle", busy: Promise<void> | undefined, controller: AbortController | undefined;
  const entries = (ctx: any): any[] => ctx.sessionManager?.getBranch?.() ?? ctx.sessionManager?.getEntries?.() ?? [];
  const save = () => pi.appendEntry(JEV_ENTRY, { version: 1, turns, auditedAt, cursor, pending, delivered: delivered.slice(-32), enabled: jevAuditEnabled(pi), status });
  const cancel = () => { generation++; controller?.abort(); controller = undefined; busy = undefined; };
  const restore = (_e: any, ctx: any) => {
    cancel(); bindJevAuditMode(pi,ctx); stopFingerprint = undefined; setJevAuditEnabled(pi, process.env.PI_SWARM_JEV_AUDIT === "on"); turns = 0; auditedAt = 0; attemptedAt = -1; cursor = undefined; pending = undefined; delivered = []; status = "idle";
    const prior = [...entries(ctx)].reverse().find(e => e.type === "custom" && e.customType === JEV_ENTRY && e.data?.version === 1)?.data;
    if (prior) {
      turns = Number.isSafeInteger(prior.turns) && prior.turns >= 0 ? prior.turns : 0;
      auditedAt = Number.isSafeInteger(prior.auditedAt) && prior.auditedAt >= 0 ? Math.min(turns, prior.auditedAt) : 0;
      cursor = typeof prior.cursor === "string" ? prior.cursor : undefined;
      delivered = Array.isArray(prior.delivered) ? prior.delivered.filter((x: any) => typeof x === "string").slice(-32) : [];
      if (typeof prior.pending?.id === "string" && typeof prior.pending.content === "string" && prior.pending.content.length <= 6000) pending = prior.pending;
      if (typeof prior.enabled === "boolean") setJevAuditEnabled(pi, prior.enabled);
    }
    config=loadSupervisorSettings(ctx.cwd).settings;
    supervisorOn=config.enabled&&config.operational;
    setJevAuditEnabled(pi,config.enabled&&config.audit);
    unregister?.();unregister=registerSupervisorAdapter(ctx,"audit",{
      apply(next){cancel();cache.clear();pending=undefined;config=next;credentialSource="unchecked";supervisorOn=next.enabled&&next.operational;setJevAuditEnabled(pi,next.enabled&&next.audit);status=next.enabled?"idle":"paused";save();},
      status:()=>({enabled:jevAuditEnabled(pi),status,turns,cadence:config?.cadence,pending:pending?1:0,credentialSource,operational:supervisorOn}),
      runNow:ctx=>run(ctx,true),
    });
  };
  pi.on("session_start", restore);
  pi.on("session_switch", restore);
  pi.on("session_fork", restore);
  pi.on("session_before_switch", cancel);
  pi.on("session_before_fork", cancel);
  pi.on("session_shutdown",()=>{cancel();unregister?.();});
  pi.on("session_compact", () => save());
  const child = () => process.env.PI_SWARM_SUBAGENT === "1";
  const run = (ctx: any, force = false): Promise<void> => {
    if (!jevAuditEnabled(pi) || child() || pending) return Promise.resolve();
    if (busy) return busy;
    if (!force && (turns - auditedAt < (config?.cadence??5) || attemptedAt === turns)) return Promise.resolve();
    attemptedAt = turns;
    
    const batch = collectJevEvidence(entries(ctx), cursor);
    if (batch.status === "cursor-missing") { status = "cursor-missing: review required"; return Promise.resolve(); }
    if (!batch.evidence.length) { cursor = batch.cursor; auditedAt = turns; status = "no-new-evidence"; save(); return Promise.resolve(); }
    const taskSnapshot=supervisorOn?((globalThis as any)[Symbol.for("pi-swarm-task-manager")]?.snapshot?.()?.tasks??[]):[];
    const supervisor=supervisorOn?collectSupervisorState(goal,taskSnapshot,readSupervisorLiveState(ctx).budget,readSupervisorLiveState(ctx).waiting):undefined;
    const own = generation, atTurn = turns, ctrl = new AbortController(); controller = ctrl;
    status = "auditing";
    executionLog(ctx.cwd,"jev","audit-start",{turn:atTurn,evidenceCount:batch.evidence.length});
    const job = async () => {
      try {
        const credential=await resolveJevCredential({config,registry:ctx.modelRegistry});
        if(own!==generation||ctrl.signal.aborted)return;
        credentialSource=credential?.source??"missing";
        if(!credential){executionLog(ctx.cwd,"jev","audit-missing-credential",{turn:atTurn});status="missing-key: set TYPESAFE_API_KEY or vault credential typesafe-api-key";return;}
        const cacheKey = createHash("sha256").update("jev-1.13.0:rubric-v1:" + JSON.stringify({evidence:batch.evidence,supervisor})).digest("hex");
        const result = cache.get(cacheKey) ?? await deps.audit(batch.evidence, { apiKey: credential.apiKey, signal: ctrl.signal, timeoutMs: 3000, supervisor });
        if (own !== generation || ctrl.signal.aborted || !jevAuditEnabled(pi)) return;
        cache.set(cacheKey, result); if (cache.size > 32) cache.delete(cache.keys().next().value!);
        executionLog(ctx.cwd,"jev","audit-result",{turn:atTurn,findingCount:result.findings.length});
        const operational=(result as any).operational;
        const operationalNote=operational && operational.reviewNeed!=="none" ? `\n[Operational review request — not a verdict] ${JSON.stringify({workState:operational.workState,reviewNeed:operational.reviewNeed,taskSnapshot:supervisor?.tasks})}\nIndependent reviewer: confirm, reject, or insufficient with cited source IDs. No auto-completion or permission changes.\n` : "";
        const rendered = renderJevReview(result.findings)+operationalNote;
        const sessionRef = redactContext(String(ctx.sessionManager?.getSessionFile?.() ?? "current-session")).slice(0,512);
        const content = rendered ? `Evidence session: ${sessionRef}; source IDs below refer to this session.\n${rendered}`.slice(0,6000) : "";
        if (content && !dispatchMemoryMaintenance(pi, content, ctx)) {
          const id = createHash("sha256").update(content).digest("hex");
          if (!delivered.includes(id)) pending = { id, content };
        }
        cursor = batch.cursor; auditedAt = atTurn; status = pending ? "review-pending" : "no-findings"; save();
      } catch { executionLog(ctx.cwd,"jev","audit-failed",{turn:atTurn}); if (own === generation) status = "audit-failed: retry-next-turn"; }
    };
    const promise = job().finally(() => { if (own === generation) { busy = undefined; controller = undefined; } }); busy = promise; return promise;
  };
  pi.on("turn_end", () => { if (!jevAuditEnabled(pi) || child()) return; turns++; save(); });
  pi.on("turn_start", (_e: any, ctx: any) => run(ctx));
  // Final evidence must not wait for a sixth turn that may never occur. One
  // bounded batch only; pending review/backlog remains explicit and no wakeup.
  onAgentSettled(pi, (_e: any, ctx: any) => {
    if(config?.stopAudit===false)return Promise.resolve();
    const last = [...entries(ctx)].reverse().find(e => e.type === "message")?.id;
    const fingerprint = `${turns}:${last ?? "empty"}`;
    if (fingerprint === stopFingerprint) return Promise.resolve();
    stopFingerprint = fingerprint;
    return run(ctx, true);
  });
  pi.on("context", (event: any) => {
    if (!jevAuditEnabled(pi) || child() || !pending) return;
    const review = pending;
    // Mark delivery before injection; no triggerTurn, no recursive conversation entry.
    delivered.push(review.id); pending = undefined; status = "review-delivered"; save();
    return { messages: [...event.messages, { role: "custom", customType: JEV_REVIEW, content: review.content, display: true, details: { reviewId: review.id, untrusted: true }, timestamp: Date.now() }] };
  });
}
