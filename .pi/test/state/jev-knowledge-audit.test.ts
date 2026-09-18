import { applySupervisorSettings, runSupervisorAudit } from "../../lib/context/supervisor-control.ts";
import { loadSupervisorSettings } from "../../lib/context/supervisor-settings.ts";
import { afterEach, expect, it, vi } from "vitest";
import extension, { JEV_ENTRY, JEV_REVIEW } from "../../extensions/40-state/jev-knowledge-audit.ts";
import { jevAuditEnabled } from "../../lib/context/jev-audit-mode.ts";
const original = { vault: process.env.PI_SWARM_JEV_VAULT, key: process.env.TYPESAFE_API_KEY, enabled: process.env.PI_SWARM_JEV_AUDIT, child: process.env.PI_SWARM_SUBAGENT };
afterEach(() => { for (const [key, value] of Object.entries({ PI_SWARM_JEV_VAULT: original.vault, TYPESAFE_API_KEY: original.key, PI_SWARM_JEV_AUDIT: original.enabled, PI_SWARM_SUBAGENT: original.child })) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
function harness(audit?: any) {
 process.env.PI_SWARM_JEV_VAULT="off"; process.env.TYPESAFE_API_KEY = "test-only"; delete process.env.PI_SWARM_JEV_AUDIT; delete process.env.PI_SWARM_SUBAGENT;
 const handlers = new Map<string, any>(), commands = new Map<string, any>();
 const entries: any[] = [{ id: "u1", type: "message", message: { role: "user", content: "Our project stores invoices in PostgreSQL." } }];
 const pi = { on: (name: string, fn: any) => handlers.set(name, fn), registerCommand: (name: string, spec: any) => commands.set(name, spec), appendEntry: (customType: string, data: any) => entries.push({ id: `c${entries.length}`, type: "custom", customType, data }) };
 const call = vi.fn(audit ?? (async (evidence: any[]) => ({ findings: [{ id: evidence[0].id, category: "memory", confidence: .9, evidence: evidence[0] }] })));
 extension(pi, { audit: call });
 const identity=`audit-test-${Math.random()}`;
 const ctx = { cwd: "/tmp/test", sessionManager: { getBranch: () => entries, getSessionId:()=>identity }, ui: { notify: vi.fn() } };
 handlers.get("session_start")({}, ctx);
 return { pi, entries, handlers, commands, ctx, call, command: (s: string) => s==="now"?runSupervisorAudit(ctx):applySupervisorSettings(ctx,{...loadSupervisorSettings(ctx.cwd).settings,enabled:s!=="off"}), turn: async () => { await handlers.get("turn_start")({}, ctx); handlers.get("turn_end")({}, ctx); } };
}
it("is off by default, audits after five completed turns, injects once without writes", async () => {
 const h = harness(); await h.turn(); expect(h.call).not.toHaveBeenCalled();
 await h.command("on"); for (let i = 0; i < 5; i++) await h.turn(); expect(h.call).not.toHaveBeenCalled();
 await h.handlers.get("turn_start")({}, h.ctx); expect(h.call).toHaveBeenCalledTimes(1);
 expect(h.entries.at(-1).customType).toBe(JEV_ENTRY);
 const output = h.handlers.get("context")({ messages: [] }); expect(output.messages[0].customType).toBe(JEV_REVIEW);
 expect(h.handlers.get("context")({ messages: [] })).toBeUndefined();
});
it("rehydrates pending review and count, off restores legacy eligibility", async () => {
 const h = harness(); await h.command("on"); await h.command("now");
 expect(h.handlers.get("context")({ messages: [] }).messages).toHaveLength(1);
 await h.command("off"); expect(jevAuditEnabled(h.pi)).toBe(false);
});
it("failure retains cursor and avoids same-turn retry loop", async () => {
 const h = harness(async () => { throw new Error("failure"); }); await h.command("on");
 for (let i=0;i<5;i++) await h.turn(); await h.handlers.get("turn_start")({},h.ctx); await h.handlers.get("turn_start")({},h.ctx);
 expect(h.call).toHaveBeenCalledTimes(1); expect(h.entries.at(-1).data.cursor).toBeUndefined();
 h.handlers.get("turn_end")(); await h.handlers.get("turn_start")({},h.ctx); expect(h.call).toHaveBeenCalledTimes(2);
});
it("session replacement cancels stale completion and child audits are suppressed", async () => {
 let finish!: (v:any)=>void; const h=harness(()=>new Promise(r=>{finish=r}));await h.command("on"); const pending=h.command("now"); await Promise.resolve();
 h.handlers.get("session_shutdown")(); finish({findings:[]});await pending;expect(h.handlers.get("context")({messages:[]})).toBeUndefined();
 process.env.PI_SWARM_SUBAGENT="1";h.handlers.get("session_start")({},h.ctx);await h.command("on");await h.command("now");expect(h.call).toHaveBeenCalledTimes(1);
});
it("missing key does not call the provider or prevent normal turns", async () => {
 const h=harness();delete process.env.TYPESAFE_API_KEY;await h.command("on");for(let i=0;i<7;i++)await h.turn();expect(h.call).not.toHaveBeenCalled();
});

it("audits final evidence on stop before five turns without duplicate or wakeup",async()=>{
 const h=harness();await h.command("on");await h.turn();
 h.entries.push({id:"final",type:"message",message:{role:"assistant",content:"Configured, runtime verification still pending."}});
 await h.handlers.get("agent_end")({},h.ctx);expect(h.call).toHaveBeenCalledTimes(1);
 await h.handlers.get("agent_end")({},h.ctx);expect(h.call).toHaveBeenCalledTimes(1);
 const note=h.handlers.get("context")({messages:[]});expect(note.messages).toHaveLength(1);
 await h.handlers.get("agent_end")({},h.ctx);expect(h.call).toHaveBeenCalledTimes(1);
});
it("stop waits for the same in-flight audit, never a second concurrent request",async()=>{
 let finish!:(value:any)=>void;const h=harness(()=>new Promise(r=>{finish=r}));await h.command("on");
 const first=h.command("now");const stop=h.handlers.get("agent_end")({},h.ctx);await Promise.resolve();expect(h.call).toHaveBeenCalledTimes(1);
 finish({findings:[]});await Promise.all([first,stop]);
});
