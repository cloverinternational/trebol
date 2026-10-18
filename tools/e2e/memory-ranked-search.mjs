/** memory_history search must surface a stored fact for an agent-style query
 * whose words do not ALL occur in the record (pair-01 failure: 76% of real
 * agent searches returned nothing under the all-terms rule).
 * Real Pi, memory-history extension only, scripted provider that calls
 * memory_history search and records the tool result; isolated git repo and
 * PI_SWARM_MEMORY_DIR seeded through the real KnowledgeStore; no embeddings.
 * 1. multi-word query, not every word in the record -> the fact is returned, ranked first;
 * 2. near miss: a query sharing no word with any record returns no records.
 * Run: node tools/e2e/memory-ranked-search.mjs */
import {createServer} from 'node:http';import {mkdtemp,mkdir,writeFile,rm,realpath} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';import {spawn,execFileSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
import {createJiti} from '../../node_modules/jiti/lib/jiti.mjs';
const repo=resolve(fileURLToPath(new URL('../../',import.meta.url))),root=await realpath(await mkdtemp(join(tmpdir(),'mem-ranked-')));
const step=(n,ok,d)=>{console.log(`${ok?'PASS':'FAIL'} step ${n}: ${d}`);if(!ok)throw new Error(`step ${n} failed`);};
const ws=join(root,'ws'),mem=join(root,'mem');await mkdir(ws);execFileSync('git',['init','-q',ws]);
process.env.PI_SWARM_MEMORY_DIR=mem;delete process.env.PI_SWARM_MEMORY_EMBED_URL;
const {openKnowledgeStore}=await createJiti(import.meta.url).import('../../.pi/lib/state/knowledge-store.ts');
const store=openKnowledgeStore({cwd:ws,scope:'repository',root:mem});
const fact=store.put({text:'TaskManage rejects a completion whose answer cites tool:Name#n when that result is not in the current session branch; the error reason is tool_result_unavailable and lists available names.',kind:'fact',tags:['taskmanage']});
store.put({text:'The footer is owned by conversation-metrics; other extensions add segments through the footer registry.',kind:'fact'});
let query,result,server;
async function run(q){query=q;result=undefined;const agent=join(root,`agent-${Date.now()}`);await mkdir(agent,{recursive:true});
  await writeFile(join(agent,'models.json'),JSON.stringify({providers:{local:{baseUrl:`http://127.0.0.1:${server.address().port}/v1`,api:'openai-completions',apiKey:'dummy',models:[{id:'script',contextWindow:200000,maxTokens:4096}]}}}));
  const c=spawn('pi',['--model','local/script','--no-extensions','--extension',join(repo,'extensions/memory-history/index.ts'),'--no-skills','--no-session','--mode','json','--print','--','go'],{cwd:ws,env:{...process.env,PI_CODING_AGENT_DIR:agent},stdio:['ignore','pipe','pipe']});
  c.stdout.resume();c.stderr.resume();const t=setTimeout(()=>c.kill('SIGKILL'),90000);const code=await new Promise(r=>c.once('exit',r));clearTimeout(t);return code;}
const sse=(res,deltas)=>{res.writeHead(200,{'content-type':'text/event-stream'});for(const [i,d] of deltas.entries())res.write(`data: ${JSON.stringify({id:'x',object:'chat.completion.chunk',created:0,model:'script',choices:[{index:0,delta:d,finish_reason:i===deltas.length-1?(d.tool_calls?'tool_calls':'stop'):null}]})}\n\n`);res.end('data: [DONE]\n\n');};
try{
  server=createServer(async(req,res)=>{let raw='';for await(const x of req)raw+=x;const b=JSON.parse(raw);const tool=(b.messages??[]).find(m=>m.role==='tool');
    if(!tool)return sse(res,[{role:'assistant',tool_calls:[{index:0,id:'c1',type:'function',function:{name:'memory_history',arguments:JSON.stringify({operation:'search',scope:'all',query})}}]}]);
    result=typeof tool.content==='string'?tool.content:(tool.content??[]).map(p=>p.text??'').join('');sse(res,[{role:'assistant',content:'done'}]);});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  let code=await run('why was my TaskManage completion rejected with tool_result_unavailable evidence');let j=JSON.parse(result??'{}');
  step(1,code===0&&j.knowledge?.[0]?.id===fact.id,`fact ranked first for agent-style query (exit ${code}, got ${j.knowledge?.length??'no result'} records${j.ranking?`, ranking ${j.ranking}`:''})`);
  code=await run('kubernetes helm chart');j=JSON.parse(result??'{}');
  step(2,code===0&&Array.isArray(j.knowledge)&&j.knowledge.length===0,`near miss: unrelated query returns no records (got ${j.knowledge?.length})`);
  console.log('PASS');
}finally{if(server)await new Promise(r=>server.close(r));await rm(root,{recursive:true,force:true});}
