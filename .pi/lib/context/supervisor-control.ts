import type { SupervisorSettings } from "./supervisor-settings.ts";
type Adapter={apply(settings:SupervisorSettings,ctx:any):void|Promise<void>;status():Record<string,unknown>;runNow?(ctx:any):Promise<void>};
const key=Symbol.for("pi-swarm-supervisor-control");
const sessions:Map<string,Map<string,Adapter>>=(globalThis as any)[key]??=new Map();
export function supervisorId(ctx:any):string{return ctx?.sessionManager?.getSessionId?.()??ctx?.sessionManager?.getSessionFile?.()??ctx?.cwd??"unknown";}
export function registerSupervisorAdapter(ctx:any,name:string,adapter:Adapter){const id=supervisorId(ctx);const map=sessions.get(id)??new Map();map.set(name,adapter);sessions.set(id,map);return()=>{if(map.get(name)===adapter)map.delete(name);if(!map.size)sessions.delete(id);};}
export async function applySupervisorSettings(ctx:any,settings:SupervisorSettings){for(const a of sessions.get(supervisorId(ctx))?.values()??[])await a.apply(settings,ctx);}
export function supervisorStatus(ctx:any){return Object.fromEntries([...(sessions.get(supervisorId(ctx))??[])].map(([name,a])=>[name,a.status()]));}
export async function runSupervisorAudit(ctx:any){const adapter=sessions.get(supervisorId(ctx))?.get("audit");if(!adapter?.runNow)throw new Error("Audit adapter unavailable; reload Pi");await adapter.runNow(ctx);}
