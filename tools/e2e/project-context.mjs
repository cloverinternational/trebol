/** Real Pi + project_context tool -> Agent-MCP ask_project_rag on spark (EmbeddingGemma 2).
 * Run 1: valid token; the top hit must cite a local path#Lx-Ly whose lines contain the gate-exemption fact.
 * Run 2 (near miss): wrong token; the tool must fail with Agent-MCP's Unauthorized, not return chunks. */
import {createServer} from 'node:http';import {mkdtemp,mkdir,writeFile,rm,readFile,realpath} from 'node:fs/promises';import {tmpdir,homedir} from 'node:os';import {join,resolve} from 'node:path';import {spawn} from 'node:child_process';import {fileURLToPath} from 'node:url';
const repo=resolve(fileURLToPath(new URL('../../',import.meta.url)));
const token=process.env.PROJECT_CONTEXT_TOKEN||(await readFile(join(homedir(),'.config/agent-mcp/spark-token'),'utf8')).trim();
const query='Which memory_history operations are exempt from the task enforcement gate?';

async function run(tok){
 const root=await realpath(await mkdtemp(join(tmpdir(),'project-context-'))),agent=join(root,'agent');let server,child;
 const calls=[{name:'project_context',arguments:{query,limit:3}}];
 try{
  await mkdir(agent,{recursive:true});
  server=createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;const b=JSON.parse(raw);const n=(b.messages??[]).filter(m=>m.role==='tool').length;const t=calls[n];
   res.writeHead(200,{'content-type':'text/event-stream'});
   const delta=t?{role:'assistant',tool_calls:[{index:0,id:`call-${n}`,type:'function',function:{name:t.name,arguments:JSON.stringify(t.arguments)}}]}:{role:'assistant',content:'done'};
   res.write(`data: ${JSON.stringify({id:'x',object:'chat.completion.chunk',created:0,model:'script',choices:[{index:0,delta,finish_reason:null}]})}\n\n`);
   res.write(`data: ${JSON.stringify({id:'x',object:'chat.completion.chunk',created:0,model:'script',choices:[{index:0,delta:{},finish_reason:t?'tool_calls':'stop'}]})}\n\n`);
   res.end('data: [DONE]\n\n');});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  await writeFile(join(agent,'models.json'),JSON.stringify({providers:{local:{baseUrl:`http://127.0.0.1:${server.address().port}/v1`,api:'openai-completions',apiKey:'dummy',models:[{id:'script',contextWindow:100000,maxTokens:2048,reasoning:false}]}}}));
  const args=['--model','local/script','--no-extensions','--extension',join(repo,'extensions/project-context/extension.ts'),'--no-tools','--tools','project_context','--no-skills','--no-context-files','--no-session','--mode','json','--print','--approve','--','Look up project context.'];
  child=spawn('pi',args,{cwd:repo,env:{...process.env,HOME:root,PI_CODING_AGENT_DIR:agent,PROJECT_CONTEXT_TOKEN:tok,PI_SWARM_SUBAGENT:'0'},stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);const timer=setTimeout(()=>child.kill('SIGKILL'),60000);await new Promise(r=>child.once('exit',r));clearTimeout(timer);
  const results=stdout.split('\n').flatMap(l=>{try{return[JSON.parse(l)]}catch{return[]}}).filter(e=>e.type==='tool_execution_end');
  if(results.length!==1)throw new Error(`Expected 1 tool result, got ${results.length}; stderr: ${stderr.slice(-500)}`);
  return results[0];
 }finally{if(child&&child.exitCode===null)child.kill('SIGKILL');if(server)await new Promise(r=>server.close(r));await rm(root,{recursive:true,force:true});}
}

const ok=await run(token);
const chunks=ok.result?.details?.chunks??[];const top=chunks[0];
let citedText='';const m=/^(.+)#L(\d+)-L(\d+)$/.exec(top?.cite??'');
if(m)citedText=(await readFile(join(repo,m[1]),'utf8')).split('\n').slice(+m[2]-1,+m[3]).join('\n');
const bad=await run('wrong-token');
const badText=JSON.stringify(bad.result??{});
const proof={
 okIsError:!!ok.isError,chunks:chunks.length,top:top?.cite,topDistance:top?.distance,
 topCitesLineRange:!!m,citedLinesHoldFact:/memory_history/.test(citedText)&&/`?search`?\s*(or|\/)\s*`?get`?/.test(citedText),
 allCited:chunks.every(c=>c.cite&&!c.stale),
 wrongTokenRejected:!!bad.isError&&/Unauthorized/.test(badText),
};
console.log(JSON.stringify(proof,null,2));if(process.env.DEBUG)console.log(JSON.stringify(ok.result).slice(0,1500));
if(proof.okIsError||!proof.topCitesLineRange||!proof.citedLinesHoldFact||!proof.allCited||!proof.wrongTokenRejected)process.exitCode=1;
