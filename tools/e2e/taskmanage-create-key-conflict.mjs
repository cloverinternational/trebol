/** Real Pi + TaskManage: a create idempotency key replays only an identical
 * create. A reused key with a different payload fails with idempotency_conflict
 * (task count unchanged), an identical retry replays the same task, and update
 * keys remain reusable per-call aliases. Issue cloverinternational/trebol#298.
 * Run: node tools/e2e/taskmanage-create-key-conflict.mjs */
import {createServer} from 'node:http';import {mkdtemp,mkdir,writeFile,realpath,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';import {spawn,execFileSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
const repo=resolve(fileURLToPath(new URL('../../',import.meta.url))),root=await realpath(await mkdtemp(join(tmpdir(),'create-key-conflict-'))),agent=join(root,'agent'),workspace=join(root,'workspace');
let server,child;
const step=(n,ok,detail)=>{console.log(`${ok?'PASS':'FAIL'} step ${n}: ${detail}`);if(!ok)throw new Error(`step ${n} failed`);};
const op=(ops)=>({name:'TaskManage',arguments:{operations:ops}});
const original={key:'t',op:'create',subject:'Audit old thing',questions:[{id:'q1',text:'What was audited?'}],status:'in_progress',active:true};
const calls=[
 op([original]),
 op([{key:'c',op:'update',taskId:'1',status:'completed',answers:[{question:'q1',answer:'The old thing was audited.',evidence:'notes.md#Notes'}]}]),
 op([{key:'t',op:'create',subject:'Check per-answer memory',questions:[{id:'q2',text:'Is memory per answer?'},{id:'q3',text:'Is evidence anchored?'}],status:'in_progress',active:true}]),
 op([{key:'l',op:'list'}]),
 op([original]),
 op([{key:'u',op:'create',subject:'Second task',questions:[{id:'q4',text:'Is the alias reusable?'}],status:'in_progress',active:true}]),
 op([{key:'u',op:'update',addNote:'step one'}]),
 op([{key:'u',op:'update',status:'completed',answers:[{question:'q4',answer:'Yes, the update alias resolves to task 2.',evidence:'notes.md#Notes'}]}]),
 op([{key:'l',op:'list'}]),
];
const batch=(r)=>r.details?.batch??JSON.parse(r.content?.[0]?.text??'{}');
try{
 await mkdir(agent,{recursive:true});await mkdir(workspace,{recursive:true});
 await writeFile(join(workspace,'notes.md'),'# Notes\n\nScripted evidence.\n');
 execFileSync('git',['init','-q'],{cwd:workspace});
 server=createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;const b=JSON.parse(raw);const n=(b.messages??[]).filter(m=>m.role==='tool').length;const t=calls[n];
  res.writeHead(200,{'content-type':'text/event-stream'});
  const delta=t?{role:'assistant',tool_calls:[{index:0,id:`call-${n}`,type:'function',function:{name:t.name,arguments:JSON.stringify(t.arguments)}}]}:{role:'assistant',content:'done'};
  res.write(`data: ${JSON.stringify({id:'x',object:'chat.completion.chunk',created:0,model:'script',choices:[{index:0,delta,finish_reason:null}]})}\n\n`);
  res.write(`data: ${JSON.stringify({id:'x',object:'chat.completion.chunk',created:0,model:'script',choices:[{index:0,delta:{},finish_reason:t?'tool_calls':'stop'}]})}\n\n`);
  res.end('data: [DONE]\n\n');});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 await writeFile(join(agent,'models.json'),JSON.stringify({providers:{local:{baseUrl:`http://127.0.0.1:${server.address().port}/v1`,api:'openai-completions',apiKey:'dummy',models:[{id:'script',contextWindow:100000,maxTokens:2048,reasoning:false}]}}}));
 const args=['--model','local/script','--no-extensions','--extension',join(repo,'extensions/taskmanage/extension.ts'),'--no-tools','--tools','TaskManage','--no-skills','--no-context-files','--mode','json','--print','--approve','--','Run the task operations.'];
 child=spawn('pi',args,{cwd:workspace,env:{...process.env,HOME:root,PI_CODING_AGENT_DIR:agent,PI_SWARM_MEMORY_DIR:join(root,'memory'),PI_SWARM_SUBAGENT:'0'},stdio:['ignore','pipe','pipe']});
 let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);const timer=setTimeout(()=>child.kill('SIGKILL'),60000);const code=await new Promise(r=>child.once('exit',r));clearTimeout(timer);
 const results=stdout.split('\n').flatMap(l=>{try{return[JSON.parse(l)]}catch{return[]}}).filter(e=>e.type==='tool_execution_end').map(e=>e.result);
 if(process.env.DEBUG)for(const r of results)console.log(JSON.stringify(batch(r)).slice(0,400));
 step(1,code===0&&results.length===calls.length,`pi exit ${code}, ${results.length}/${calls.length} tool results ${stderr.slice(-300)}`);
 const b=results.map(batch), first=b[0].results[0], conflict=b[2].results[0], list=b[3].results[0].data.pagination.total;
 step(2,b[0].status==='succeeded'&&first.data.task.id==='1'&&b[1].status==='succeeded',`original create made task ${first.data.task.id}; completed in batch 2 (${b[1].status})`);
 step(3,b[2].status==='failed'&&conflict.error.code==='idempotency_conflict'&&conflict.error.retryable===false&&conflict.error.message.includes('task 1'),`reused key with different payload: ${conflict.error.code} retryable=${conflict.error.retryable} names task 1`);
 step(4,list===1&&b[3].results[0].data.tasks.length===1,`task count after conflict unchanged: ${list} (no new task, no focus change)`);
 const replay=b[4].results[0];
 step(5,b[4].status==='succeeded'&&replay.data.task.id==='1'&&b[3].results[0].data.tasks.length===1,`identical retry of key t replays task ${replay.data.task.id} (${b[4].status}), no duplicate`);
 step(6,b[5].status==='succeeded'&&b[5].results[0].data.task.id==='2',`fresh key u creates task ${b[5].results[0].data.task.id}`);
 const alias=b[6].results[0], aliasDone=b[7].results[0];
 step(7,alias.status==='succeeded'&&alias.data.task.id==='2'&&aliasDone.status==='succeeded'&&aliasDone.data.task.id==='2'&&aliasDone.data.task.status==='completed',`update key u reused across calls targets task 2 (note, then completed)`);
 step(8,b[8].results[0].data.pagination.total===2,`final list has 2 tasks`);
 console.log('PASS');
}finally{if(child&&child.exitCode===null)child.kill('SIGKILL');if(server)await new Promise(r=>server.close(r));await rm(root,{recursive:true,force:true});}
