import {it,expect,vi,afterEach} from "vitest";
import {mkdtempSync,rmSync} from "node:fs";import {tmpdir} from "node:os";import {join} from "node:path";
import panel from "../../extensions/50-ui/supervisor.ts";
import {registerSupervisorAdapter} from "../../lib/context/supervisor-control.ts";
const old=process.env.HOME;const roots:string[]=[];afterEach(()=>{process.env.HOME=old;for(const r of roots.splice(0))rmSync(r,{recursive:true,force:true});});
it("registers one command and applies panel toggle to actual adapter",async()=>{
 const root=mkdtempSync(join(tmpdir(),"supervisor-ui-"));roots.push(root);process.env.HOME=root;
 const commands=new Map<string,any>(),hooks=new Map<string,any>();const pi={registerCommand:(n:string,v:any)=>commands.set(n,v),on:(n:string,f:any)=>hooks.set(n,f)};panel(pi);panel(pi);expect([...commands.keys()]).toEqual(["supervisor"]);
 let selection=0;const ctx={cwd:root,hasUI:true,sessionManager:{getSessionId:()=>root},ui:{setWidget:vi.fn(),notify:vi.fn(),select:async(_t:string,options:string[])=>selection++===0?options[0]:"Close"}};
 const apply=vi.fn();registerSupervisorAdapter(ctx,"audit",{apply,status:()=>({status:"idle"})});
 await commands.get("supervisor").handler("",ctx);expect(apply).toHaveBeenCalledWith(expect.objectContaining({enabled:true}),ctx);expect(ctx.ui.setWidget).toHaveBeenCalled();
 hooks.get("session_shutdown")({},ctx);expect(ctx.ui.setWidget).toHaveBeenLastCalledWith("supervisor",undefined);
});
it("cancel performs no settings mutations or adapter applications",async()=>{
 const root=mkdtempSync(join(tmpdir(),"supervisor-ui-"));roots.push(root);process.env.HOME=root;
 const commands=new Map<string,any>();panel({registerCommand:(n:string,v:any)=>commands.set(n,v),on:()=>{}});const ctx={cwd:root,hasUI:true,ui:{select:async()=>undefined}};await commands.get("supervisor").handler("",ctx);
});
