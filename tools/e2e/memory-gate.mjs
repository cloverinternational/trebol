/** Actual installed Pi hook: with no focused task, memory_history search/get run and remember stays blocked. */
import {createServer} from 'node:http';import {mkdtemp,mkdir,writeFile,rm,realpath} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';import {spawn} from 'node:child_process';import {fileURLToPath} from 'node:url';
const repo=resolve(fileURLToPath(new URL('../../',import.meta.url))),root=await realpath(await mkdtemp(join(tmpdir(),'memory-gate-'))),agent=join(root,'agent'),workspace=join(root,'workspace'),memory=join(root,'memory');let server,child;
// hook-state.ts skips all hooks for the first HOOK_WARMUP_TURNS (5) turns; pad with exempt calls.
const warmup=Array.from({length:5},()=>({name:'TaskManage',arguments:{operations:[{key:'w',op:'list'}]}}));
const calls=[...warmup,
 {name:'memory_history',arguments:{operation:'search',query:'gate probe',scope:'repository'}},
 {name:'memory_history',arguments:{operation:'get',id:'00000000-0000-0000-0000-000000000000',scope:'repository'}},
 {name:'memory_history',arguments:{operation:'remember',text:'gate probe write',scope:'repository'}},
];
try{
 await mkdir(agent,{recursive:true});await mkdir(workspace,{recursive:true});
 server=createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;const b=JSON.parse(raw);const n=(b.messages??[]).filter(m=>m.role==='tool').length;const t=calls[n];
  res.writeHead(200,{'content-type':'text/event-stream'});
  const delta=t?{role:'assistant',tool_calls:[{index:0,id:`call-${n}`,type:'function',function:{name:t.name,arguments:JSON.stringify(t.arguments)}}]}:{role:'assistant',content:'done'};
  res.write(`data: ${JSON.stringify({id:'x',object:'chat.completion.chunk',created:0,model:'script',choices:[{index:0,delta,finish_reason:null}]})}\n\n`);
  res.write(`data: ${JSON.stringify({id:'x',object:'chat.completion.chunk',created:0,model:'script',choices:[{index:0,delta:{},finish_reason:t?'tool_calls':'stop'}]})}\n\n`);
  res.end('data: [DONE]\n\n');});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 await writeFile(join(agent,'models.json'),JSON.stringify({providers:{local:{baseUrl:`http://127.0.0.1:${server.address().port}/v1`,api:'openai-completions',apiKey:'dummy',models:[{id:'script',contextWindow:100000,maxTokens:2048,reasoning:false}]}}}));
 const args=['--model','local/script','--no-extensions','--extension',join(repo,'extensions/taskmanage/extension.ts'),'--extension',join(repo,'extensions/memory-history/extension.ts'),'--no-tools','--tools','TaskManage,memory_history','--no-skills','--no-context-files','--no-session','--mode','json','--print','--approve','--','Probe the memory gate.'];
 child=spawn('pi',args,{cwd:workspace,env:{...process.env,HOME:root,PI_CODING_AGENT_DIR:agent,PI_SWARM_MEMORY_DIR:memory,PI_SWARM_SUBAGENT:'0',PI_SWARM_NO_HOOKS:'0'},stdio:['ignore','pipe','pipe']});
 let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);const timer=setTimeout(()=>child.kill('SIGKILL'),30000);const code=await new Promise(r=>child.once('exit',r));clearTimeout(timer);
 const results=stdout.split('\n').flatMap(l=>{try{return[JSON.parse(l)]}catch{return[]}}).filter(e=>e.type==='tool_execution_end');
 if(results.length!==calls.length)throw new Error(`Expected exactly ${calls.length} tool results, got ${results.length}; stderr: ${stderr.slice(-500)}`);
 const probe=results.slice(warmup.length),text=i=>JSON.stringify(probe[i]?.result??{}),blocked=i=>text(i).includes('TASK ENFORCEMENT');
 const proof={code,searchAllowed:!blocked(0)&&!probe[0].isError,getAllowed:!blocked(1)&&!probe[1].isError,rememberBlocked:blocked(2),toolResults:results.length};
 console.log(JSON.stringify(proof,null,2));if(process.env.DEBUG)for(const r of probe)console.log(r.isError,JSON.stringify(r.result).slice(0,400));if(!proof.searchAllowed||!proof.getAllowed||!proof.rememberBlocked)process.exitCode=1;
}finally{if(child&&child.exitCode===null)child.kill('SIGKILL');if(server)await new Promise(r=>server.close(r));await rm(root,{recursive:true,force:true});}
