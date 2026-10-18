/** The bootstrap tool is removed. Real Pi loads every extension in package.json
 * (pi.extensions) in a fresh workspace with a scripted provider that records the
 * tools and system prompt of the first request.
 * 1. the session runs and the model is offered tools (TaskManage present);
 * 2. no `bootstrap` tool is offered and no prompt text tells the agent to call it;
 * 3. near miss: memory_history is still offered (only bootstrap was removed).
 * Run: node tools/e2e/no-bootstrap-surface.mjs */
import {createServer} from 'node:http';import {mkdtemp,mkdir,writeFile,rm,realpath,readFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';import {spawn,execFileSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
const repo=resolve(fileURLToPath(new URL('../../',import.meta.url))),root=await realpath(await mkdtemp(join(tmpdir(),'no-bootstrap-')));
const step=(n,ok,d)=>{console.log(`${ok?'PASS':'FAIL'} step ${n}: ${d}`);if(!ok)throw new Error(`step ${n} failed`);};
const requests=[];let server;
try{
  server=createServer(async(req,res)=>{let raw='';for await(const x of req)raw+=x;const b=JSON.parse(raw);
    requests.push({tools:(b.tools??[]).map(t=>t.function?.name??t.name),system:(b.messages??[]).filter(m=>m.role==='system'||m.role==='developer').map(m=>typeof m.content==='string'?m.content:m.content.map(p=>p.text??'').join('')).join('\n')});
    res.writeHead(200,{'content-type':'text/event-stream'});
    for(const delta of [{role:'assistant',content:'ok'},{}])res.write(`data: ${JSON.stringify({id:'x',object:'chat.completion.chunk',created:0,model:'script',choices:[{index:0,delta,finish_reason:Object.keys(delta).length?null:'stop'}]})}\n\n`);
    res.end('data: [DONE]\n\n');});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const ws=join(root,'ws'),agent=join(root,'agent');await mkdir(ws);await mkdir(agent);execFileSync('git',['init','-q',ws]);
  await writeFile(join(agent,'models.json'),JSON.stringify({providers:{local:{baseUrl:`http://127.0.0.1:${server.address().port}/v1`,api:'openai-completions',apiKey:'dummy',models:[{id:'script',contextWindow:200000,maxTokens:2048,reasoning:false}]}}}));
  const exts=JSON.parse(await readFile(join(repo,'package.json'),'utf8')).pi.extensions.flatMap(e=>['--extension',join(repo,e)]);
  const c=spawn('pi',['--model','local/script','--no-extensions',...exts,'--no-skills','--no-session','--mode','json','--print','--','Fix the failing test in this repository.'],{cwd:ws,env:{...process.env,PI_CODING_AGENT_DIR:agent,PI_SWARM_MEMORY_DIR:join(root,'mem')},stdio:['ignore','pipe','pipe']});
  let err='';c.stderr.on('data',b=>err+=b);c.stdout.resume();const t=setTimeout(()=>c.kill('SIGKILL'),120000);
  const code=await new Promise(r=>c.once('exit',r));clearTimeout(t);
  const first=requests[0]??{tools:[],system:''};
  step(1,code===0&&first.tools.includes('TaskManage'),`session ran with ${first.tools.length} tools (exit ${code}) ${err.slice(-300)}`);
  step(2,!first.tools.some(n=>/^bootstrap$/i.test(n))&&!/call bootstrap|bootstrap first/i.test(first.system),'no bootstrap tool or instruction offered');
  step(3,first.tools.includes('memory_history'),'near miss: memory_history still offered');
  console.log('PASS');
}finally{if(server)await new Promise(r=>server.close(r));await rm(root,{recursive:true,force:true});}
