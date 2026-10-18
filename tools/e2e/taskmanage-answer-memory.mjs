/** Real Pi + TaskManage + task-candidate-capture: completed answers become
 * per-answer memory records; evidence-anchored ones are verified and returned by
 * recallKnowledge (the function bootstrap calls), go stale when a cited span is
 * edited, and path-only evidence stays candidate.
 * Run: node tools/e2e/taskmanage-answer-memory.mjs */
import {createJiti} from 'jiti';
import {createServer} from 'node:http';import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,realpath} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';import {spawn,execFileSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
const repo=resolve(fileURLToPath(new URL('../../',import.meta.url))),root=await realpath(await mkdtemp(join(tmpdir(),'answer-memory-'))),agent=join(root,'agent'),workspace=join(root,'workspace'),memory=join(root,'memory');
process.env.PI_SWARM_MEMORY_DIR=memory;
let server,child;
const step=(n,ok,detail)=>{console.log(`${ok?'PASS':'FAIL'} step ${n}: ${detail}`);if(!ok)throw new Error(`step ${n} failed`);};
const op=(ops)=>({name:'TaskManage',arguments:{operations:ops}});
const calls=[
 op([{key:'t',op:'create',subject:'Explain the greeting',questions:[{id:'impl',text:'Where is greet implemented?'},{id:'doc',text:'Where is setup documented?'}],status:'in_progress',active:true}]),
 {name:'read',arguments:{path:'src/greet.ts'}},
 op([{key:'c',op:'update',taskId:'1',status:'completed',answers:[
   {question:'impl',answer:'greet returns a hello string built from the name.',evidence:'src/greet.ts#L2-L3; tool:read#1'},
   {question:'doc',answer:'Setup is documented in the guide Setup section.',evidence:'docs/guide.md#Setup'}]}]),
 op([{key:'t2',op:'create',subject:'Name the config file',questions:[{id:'cfg',text:'Which file holds config?'}],status:'in_progress',active:true}]),
 op([{key:'c2',op:'update',taskId:'2',status:'completed',answers:[{question:'cfg',answer:'Config lives in src/greet.ts.',evidence:'src/greet.ts'}]}]),
 op([{key:'l',op:'list'}]),
];
try{
 await mkdir(agent,{recursive:true});await mkdir(join(workspace,'src'),{recursive:true});await mkdir(join(workspace,'docs'),{recursive:true});
 await writeFile(join(workspace,'src/greet.ts'),'// greeting module\nexport function greet(name: string) {\n  return `hello ${name}`;\n}\nexport const unrelated = 1;\n');
 await writeFile(join(workspace,'docs/guide.md'),'# Guide\n\n## Setup\n\nRun the installer.\n');
 execFileSync('git',['init','-q'],{cwd:workspace});
 server=createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;const b=JSON.parse(raw);const n=(b.messages??[]).filter(m=>m.role==='tool').length;const t=calls[n];
  res.writeHead(200,{'content-type':'text/event-stream'});
  const delta=t?{role:'assistant',tool_calls:[{index:0,id:`call-${n}`,type:'function',function:{name:t.name,arguments:JSON.stringify(t.arguments)}}]}:{role:'assistant',content:'done'};
  res.write(`data: ${JSON.stringify({id:'x',object:'chat.completion.chunk',created:0,model:'script',choices:[{index:0,delta,finish_reason:null}]})}\n\n`);
  res.write(`data: ${JSON.stringify({id:'x',object:'chat.completion.chunk',created:0,model:'script',choices:[{index:0,delta:{},finish_reason:t?'tool_calls':'stop'}]})}\n\n`);
  res.end('data: [DONE]\n\n');});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 await writeFile(join(agent,'models.json'),JSON.stringify({providers:{local:{baseUrl:`http://127.0.0.1:${server.address().port}/v1`,api:'openai-completions',apiKey:'dummy',models:[{id:'script',contextWindow:100000,maxTokens:2048,reasoning:false}]}}}));
 const args=['--model','local/script','--no-extensions','--extension',join(repo,'extensions/taskmanage/extension.ts'),'--extension',join(repo,'extensions/task-candidate-capture/extension.ts'),'--no-tools','--tools','TaskManage,read','--no-skills','--no-context-files','--mode','json','--print','--approve','--','Answer with evidence.'];
 child=spawn('pi',args,{cwd:workspace,env:{...process.env,HOME:root,PI_CODING_AGENT_DIR:agent,PI_SWARM_MEMORY_DIR:memory,PI_SWARM_SUBAGENT:'0'},stdio:['ignore','pipe','pipe']});
 let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);const timer=setTimeout(()=>child.kill('SIGKILL'),60000);const code=await new Promise(r=>child.once('exit',r));clearTimeout(timer);
 const results=stdout.split('\n').flatMap(l=>{try{return[JSON.parse(l)]}catch{return[]}}).filter(e=>e.type==='tool_execution_end');
 if(process.env.DEBUG)for(const r of results)console.log(r.toolName,r.isError,JSON.stringify(r.result).slice(0,300));
 step(1,code===0&&results.length===calls.length&&results.every(r=>!r.isError),`pi exit ${code}, ${results.length}/${calls.length} tool results, errors=${results.filter(r=>r.isError).length} ${stderr.slice(-300)}`);
 const jiti=createJiti(import.meta.url);
 const {openKnowledgeStore}=await jiti.import(join(repo,'.pi/lib/state/knowledge-store.ts'));
 const {recallKnowledge}=await jiti.import(join(repo,'.pi/lib/context/knowledge-recall.ts'));
 const answers=()=>openKnowledgeStore({cwd:workspace,scope:'worktree'}).snapshot().filter(r=>r.source.startsWith('taskmanage-answer:'));
 const rec=(q)=>answers().find(r=>r.source.endsWith(`:${q}`));
 const impl=rec('impl'),doc=rec('doc'),cfg=rec('cfg');
 step(2,answers().length===3&&impl&&doc&&cfg,`3 per-answer records: ${answers().map(r=>r.source.split(':').slice(-2).join('/')).join(', ')}`);
 const toolRef=impl.evidence.find(e=>/\.jsonl#/.test(e.ref));
 step(3,impl.status==='verified'&&doc.status==='verified'&&impl.evidence.some(e=>e.ref==='src/greet.ts#L2-L3'&&e.quote.includes('export function greet'))&&toolRef?.quote.includes('hello'),`impl ${impl.status} (span + tool ${toolRef?.ref.split('/').pop()}), doc ${doc.status} (${doc.evidence[0]?.ref})`);
 const all=[];for(const scope of ['worktree']){const dir=join(memory,'knowledge',scope);for(const d of await readdir(dir))for(const f of await readdir(join(dir,d),{recursive:true}))if(f.endsWith('.json')){const e=JSON.parse(await readFile(join(dir,d,f),'utf8'));if(e.record?.id===impl.id)all.push(e);}}
 step(4,all.length===1,`impl record has ${all.length} revision(s) after ${calls.length} capture passes (dedupe)`);
 let r=recallKnowledge(workspace,'where is greet implemented');
 step(5,r.memories.some(m=>m.id.includes(impl.id))&&!r.memories.some(m=>m.id.includes(cfg.id)),`recall hits impl; candidatesExcluded=${r.candidatesExcluded} staleExcluded=${r.staleExcluded}`);
 step(6,cfg.status==='candidate'&&cfg.tags.includes('evidence-unanchored'),`path-only answer stays ${cfg.status} and is not recalled`);
 const src=join(workspace,'src/greet.ts');let text=await readFile(src,'utf8');
 await writeFile(src,text.replace('export const unrelated = 1;','export const unrelated = 2;'));
 r=recallKnowledge(workspace,'where is greet implemented');
 step(7,r.memories.some(m=>m.id.includes(impl.id))&&r.staleExcluded===0,`near miss: editing an uncited line keeps impl verified (staleExcluded=${r.staleExcluded})`);
 text=await readFile(src,'utf8');await writeFile(src,text.replace('return `hello ${name}`;','return `hi ${name}`;'));
 r=recallKnowledge(workspace,'where is greet implemented');
 step(8,!r.memories.some(m=>m.id.includes(impl.id))&&r.staleExcluded===1,`editing cited span excludes impl as stale (staleExcluded=${r.staleExcluded}); doc still recallable=${recallKnowledge(workspace,'setup documented guide').memories.some(m=>m.id.includes(doc.id))}`);
 const sub=recallKnowledge(join(workspace,'docs'),'setup documented guide');
 step(9,sub.memories.some(m=>m.id.includes(doc.id))&&sub.staleExcluded===1,`recall from subdirectory docs/ uses the same worktree store and re-checks against the worktree root: doc recalled=${sub.memories.some(m=>m.id.includes(doc.id))}, staleExcluded=${sub.staleExcluded} (only the edited impl)`);
 console.log('PASS');
}finally{if(child&&child.exitCode===null)child.kill('SIGKILL');if(server)await new Promise(r=>server.close(r));await rm(root,{recursive:true,force:true});}
