/** Modes is the default system prompt; Forge stays selectable. Real Pi, scripted
 * provider recording each request's system prompt, swarm-prompt + memory-history.
 * 1. fresh workspace with no prompt config: first request is the Modes prompt with
 *    its {{workspace}} block rendered for that workspace (not Forge, not Pi base);
 * 2. memory_workflow is still appended to the Modes prompt;
 * 3. near miss: activePrompt "Forge Swarm Agent" still yields Forge, not Modes.
 * Run: node tools/e2e/modes-default-prompt.mjs */
import {createServer} from 'node:http';import {mkdtemp,mkdir,writeFile,rm,realpath} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';import {spawn,execFileSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
const repo=resolve(fileURLToPath(new URL('../../',import.meta.url))),root=await realpath(await mkdtemp(join(tmpdir(),'modes-default-')));
const step=(n,ok,d)=>{console.log(`${ok?'PASS':'FAIL'} step ${n}: ${d}`);if(!ok)throw new Error(`step ${n} failed`);};
let systems=[],server,runs=0;
async function workspace(activePrompt){
  const ws=join(root,`ws-${++runs}`);await mkdir(ws,{recursive:true});execFileSync('git',['init','-q',ws]);
  if(activePrompt){await mkdir(join(ws,'.pi','config'),{recursive:true});await writeFile(join(ws,'.pi','config','prompt-context.json'),JSON.stringify({version:1,prompts:[],activePrompt}));}
  return ws;
}
async function run(cwd){
  systems=[];const agent=join(root,`agent-${runs}`);await mkdir(agent,{recursive:true});
  await writeFile(join(agent,'models.json'),JSON.stringify({providers:{local:{baseUrl:`http://127.0.0.1:${server.address().port}/v1`,api:'openai-completions',apiKey:'dummy',models:[{id:'script',contextWindow:200000,maxTokens:2048,reasoning:false}]}}}));
  const exts=['swarm-prompt','memory-history'].flatMap(e=>['--extension',join(repo,'extensions',e,'index.ts')]);
  const c=spawn('pi',['--model','local/script','--no-extensions',...exts,'--no-skills','--no-session','--mode','json','--print','--','What does this repository do?'],{cwd,env:{...process.env,PI_CODING_AGENT_DIR:agent,PI_SWARM_MEMORY_DIR:join(root,'mem')},stdio:['ignore','pipe','pipe']});
  let err='';c.stderr.on('data',b=>err+=b);c.stdout.resume();const t=setTimeout(()=>c.kill('SIGKILL'),90000);
  const code=await new Promise(r=>c.once('exit',r));clearTimeout(t);return {code,err,s:systems[0]??''};
}
try{
  server=createServer(async(req,res)=>{let raw='';for await(const x of req)raw+=x;const b=JSON.parse(raw);systems.push((b.messages??[]).filter(m=>m.role==='system'||m.role==='developer').map(m=>typeof m.content==='string'?m.content:m.content.map(p=>p.text??'').join('')).join('\n'));
    res.writeHead(200,{'content-type':'text/event-stream'});
    for(const delta of [{role:'assistant',content:'ok'},{}])res.write(`data: ${JSON.stringify({id:'x',object:'chat.completion.chunk',created:0,model:'script',choices:[{index:0,delta,finish_reason:Object.keys(delta).length?null:'stop'}]})}\n\n`);
    res.end('data: [DONE]\n\n');});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const fresh=await workspace();let r=await run(fresh);
  step(1,r.code===0&&r.s.includes('# Unified MCP Agent System Prompt')&&!r.s.includes('{{workspace}}')&&r.s.includes(`<current_working_directory>${fresh}</current_working_directory>`)&&!r.s.includes('# Delegation (the Task tool)'),`default is Modes with rendered workspace (${r.s.length} chars, exit ${r.code}) ${r.err.slice(-200)}`);
  step(2,r.s.includes('<memory_workflow>'),'memory_workflow appended to Modes');
  r=await run(await workspace('Forge Swarm Agent'));
  step(3,r.code===0&&r.s.includes('# Delegation (the Task tool)')&&!r.s.includes('# Unified MCP Agent System Prompt'),'near miss: Forge still selectable');
  console.log('PASS');
}finally{if(server)await new Promise(r=>server.close(r));await rm(root,{recursive:true,force:true});}
