/** #299: the Mermaid follow-up must not hijack the deliverable. Real Pi with
 * only the mermaid-response extension against a scripted provider that answers
 * every turn with a long diagram-less explanation and records each request.
 * (a) repro: an "explain ... tool:" prompt gets a follow-up that keeps the
 *     original request and does NOT name the hook's source files;
 * (b) near miss: a prompt about the Mermaid hook still gets the file list;
 * (c) subagent (PI_SWARM_SUBAGENT=1): no follow-up turn at all.
 * Run: node tools/e2e/mermaid-followup-stays-on-task.mjs */
import {createServer} from 'node:http';import {mkdtemp,mkdir,writeFile,rm,realpath} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';import {spawn} from 'node:child_process';import {fileURLToPath} from 'node:url';
const repo=resolve(fileURLToPath(new URL('../../',import.meta.url))),root=await realpath(await mkdtemp(join(tmpdir(),'mermaid-followup-')));
const step=(n,ok,detail)=>{console.log(`${ok?'PASS':'FAIL'} step ${n}: ${detail}`);if(!ok)throw new Error(`step ${n} failed`);};
const ANSWER='The rejection happens because evidence refs must use the exact registered tool name and a 1-based index among that tool\'s results on the current branch; mcp__Bash is not a registered name.';
let requests=[],server;
const lastUser=b=>{const m=[...(b.messages??[])].reverse().find(x=>x.role==='user');return typeof m?.content==='string'?m.content:(m?.content??[]).map(p=>p.text??'').join(' ');};
async function run(prompt,env={}){
  requests=[];const agent=join(root,`agent-${Math.random().toString(36).slice(2)}`);await mkdir(agent,{recursive:true});
  await writeFile(join(agent,'models.json'),JSON.stringify({providers:{local:{baseUrl:`http://127.0.0.1:${server.address().port}/v1`,api:'openai-completions',apiKey:'dummy',models:[{id:'script',contextWindow:100000,maxTokens:2048,reasoning:false}]}}}));
  const child=spawn('pi',['--model','local/script','--no-extensions','--extension',join(repo,'extensions/mermaid-response/extension.ts'),'--no-tools','--no-skills','--no-context-files','--no-session','--mode','json','--print','--',prompt],{cwd:root,env:{...process.env,HOME:root,PI_CODING_AGENT_DIR:agent,...env},stdio:['ignore','pipe','pipe']});
  let err='';child.stderr.on('data',b=>err+=b);child.stdout.resume();const t=setTimeout(()=>child.kill('SIGKILL'),60000);
  const code=await new Promise(r=>child.once('exit',r));clearTimeout(t);return {code,err,requests:[...requests]};
}
try{
  server=createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;const b=JSON.parse(raw);requests.push(b);
    res.writeHead(200,{'content-type':'text/event-stream'});
    for(const delta of [{role:'assistant',content:ANSWER},{}])res.write(`data: ${JSON.stringify({id:'x',object:'chat.completion.chunk',created:0,model:'script',choices:[{index:0,delta,finish_reason:Object.keys(delta).length?null:'stop'}]})}\n\n`);
    res.end('data: [DONE]\n\n');});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const repro='A TaskManage completion was rejected with `tool_result_unavailable` for the evidence ref `tool:mcp__Bash#3`. Explain the exact cause and give the correct reference form, citing the code.';
  let r=await run(repro);
  const f=r.requests[1]?lastUser(r.requests[1]):'';
  step(1,r.code===0&&r.requests.length===2,`repro prompt: exit ${r.code}, ${r.requests.length} model calls (answer + one follow-up) ${r.err.slice(-200)}`);
  step(2,!/mermaid-response\/extension\.ts|mermaid-followup\.ts/.test(f)&&/Stay on the user's original request/.test(f),`follow-up keeps the original task and names no hook files: "${f.slice(0,140)}..."`);
  r=await run('Explain how the mermaid response hook decides to send a follow-up.');
  const g=r.requests[1]?lastUser(r.requests[1]):'';
  step(3,r.requests.length===2&&/extensions\/mermaid-response\/extension\.ts/.test(g),`near miss: a prompt about the hook still gets the source file list (${r.requests.length} calls)`);
  r=await run(repro,{PI_SWARM_SUBAGENT:'1'});
  step(4,r.code===0&&r.requests.length===1,`subagent: ${r.requests.length} model call(s); no follow-up replaces the deliverable`);
  console.log('PASS');
}finally{if(server)await new Promise(r=>server.close(r));await rm(root,{recursive:true,force:true});}
