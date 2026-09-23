import { registerSupervisorAdapter } from "../../lib/context/supervisor-control.ts";
import { loadSupervisorSettings, type SupervisorSettings } from "../../lib/context/supervisor-settings.ts";
import { applySupervisorTaskProposals } from "../../lib/context/supervisor-task-reconcile.ts";
import { collectSupervisorState, hashTaskSnapshot } from "../../lib/context/jev-operational-supervisor.ts";
import { createHash } from "node:crypto";
import { registerMemoryMaintenance, bindMemoryMaintenance, unregisterMemoryMaintenance } from "../../lib/context/memory-maintenance-bridge.ts";
import { runMemoryMaintenance } from "../../lib/context/memory-maintenance-runner.ts";
import { createMemoryQueryBudget } from "../../lib/context/memory-query-budget.ts";
import { jevAuditEnabled, bindJevAuditMode } from "../../lib/context/jev-audit-mode.ts";
import { onAgentSettled } from "../../lib/runtime/agent-settled.ts";
export const MAINTENANCE_ENTRY="pi-swarm-memory-maintenance";
const registered=new WeakSet<object>();
export default function memoryMaintenance(pi:any,deps={run:runMemoryMaintenance}) {
 if(registered.has(pi))return;registered.add(pi);
 let config:SupervisorSettings|undefined,unregister:(()=>void)|undefined;
 let enabled=false,generation=0,status="off",busy=false,controller:AbortController|undefined;
 let activeJob:Promise<void>|undefined;
 let queue:{id:string;content:string}[]=[],done:string[]=[],receipt:string|undefined,context:any;
 const budget=createMemoryQueryBudget();const child=()=>process.env.PI_SWARM_SUBAGENT==="1";
 const persist=()=>pi.appendEntry(MAINTENANCE_ENTRY,{version:1,enabled,status,queue,done:done.slice(-64),receipt,budget:budget.snapshot()});
 const cancel=()=>{generation++;controller?.abort();controller=undefined;busy=false;activeJob=undefined;};
 const restore=(_event:any,ctx:any)=>{
  cancel();context=ctx;bindJevAuditMode(pi,ctx);bindMemoryMaintenance(pi,ctx);enabled=false;queue=[];done=[];receipt=undefined;budget.newGoal();
  const prior=[...(ctx.sessionManager?.getBranch?.()??[])].reverse().find((e:any)=>e.customType===MAINTENANCE_ENTRY&&e.data?.version===1)?.data;
  if(prior){enabled=prior.enabled===true;queue=Array.isArray(prior.queue)?prior.queue.filter((x:any)=>typeof x?.id==="string"&&typeof x?.content==="string"&&x.content.length<=6000).slice(0,4):[];done=Array.isArray(prior.done)?prior.done.filter((x:any)=>typeof x==="string").slice(-64):[];receipt=typeof prior.receipt==="string"?prior.receipt.slice(0,4000):undefined;budget.restore(prior.budget);}
  config=loadSupervisorSettings(ctx.cwd).settings;enabled=config.enabled&&config.memoryWorker;
  status=enabled?"idle":"off";
  unregister?.();unregister=registerSupervisorAdapter(ctx,"worker",{
   apply(next){config=next;enabled=next.enabled&&next.memoryWorker;if(!enabled){cancel();queue=[];receipt=undefined;status="paused";}else status=busy?"running":"idle";persist();},
   status:()=>({enabled,status,busy,queued:queue.length,turnBudget:config?.workerTurns,timeoutMs:config?.workerTimeoutMs,recall:budget.snapshot(),reviewerModel:config?.reviewerModel}),
  });
 };
 pi.on("session_start",restore);pi.on("session_switch",restore);pi.on("session_fork",restore);
 pi.on("session_before_switch",cancel);pi.on("session_before_fork",cancel);pi.on("session_shutdown",()=>{cancel();unregister?.();unregisterMemoryMaintenance(pi);});
 const start=()=>{
  if(!enabled||child()||busy||!queue.length||!context||!jevAuditEnabled(pi))return;
  const item=queue[0],own=generation; const taskSnapshot=collectSupervisorState("",(globalThis as any)[Symbol.for("pi-swarm-task-manager")]?.snapshot?.()?.tasks??[],{},{}).tasks;busy=true;controller=new AbortController();status="running";persist();
  const taskContext=config?.enabled===true && config.operational===true?`\nParent task snapshot (proposals only): ${JSON.stringify(taskSnapshot.map(t=>({...t,snapshotHash:hashTaskSnapshot(t)}))).slice(0,12000)}\nUse supervisor_task_proposal after reading evidence. Shape create: {op:"create",task:{id:"new-key",title:"title",status:"pending"}}; update: {op:"update",targetTaskId:"id",snapshotHash:"exact",task:{status:"pending",note:"evidence-grounded blocker"}}. Never complete/delete tasks.`:"";
  activeJob=deps.run(pi,context,item.content+taskContext,{signal:controller.signal,turns:config?.workerTurns??6,timeoutMs:config?.workerTimeoutMs??90000,model:config?.reviewerModel==="session"?undefined:config?.reviewerModel}).then(async result=>{
   if(own!==generation)return;
   const taskOutcomes=config?.enabled===true && config.operational===true?await applySupervisorTaskProposals(pi,context,taskSnapshot,result.receipt,controller!.signal):[];
   if(own!==generation)return;
   done.push(item.id);queue=queue.filter(x=>x.id!==item.id);status=result.status;
   // Only structured operation receipts; never inject arbitrary worker stdout.
   receipt=`Memory maintenance ${result.status}; review evidence before relying on records. ${JSON.stringify({worker:result.receipt??{operations:[],note:"No writes reported"},taskOutcomes}).slice(0,3400)}`;
  }).catch(()=>{if(own===generation){status="failed: manual retry required";done.push(item.id);queue=queue.filter(x=>x.id!==item.id);receipt="Memory maintenance failed; prior partial writes may exist. Inspect repository memory before retrying.";}}).finally(()=>{if(own===generation){busy=false;controller=undefined;activeJob=undefined;persist();}});
 };
 registerMemoryMaintenance(pi,(content,ctx)=>{
  if(!enabled||child()||!jevAuditEnabled(pi))return false;
  const id=createHash("sha256").update(content).digest("hex");if(done.includes(id)||queue.some(x=>x.id===id))return true;
  if(queue.length>=4)return false;
  context=ctx;queue.push({id,content:content.slice(0,6000)});persist();start();return true;
 });
 // Print-mode must not exit before the current bounded review receipt is saved.
 // Drain only the already-dispatched job; never recursively drain an entire queue.
 onAgentSettled(pi, async(_event:any,ctx:any)=>{
  if(!enabled||child()||ctx.hasUI!==false)return;
  const job=activeJob;if(!job)return;
  const own=generation;let timer:ReturnType<typeof setTimeout>|undefined;
  const expired=await Promise.race([job.then(()=>false),new Promise<boolean>(resolve=>{timer=setTimeout(()=>resolve(true),95000);})]);
  if(timer)clearTimeout(timer);
  if(expired&&own===generation){cancel();status="interrupted: review deadline exceeded";receipt="Review deadline exceeded; inspect partial writes before retrying.";persist();}
 });
 pi.on("session_compact",()=>persist());
 pi.on("turn_start",()=>start());
 pi.on("turn_end",()=>{if(enabled&&!child()){budget.turnEnd();persist();}});
 pi.on("tool_call",(e:any)=>{if(enabled&&!child())budget.toolCall(e);});
 pi.on("tool_result",(e:any)=>{if(enabled&&!child()){budget.toolResult(e);persist();}});
 pi.on("input",(e:any)=>{if(enabled&&!child()&&["interactive","rpc"].includes(e.source)){budget.newGoal();persist();}});
 pi.on("context",(event:any)=>{
  if(!enabled||child())return;
  const note=budget.takeReminder(),content=[receipt,note].filter(Boolean).join("\n");if(!content)return;
  receipt=undefined;persist();return {messages:[...event.messages,{role:"custom",customType:"pi-swarm-memory-maintenance-review",content,display:true,timestamp:Date.now(),details:{untrusted:true}}]};
 });
}
