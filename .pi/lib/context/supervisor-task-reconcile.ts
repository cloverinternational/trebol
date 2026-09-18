import { dispatchBootstrapHandoff } from "../runtime/bootstrap-dispatch.ts";
import { collectSupervisorState, validateTaskProposal } from "./jev-operational-supervisor.ts";
/** Parent-side gate; worker cannot own or directly mutate main-session tasks. */
export async function applySupervisorTaskProposals(pi:any,ctx:any,snapshot:any[],receipt:any,signal:AbortSignal) {
 const manager=(globalThis as any)[Symbol.for("pi-swarm-task-manager")];
 
 const proposals=(receipt?.operations??[]).filter((r:any)=>r.operation==="supervisor_task_proposal"&&r.outcome==="ok");
 const verdicts=new Map<string,string>();
 for(const row of receipt?.operations??[]) if(row.operation==="supervisor_review"&&row.outcome==="ok"&&Array.isArray(row.evidenceIds))for(const id of row.evidenceIds)verdicts.set(id,row.verdict);
 const outcomes:any[]=[];
 for(const record of proposals.slice(0,5)){
  if(signal.aborted)break;
  if(!Array.isArray(record.evidenceIds)||!record.evidenceIds.length||record.evidenceIds.some((id:any)=>verdicts.get(id)!=="confirm")){outcomes.push({status:"rejected",reason:"independent confirmation missing or withdrawn"});continue;}
  const current=collectSupervisorState("",manager?.snapshot?.()?.tasks??[],{},{}).tasks;
  const proposal=record.proposal;
  const validated=validateTaskProposal(snapshot,current,[proposal]);
  if(!validated.valid){outcomes.push({status:"rejected",reason:validated.errors.join("; ")});continue;}
  // Only normalized, independently allowlisted parent operations reach TaskManage.
  const p=validated.operations[0],old=snapshot.find(t=>t.id===p.targetTaskId);
  if(p.op==="update" && (old?.owner||p.task.status&&!["pending","in_progress"].includes(String(p.task.status)))){outcomes.push({status:"rejected",reason:"owner or status not eligible"});continue;}
  const op=p.op==="create"?{key:`supervisor-${proposal.task.id}`,op:"create",subject:p.task.title,status:p.task.status??"pending",...(p.task.dependsOn?.length?{addBlockedBy:p.task.dependsOn}:{})}:{key:`supervisor-${p.targetTaskId}`,op:"update",taskId:p.targetTaskId,...(p.task.status?{status:p.task.status}:{}),...(p.task.questions?{questions:p.task.questions}:{}),...(p.task.note?{addNote:p.task.note,noteType:"observation"}:{})};
  try {const result=await dispatchBootstrapHandoff("TaskManage",{operations:[op]},signal,ctx,pi.getActiveTools?.()??[]);outcomes.push({status:"dispatched",taskId:p.targetTaskId,result});}
  catch{outcomes.push({status:"rejected",reason:"parent task policy or dispatch refused"});}
 }
 return outcomes;
}
