import {it,expect,vi} from "vitest";
vi.mock("../../lib/runtime/bootstrap-dispatch.ts",()=>({dispatchBootstrapHandoff:vi.fn(async()=>({content:[]}))}));
import {dispatchBootstrapHandoff} from "../../lib/runtime/bootstrap-dispatch.ts";
import {applySupervisorTaskProposals} from "../../lib/context/supervisor-task-reconcile.ts";
import {collectSupervisorState,hashTaskSnapshot} from "../../lib/context/jev-operational-supervisor.ts";
it("dispatches pending reconciliation but rejects stale and completed proposals",async()=>{
 const tasks=[{id:"1",subject:"Fix bug",status:"in_progress"}];(globalThis as any)[Symbol.for("pi-swarm-task-manager")]={snapshot:()=>({tasks})};
 const snapshot=collectSupervisorState("",tasks,{},{}).tasks;
 const proposal={op:"update",targetTaskId:"1",snapshotHash:hashTaskSnapshot(snapshot[0]),task:{status:"pending",note:"Waiting for test evidence"}};
 const receipt={operations:[{operation:"supervisor_review",outcome:"ok",verdict:"confirm",evidenceIds:["e"]},{operation:"supervisor_task_proposal",outcome:"ok",proposal,evidenceIds:["e"]}]};
 const result=await applySupervisorTaskProposals({getActiveTools:()=>["TaskManage"]},{},snapshot,receipt,new AbortController().signal);expect(result[0].status).toBe("dispatched");expect(dispatchBootstrapHandoff).toHaveBeenCalledTimes(1);
 tasks[0].subject="Changed goal";
 expect((await applySupervisorTaskProposals({},{},snapshot,receipt,new AbortController().signal))[0].status).toBe("rejected");
 proposal.task.status="completed";
 expect((await applySupervisorTaskProposals({},{},snapshot,receipt,new AbortController().signal))[0].status).toBe("rejected");
 delete (globalThis as any)[Symbol.for("pi-swarm-task-manager")];
});

it("refuses task changes without independent confirmation",async()=>{
 const manager={snapshot:()=>({tasks:[]})};(globalThis as any)[Symbol.for("pi-swarm-task-manager")]=manager;
 const receipt={operations:[{operation:"supervisor_task_proposal",outcome:"ok",evidenceIds:["e"],proposal:{op:"create",task:{id:"new",title:"Work",status:"pending"}}}]};
 expect((await applySupervisorTaskProposals({},{},[],receipt,new AbortController().signal))[0].reason).toContain("confirmation");
 delete (globalThis as any)[Symbol.for("pi-swarm-task-manager")];
});
