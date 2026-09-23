import {it,expect} from "vitest";
import {mkdirSync,writeFileSync} from "node:fs";
import {auditWithJev} from "../../lib/context/jev-knowledge-audit.ts";
import {collectSupervisorState} from "../../lib/context/jev-operational-supervisor.ts";
import {registerSwarmBuiltinHooks,TASK_MANAGER_SYMBOL} from "../../lib/runtime/swarm-builtin-hooks-runtime.ts";
const cases=[
 {id:"missing",goal:"Implement export, test it and document usage",tasks:[],evidence:"Export implementation changed files and two tests passed; documentation remains. No task ledger entries were created.",stop:"Implementation is ready; documentation remains.",expected:"review",background:false},
 {id:"stale",goal:"Implement export and document usage",tasks:[{id:"1",subject:"Investigate old parser",status:"in_progress",active:true}],evidence:"Parser investigation was superseded by user request for export. Agent has edited export and is testing it. Task ledger still describes old parser.",stop:"Export work continues but ledger is unchanged.",expected:"review",background:false},
 {id:"progress",goal:"Implement export and test it",tasks:[{id:"1",subject:"Implement export and test it",status:"completed",active:false}],evidence:"Export implemented; verifier passed; task ledger updated to completed. No open obligations in this bounded fixture.",stop:"Export and its tests are complete.",expected:"quiet",background:false},
 {id:"waiting",goal:"Implement export after dependency job finishes",tasks:[{id:"1",subject:"Wait for dependency job",status:"pending",active:false}],evidence:"Dependency worker is running. Main agent is explicitly waiting and must not duplicate the worker.",stop:"Waiting for dependency worker.",expected:"quiet",background:true},
];
it.skipIf(!process.env.PI_SWARM_SUPERVISOR_AB)("paired baseline hooks versus hooks plus real Jev",async()=>{
 const saved=(globalThis as any)[TASK_MANAGER_SYMBOL];const output:any[]=[];mkdirSync("artifacts/supervisor-ab",{recursive:true});
 writeFileSync("artifacts/supervisor-ab/frozen-cases.json",JSON.stringify({synthetic:true,cases},null,2));
 try{for(const c of cases){
  const handlers=new Map<string,Function[]>(),sent:any[]=[];
  (globalThis as any)[TASK_MANAGER_SYMBOL]={snapshot:()=>({tasks:c.tasks})};
  registerSwarmBuiltinHooks({on:(n:string,f:Function)=>handlers.set(n,[...(handlers.get(n)??[]),f]),appendEntry(){},sendMessage:(...args:any[])=>sent.push(args)});
  const ctx={sessionId:`ab-${c.id}`,hasUI:true,hasPendingMessages:()=>false};
  const emit=async(n:string,e:any)=>{for(const f of handlers.get(n)??[])await f(e,ctx);};
  await emit("session_start",{});await emit("tool_result",{toolName:c.background?"Bash":"Read",content:[{type:"text",text:c.background?'{"backgrounded":true}':"ok"}]});
  await emit("turn_end",{message:{role:"assistant",stopReason:"stop",content:[{type:"text",text:c.stop}]}});
  const baselineWake=sent.some(x=>x[1]?.triggerTurn===true);
  const evidence=[{id:`e-${c.id}`,role:"tool",text:c.evidence,truncated:false,sourceKind:"conversation" as const}];
  for(let trial=0;trial<2;trial++){
   const start=Date.now();let result:any,error:string|undefined;
   try{result=await auditWithJev(evidence,{apiKey:process.env.TYPESAFE_API_KEY!,supervisor:collectSupervisorState(c.goal,c.tasks,{}, {backgroundWorker:c.background})});}catch(e){error=String(e);}
   output.push({case:c.id,trial,expected:c.expected,baseline:{wake:baselineWake,messages:sent.length},jev:result,latencyMs:Date.now()-start,error,mode:"historical fixture event replay; no live reviewer/action"});
   writeFileSync("artifacts/supervisor-ab/results.json",JSON.stringify(output,null,2));
  }
 }}finally{(globalThis as any)[TASK_MANAGER_SYMBOL]=saved;}
 expect(output).toHaveLength(8);
},45000);
