import { applySupervisorSettings } from "../../lib/context/supervisor-control.ts";
import { loadSupervisorSettings } from "../../lib/context/supervisor-settings.ts";
import {it,expect,vi,afterEach} from "vitest";
import extension from "../../extensions/40-state/memory-maintenance.ts";
import {dispatchMemoryMaintenance} from "../../lib/context/memory-maintenance-bridge.ts";
import {setJevAuditEnabled} from "../../lib/context/jev-audit-mode.ts";
afterEach(()=>{delete process.env.PI_SWARM_SUBAGENT;});
function h(run?:any){const hooks=new Map<string,any>(),commands=new Map<string,any>(),entries:any[]=[];const pi={on:(n:string,f:any)=>hooks.set(n,f),registerCommand:(n:string,s:any)=>commands.set(n,s),appendEntry:(t:string,data:any)=>entries.push({customType:t,data})};const exec=vi.fn(run??(async()=>({status:"completed",receipt:{operations:[]}})));extension(pi,{run:exec});const identity=`worker-test-${Math.random()}`;const ctx:any={cwd:"/tmp",sessionManager:{getBranch:()=>entries,getSessionId:()=>identity},ui:{notify:vi.fn()}};hooks.get("session_start")({},ctx);setJevAuditEnabled(pi,true);return{pi,hooks,commands,ctx,entries,exec,on:()=>applySupervisorSettings(ctx,{...loadSupervisorSettings(ctx.cwd).settings,enabled:true})};}
it("queues one worker and deduplicates findings without wakeup",async()=>{let finish:any;const t=h(()=>new Promise(r=>finish=r));await t.on();expect(dispatchMemoryMaintenance(t.pi,"finding",t.ctx)).toBe(true);dispatchMemoryMaintenance(t.pi,"finding",t.ctx);expect(t.exec).toHaveBeenCalledTimes(1);finish({status:"completed",receipt:{operations:[]}});await new Promise(r=>setTimeout(r,0));expect(t.hooks.get("context")({messages:[]}).messages).toHaveLength(1);expect(t.hooks.get("context")({messages:[]})).toBeUndefined();dispatchMemoryMaintenance(t.pi,"finding",t.ctx);expect(t.exec).toHaveBeenCalledTimes(1);});
it("off cancels and stale completion cannot inject",async()=>{let finish:any;const t=h(()=>new Promise(r=>finish=r));await t.on();dispatchMemoryMaintenance(t.pi,"finding",t.ctx);await applySupervisorSettings(t.ctx,{...loadSupervisorSettings(t.ctx.cwd).settings,enabled:false});expect(t.exec.mock.calls[0][3].signal.aborted).toBe(true);finish({status:"completed"});await new Promise(r=>setTimeout(r,0));expect(t.hooks.get("context")({messages:[]})).toBeUndefined();});
it("soft query reminder is one-shot and excludes children",async()=>{const t=h();await t.on();for(let i=0;i<10;i++)t.hooks.get("turn_end")();expect(t.hooks.get("context")({messages:[]}).messages[0].content).toContain("memory_history");for(let i=0;i<12;i++)t.hooks.get("turn_end")();expect(t.hooks.get("context")({messages:[]})).toBeUndefined();process.env.PI_SWARM_SUBAGENT="1";expect(dispatchMemoryMaintenance(t.pi,"x",t.ctx)).toBe(false);});

it("routes Jev from a distinct extension API by exact session identity",async()=>{
 const t=h();t.ctx.sessionManager.getSessionId=()=>"isolated-bridge-test";t.hooks.get("session_start")({},t.ctx);setJevAuditEnabled(t.pi,true);await t.on();
 expect(dispatchMemoryMaintenance({},"external-adapter",t.ctx)).toBe(true);expect(t.exec).toHaveBeenCalledTimes(1);
 t.hooks.get("session_shutdown")();expect(dispatchMemoryMaintenance({},"late",t.ctx)).toBe(false);
});

it("headless stop waits for dispatched receipt without draining queued work",async()=>{
 let finish:any;const t=h(()=>new Promise(r=>finish=r));await t.on();dispatchMemoryMaintenance(t.pi,"finding",t.ctx);
 let stopped=false;const end=t.hooks.get("agent_settled")({}, {...t.ctx,hasUI:false}).then(()=>{stopped=true;});
 await Promise.resolve();expect(stopped).toBe(false);finish({status:"completed",receipt:{operations:[]}});await end;
 expect(t.entries.at(-1).data.status).toBe("completed");expect(t.exec).toHaveBeenCalledTimes(1);
});
it("interactive stop remains nonblocking",async()=>{
 let finish:any;const t=h(()=>new Promise(r=>finish=r));await t.on();dispatchMemoryMaintenance(t.pi,"finding",t.ctx);
 await t.hooks.get("agent_settled")({}, {...t.ctx,hasUI:true});expect(t.entries.at(-1).data.status).toBe("running");
 finish({status:"completed"});await new Promise(r=>setTimeout(r,0));
});
