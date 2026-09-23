/** Pi adapters have distinct API objects/module graphs. Route by owning session,
 * not adapter identity. Registrations are removed on replacement/shutdown. */
type Handler=(content:string,ctx:any)=>boolean;
const symbol=Symbol.for("pi-swarm-memory-maintenance-bridge");
const handlers:Map<object,{session?:string;fn:Handler}>=(globalThis as any)[symbol]??=new Map();
const session=(ctx:any):string|undefined=>ctx?.sessionManager?.getSessionId?.()??ctx?.sessionManager?.getSessionFile?.();
export function registerMemoryMaintenance(pi:object,fn:Handler){handlers.set(pi,{fn});}
export function bindMemoryMaintenance(pi:object,ctx:any){const h=handlers.get(pi);if(h)h.session=session(ctx);}
export function unregisterMemoryMaintenance(pi:object){handlers.delete(pi);}
export function dispatchMemoryMaintenance(pi:object,content:string,ctx:any):boolean{
 const own=handlers.get(pi);if(own)return own.fn(content,ctx);
 const id=session(ctx);if(!id)return false;
 const matches=[...handlers.values()].filter(h=>h.session===id);
 return matches.length===1?matches[0].fn(content,ctx):false;
}
