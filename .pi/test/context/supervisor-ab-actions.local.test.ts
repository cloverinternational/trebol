import {it,expect} from "vitest";
import {readFileSync,writeFileSync} from "node:fs";
import {TaskManager} from "../../../packages/tools/taskmanage/src/task-manage.ts";
import {registerBootstrapHandoff} from "../../lib/runtime/bootstrap-dispatch.ts";
import {applySupervisorTaskProposals} from "../../lib/context/supervisor-task-reconcile.ts";
import {collectSupervisorState,hashTaskSnapshot} from "../../lib/context/jev-operational-supervisor.ts";
it.skipIf(!process.env.PI_SWARM_SUPERVISOR_AB_ACTIONS)("reviewed B arm reconciles real isolated task managers; A remains unchanged",async()=>{
 const cases=JSON.parse(readFileSync("artifacts/supervisor-ab/frozen-cases.json","utf8")).cases;
 const review=JSON.parse(readFileSync("artifacts/supervisor-ab/independent-review.json","utf8"));
 const symbol=Symbol.for("pi-swarm-task-manager"),old=(globalThis as any)[symbol],report:any[]=[];
 try{for(const c of cases){
  const manager=new TaskManager();
  for(const t of c.tasks)manager.execute({operations:[{key:`seed-${t.id}`,op:"create",subject:t.subject,status:t.status,active:t.active}]});
  const before=manager.snapshot();(globalThis as any)[symbol]=manager;
  registerBootstrapHandoff({name:"TaskManage",execute:async(_id:string,input:any)=>{const result=manager.execute(input);return {content:[{type:"text",text:JSON.stringify(result)}],isError:result.status!=="succeeded"};}});
  const verdict=review.findings.find((r:any)=>r.case===c.id),snapshot=collectSupervisorState("",before.tasks,{},{}).tasks;
  const proposals=verdict.verdict==="confirm"?verdict.permitted_operations.map((op:any,i:number)=>op.op==="create"?{op:"create",task:{id:`${c.id}-${i}`,title:op.subject,status:"pending"}}:{op:"update",targetTaskId:snapshot[0].id,snapshotHash:hashTaskSnapshot(snapshot[0]),task:{note:op.text}}):[];
  const receipt={operations:[{operation:"supervisor_review",outcome:"ok",verdict:verdict.verdict,evidenceIds:[verdict.evidence_id]},...proposals.map((proposal:any)=>({operation:"supervisor_task_proposal",outcome:"ok",proposal,evidenceIds:[verdict.evidence_id]}))]};
  const outcomes=await applySupervisorTaskProposals({getActiveTools:()=>["TaskManage"]},{sessionId:`test-${c.id}`},snapshot,receipt,new AbortController().signal);
  expect(outcomes.every(o=>o.status==="dispatched")).toBe(true);
  const after=manager.snapshot();if(c.expected==="quiet")expect(after).toEqual(before);else expect(after.tasks.length).toBe(before.tasks.length+1);
  expect(after.tasks.filter(t=>t.status==="completed").length).toBe(before.tasks.filter(t=>t.status==="completed").length);
  report.push({case:c.id,A:{tasks:before.tasks},B:{tasks:after.tasks,outcomes},reviewVerdict:verdict.verdict,actualIsolatedMutation:true});
 }}finally{(globalThis as any)[symbol]=old;}
 writeFileSync("artifacts/supervisor-ab/action-results.json",JSON.stringify(report,null,2));
});
