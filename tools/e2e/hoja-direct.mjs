/** Real installed Pi + local scripted provider; no Hoja network calls or model service.
 * Run: node tools/e2e/hoja-direct.mjs */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
const repo = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const root = await mkdtemp(join(tmpdir(), 'hoja-direct-'));
const names = ['hoja_list','hoja_get','hoja_projects','hoja_teams','hoja_issues','hoja_issue','hoja_search_issues','hoja_issue_create','hoja_issue_update','hoja_issue_delete','hoja_comment_create'];
let payloads = [];
const server = createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  payloads.push(JSON.parse(raw));
  res.writeHead(200, {'content-type':'text/event-stream'});
  for (const delta of [{role:'assistant',content:'Fixture complete; no tools called.'},{}]) {
    res.write(`data: ${JSON.stringify({id:'test',object:'chat.completion.chunk',created:0,model:'fixture',choices:[{index:0,delta,finish_reason:Object.keys(delta).length ? null : 'stop'}]})}\n\n`);
  }
  res.end('data: [DONE]\n\n');
});
try {
  await new Promise(r => server.listen(0,'127.0.0.1',r));
  const agent = join(root,'agent'), ws = join(root,'ws');
  await mkdir(agent); await mkdir(ws);
  await writeFile(join(agent,'models.json'),JSON.stringify({providers:{local:{baseUrl:`http://127.0.0.1:${server.address().port}/v1`,api:'openai-completions',apiKey:'fixture-not-secret',models:[{id:'fixture',contextWindow:200000,maxTokens:1024,reasoning:false}]}}}));
  async function run(extra = []) {
    payloads = [];
    const args = ['--model','local/fixture','--no-extensions', ...['hoja-mode','swarm-transport-parity'].flatMap(e=>['-e',join(repo,'extensions',e,'index.ts')]),'--no-mcp','--no-skills','--no-session','--no-context-files','--mode','json','--print',...extra,'--','Return fixture acknowledgement without calling tools.'];
    const env = {...process.env,PI_CODING_AGENT_DIR:agent};
    for (const key of ['PI_CLAW_RUN','LINEAR_TOKEN','HOJA_API_KEY','PI_SWARM_EXTRA_TOOLS','PI_SWARM_TOOL_SURFACE']) delete env[key];
    const child = spawn('pi',args,{cwd:ws,env,stdio:['ignore','pipe','pipe']});
    let err = ''; child.stderr.on('data',b=>err+=b); child.stdout.resume();
    const timer = setTimeout(()=>child.kill('SIGKILL'),60000);
    const code = await new Promise((r,j)=>{child.on('error',j);child.on('exit',r);}); clearTimeout(timer);
    assert.equal(code,0,err.slice(-1000)); assert.ok(payloads.length);
    return payloads[0];
  }
  let p = await run();
  const sent = p.tools.map(t=>t.function?.name ?? t.name);
  for (const name of names) assert.equal(sent.filter(n=>n===name).length,1,`${name} directly declared exactly once`);
  const update = p.tools.find(t=>t.function?.name==='hoja_issue_update').function;
  assert.equal(update.parameters.additionalProperties,false);
  assert.ok(update.description.includes('explicitly requested by the user'));
  console.log('PASS actual provider payload: all eleven native Hoja names exactly once, strict schemas and consent descriptions');
  p = await run(['--exclude-tools','hoja_issue_delete']);
  assert.ok(!p.tools.some(t=>(t.function?.name??t.name)==='hoja_issue_delete'));
  console.log('PASS explicit denylist remains authoritative; deleted tool not resurrected');
} finally {
  await new Promise(r=>server.close(r));
  await rm(root,{recursive:true,force:true});
}
