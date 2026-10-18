/** The Forge system prompt must reach the model on the FIRST request of a
 * session (headless and the hook warm-up notwithstanding). Real Pi, a workspace
 * with activePrompt = Forge (Modes is the default), swarm-prompt + memory-history extensions, scripted
 * provider that records each request's system prompt.
 * 1. first request carries Forge (delegation heading + system_information),
 *    not Pi's base prompt;
 * 2. memory_workflow covers questions and asks for keyword queries;
 * 3. near miss: an explicit --system-prompt base is still kept (not replaced).
 * Run: node tools/e2e/forge-prompt-first-turn.mjs */
import {createServer} from 'node:http';import {mkdtemp,mkdir,writeFile,rm,realpath} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';import {spawn,execFileSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
const repo=resolve(fileURLToPath(new URL('../../',import.meta.url))),root=await realpath(await mkdtemp(join(tmpdir(),'forge-first-')));
const step=(n,ok,d)=>{console.log(`${ok?'PASS':'FAIL'} step ${n}: ${d}`);if(!ok)throw new Error(`step ${n} failed`);};
let systems=[],server;
const ws=join(root,'ws');await mkdir(join(ws,'.pi','config'),{recursive:true});execFileSync('git',['init','-q',ws]);await writeFile(join(ws,'.pi','config','prompt-context.json'),JSON.stringify({version:1,prompts:[],activePrompt:'Forge Swarm Agent'}));
async function run(extra=[]){
  systems=[];const agent=join(root,`agent-${systems.length}-${Date.now()}`);await mkdir(agent,{recursive:true});
  await writeFile(join(agent,'models.json'),JSON.stringify({providers:{local:{baseUrl:`http://127.0.0.1:${server.address().port}/v1`,api:'openai-completions',apiKey:'dummy',models:[{id:'script',contextWindow:200000,maxTokens:2048,reasoning:false}]}}}));
  const exts=['swarm-prompt','memory-history'].flatMap(e=>['--extension',join(repo,'extensions',e,'index.ts')]);
  const c=spawn('pi',['--model','local/script','--no-extensions',...exts,'--no-skills','--no-session','--mode','json','--print',...extra,'--','Why was tool:mcp__Bash#3 rejected?'],{cwd:ws,env:{...process.env,PI_CODING_AGENT_DIR:agent,PI_SWARM_MEMORY_DIR:join(root,'mem')},stdio:['ignore','pipe','pipe']});
  let err='';c.stderr.on('data',b=>err+=b);c.stdout.resume();const t=setTimeout(()=>c.kill('SIGKILL'),90000);
  const code=await new Promise(r=>c.once('exit',r));clearTimeout(t);return {code,err};
}
try{
  server=createServer(async(req,res)=>{let raw='';for await(const x of req)raw+=x;const b=JSON.parse(raw);systems.push((b.messages??[]).filter(m=>m.role==='system'||m.role==='developer').map(m=>typeof m.content==='string'?m.content:m.content.map(p=>p.text??'').join('')).join('\n'));
    res.writeHead(200,{'content-type':'text/event-stream'});
    for(const delta of [{role:'assistant',content:'ok'},{}])res.write(`data: ${JSON.stringify({id:'x',object:'chat.completion.chunk',created:0,model:'script',choices:[{index:0,delta,finish_reason:Object.keys(delta).length?null:'stop'}]})}\n\n`);
    res.end('data: [DONE]\n\n');});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  let r=await run();const s=systems[0]??'';
  step(1,r.code===0&&s.includes('# Delegation (the Task tool)')&&s.includes('<system_information>')&&!s.startsWith('You are an expert coding assistant operating inside pi'),`first request is Forge (${s.length} chars, exit ${r.code}) ${r.err.slice(-200)}`);
  step(2,/project task or question/.test(s)&&/distinctive words of the task/.test(s)&&/results are ranked/.test(s),'memory_workflow covers questions and ranked keyword queries');
  r=await run(['--system-prompt','CUSTOM-BASE-PROMPT-MARKER']);const c=systems[0]??'';
  step(3,c.includes('CUSTOM-BASE-PROMPT-MARKER')&&!c.includes('# Delegation (the Task tool)'),'near miss: explicit --system-prompt base kept, Forge not forced');
  console.log('PASS');
}finally{if(server)await new Promise(r=>server.close(r));await rm(root,{recursive:true,force:true});}
