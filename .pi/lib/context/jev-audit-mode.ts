const key=Symbol.for("pi-swarm-jev-mode");
const state:{owners:WeakMap<object,string>;modes:Map<string,boolean>;local:WeakMap<object,boolean>}=(globalThis as any)[key]??={owners:new WeakMap(),modes:new Map(),local:new WeakMap()};
export function bindJevAuditMode(pi:object,ctx:any):void{const id=ctx?.sessionManager?.getSessionId?.()??ctx?.sessionManager?.getSessionFile?.();if(typeof id==="string")state.owners.set(pi,id);}
export function jevAuditEnabled(pi:object):boolean{const id=state.owners.get(pi);return (id?state.modes.get(id):state.local.get(pi))??process.env.PI_SWARM_JEV_AUDIT==="on";}
export function setJevAuditEnabled(pi:object,enabled:boolean):void{const id=state.owners.get(pi);if(id)state.modes.set(id,enabled);else state.local.set(pi,enabled);}
