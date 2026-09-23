import { loadSupervisorSettings, saveSupervisorSettings, clearSupervisorOverride } from "../../lib/context/supervisor-settings.ts";
import { applySupervisorSettings, supervisorStatus, runSupervisorAudit } from "../../lib/context/supervisor-control.ts";
import { resolveJevCredential } from "../../lib/context/jev-credential.ts";
import { auditWithJev } from "../../lib/context/jev-knowledge-audit.ts";
const registered=new WeakSet<object>();
export default function supervisorPanel(pi:any){
 if(registered.has(pi))return;registered.add(pi);
 let health="not tested",generation=0;
 const refresh=(ctx:any)=>{
  const settings=loadSupervisorSettings(ctx.cwd).settings;const state=supervisorStatus(ctx);
  ctx.ui?.setWidget?.("supervisor",settings.enabled?[`Supervisor ON | Jev ${health}`,`Audit: ${String(state.audit?.status??"unavailable").slice(0,32)}`,`Worker: ${String(state.worker?.status??"unavailable").slice(0,32)}`,"/supervisor — settings and review"]:undefined);
 };
 pi.on("session_start",(_e:any,ctx:any)=>{generation++;health="not tested";refresh(ctx);});
 pi.on("turn_end",(_e:any,ctx:any)=>refresh(ctx));
 pi.on("session_shutdown",(_e:any,ctx:any)=>{generation++;ctx.ui?.setWidget?.("supervisor",undefined);});
 pi.registerCommand("supervisor",{description:"Unified Jev, memory and operational supervisor settings/status",handler:async(args:string,ctx:any)=>{
  if(args.trim()==="status"||!ctx.hasUI){const r=loadSupervisorSettings(ctx.cwd);ctx.ui?.notify?.(JSON.stringify({settings:r.settings,origins:r.origins,diagnostics:r.diagnostics,state:supervisorStatus(ctx),health}),"info");return;}
  let scope:"project"|"global"="project";
  for(;;){
   const resolved=loadSupervisorSettings(ctx.cwd),s=resolved.settings,state=supervisorStatus(ctx);
   const options=[`Master: ${s.enabled?"ON":"OFF"}`,`Edit scope: ${scope}`,"Provider / credential source",`Reviewer: ${s.reviewerModel}`,`Audit: ${s.audit?"ON":"OFF"}`,`Operational review: ${s.operational?"ON":"OFF"}`,`Memory worker: ${s.memoryWorker?"ON":"OFF"}`,`Audit interval: ${s.cadence} turns`,`Stop audit: ${s.stopAudit?"ON":"OFF"}`,`Worker turns: ${s.workerTurns}`,`Worker timeout: ${s.workerTimeoutMs/1000}s`,"Test Jev connection","Run audit now","Review status / origins","Clear project overrides","Close"];
   const choice=await ctx.ui.select(`Supervisor | ${scope} settings | Jev ${health}`,options);if(!choice||choice==="Close")return;
   const index=options.indexOf(choice);let patch:any;
   try{
    if(index===0)patch={enabled:!s.enabled};
    else if(index===1){scope=scope==="project"?"global":"project";continue;}
    else if(index===2){
     const mode=await ctx.ui.select("Credential source (references only; no key entry)",["auto","provider","environment","vault"]);if(!mode)continue;
     let value:string|undefined;
     if(mode==="provider")value=await ctx.ui.input("TypeSafe provider ID",s.provider);
     if(mode==="environment")value=await ctx.ui.input("Environment variable name",s.envVar);
     if(mode==="vault")value=await ctx.ui.input("Vault credential ID",s.credentialId);
     if(mode!=="auto"&&!value)continue;
     patch={credentialMode:mode,...(mode==="provider"?{provider:value}:mode==="environment"?{envVar:value}:mode==="vault"?{credentialId:value}:{})};
    }else if(index===3){const values=["session",...(ctx.modelRegistry?.getAvailable?.()??[]).map((m:any)=>`${m.provider}/${m.id}`)];const model=await ctx.ui.select("Reviewer model",values);if(!model)continue;patch={reviewerModel:model};}
    else if([4,5,6,8].includes(index)){const key=({4:"audit",5:"operational",6:"memoryWorker",8:"stopAudit"} as any)[index];patch={[key]:!s[key as keyof typeof s]};}
    else if([7,9,10].includes(index)){const value=await ctx.ui.input(index===7?"Audit turns (1–50)":index===9?"Worker turns (1–6)":"Worker seconds (1–90)");if(value===undefined)continue;patch=index===7?{cadence:Number(value)}:index===9?{workerTurns:Number(value)}:{workerTimeoutMs:Number(value)*1000};}
    else if(index===11){const own=generation;health="testing";refresh(ctx);const credential=await resolveJevCredential({config:s,registry:ctx.modelRegistry});if(!credential)throw Error("Configured credential unavailable");await auditWithJev([{id:"connectivity",role:"user",text:"Connection test only; no project knowledge.",truncated:false,sourceKind:"conversation"}],{apiKey:credential.apiKey});if(own!==generation)return;health=`connected (${credential.source})`;refresh(ctx);continue;}
    else if(index===12){await runSupervisorAudit(ctx);refresh(ctx);continue;}
    else if(index===13){ctx.ui.notify(JSON.stringify({state,origins:resolved.origins,diagnostics:resolved.diagnostics,skillCleanup:"preview only; global mutation unavailable"},null,2),"info");continue;}
    else if(index===14){const next=clearSupervisorOverride(ctx.cwd);health="not tested";await applySupervisorSettings(ctx,next.settings);refresh(ctx);continue;}
    if(patch){const next=saveSupervisorSettings(ctx.cwd,scope,patch);health="not tested";await applySupervisorSettings(ctx,next.settings);refresh(ctx);}
   }catch{health="unavailable / check configuration";refresh(ctx);ctx.ui.notify("Supervisor action failed. Check credential reference, settings bounds, and loaded adapters. No secret values are displayed.","error");}
  }
 }});
}
