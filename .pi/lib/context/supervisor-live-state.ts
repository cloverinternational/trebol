/** Session-scoped read-only observations. No model controls counters or permissions. */
const key=Symbol.for("pi-swarm-supervisor-live-state");
type State={budget?:()=>unknown;workers:Set<string>;waitingUser:boolean;failed:boolean};
const states:Map<string,State>=(globalThis as any)[key]??=new Map();
export const supervisorSessionId=(ctx:any):string|undefined=>ctx?.sessionManager?.getSessionId?.()??ctx?.sessionManager?.getSessionFile?.();
function get(ctx:any){const id=supervisorSessionId(ctx);if(!id)return;let s=states.get(id);if(!s){s={workers:new Set(),waitingUser:false,failed:false};states.set(id,s);}return s;}
export function registerSupervisorBudget(ctx:any,read:()=>unknown){const s=get(ctx);if(s)s.budget=read;}
export function observeSupervisorTool(ctx:any,e:any){
 const s=get(ctx);if(!s)return;const tool=String(e.toolName??"").toLowerCase();
 if(tool==="ask_user_question")s.waitingUser=e.isError===true;
 if(e.isError===true)s.failed=true;
 const blocks=Array.isArray(e.content)?e.content:[];
 for(const b of blocks){if(b?.type!=="text")continue;try{
  const r=JSON.parse(b.text);const id=r.agent_id??r.task_id??r.handle??r.id;
  if(typeof id!=="string")continue;
  if(["completed","failed","cancelled"].includes(r.status))s.workers.delete(id);
  else if(r.backgrounded===true||r.status==="running"||r.status==="async_launched")s.workers.add(id);
 }catch{}}
}
export function observeSupervisorCompletion(ctx:any,content:string){const s=get(ctx);if(!s)return;const m=/\[agent completed\] id=(\S+) status=(completed|failed|cancelled)/.exec(content);if(m)s.workers.delete(m[1]);}
export function resetSupervisorInput(ctx:any){const s=get(ctx);if(s){s.waitingUser=false;s.failed=false;}}
export function readSupervisorLiveState(ctx:any){const s=get(ctx);return {budget:s?.budget?.()??{available:false},waiting:{pendingMessages:ctx?.hasPendingMessages?.()===true,backgroundWorkers:s?.workers.size??0,waitingUser:s?.waitingUser??false,priorToolFailure:s?.failed??false}};}
export function clearSupervisorLiveState(ctx:any){const id=supervisorSessionId(ctx);if(id)states.delete(id);}
