// Downstream A/B runner (see PREREG-ab.md). Run from repo root: node artifacts/memory-audit/ab/run_ab.mjs
import {spawn} from 'node:child_process';import {readFileSync,writeFileSync,existsSync,mkdirSync} from 'node:fs';import {join,resolve,dirname} from 'node:path';import {fileURLToPath} from 'node:url';
const here=dirname(fileURLToPath(import.meta.url));const repo=resolve(here,'../../..');const out=join(here,'runs');mkdirSync(out,{recursive:true});
const MODEL='clover-plexus-anthropic/claude-haiku-5-5';
const Qs=readFileSync(join(here,'ab-questions.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
const prompt=q=>`You are working in this repository (current directory). A developer searched for \`${q.text}\` while working on this request:\n\n"""${q.need}"""\n\nFind the code or documentation in this repository that the developer needed. Reply with up to 3 citations, most relevant first, one per line, each exactly in the form path/from/repo/root#Lstart-Lend, and nothing else.`;
const base=['--model',MODEL,'--no-extensions','--no-skills','--no-context-files','--no-session','--no-prompt-templates','--no-mcp','--mode','json','--no-tools'];
const args={A:[...base,'--extension',join(repo,'extensions/project-context/extension.ts'),'--tools','read,grep,find,ls,project_context'],B:[...base,'--tools','read,grep,find,ls']};
function run(arm,q,attempt){return new Promise(res=>{const t0=Date.now();const c=spawn('pi',[...args[arm],'-p',prompt(q)],{cwd:repo,env:{...process.env,PI_SWARM_SUBAGENT:'0'},stdio:['ignore','pipe','pipe']});
 let so='',se='';c.stdout.on('data',b=>so+=b);c.stderr.on('data',b=>se+=b);const k=setTimeout(()=>c.kill('SIGKILL'),300000);
 c.on('exit',(code,sig)=>{clearTimeout(k);const f=join(out,`${q.qid}-${arm}-${attempt}.jsonl`);writeFileSync(f,so);writeFileSync(f+'.err',se);res({code,sig,ms:Date.now()-t0,f})})})}
const only=process.argv[2];
for(const [i,q] of Qs.entries()){if(only&&q.qid!==only)continue;
 for(const arm of (i%2===0?['A','B']:['B','A'])){
  if(existsSync(join(out,`${q.qid}-${arm}-1.jsonl`))&&!only){console.log('skip',q.qid,arm);continue}
  let r=await run(arm,q,1);let bad=r.code!==0;
  const pcErr=readFileSync(r.f,'utf8').split('\n').some(l=>{try{const e=JSON.parse(l);return e.type==='tool_execution_end'&&e.toolName==='project_context'&&e.isError&&/fetch failed|ECONNREFUSED|ETIMEDOUT|Unauthorized/.test(JSON.stringify(e.result))}catch{return false}});
  if(bad||pcErr){console.log('invalid',q.qid,arm,r.code,r.sig,pcErr?'spark':'');r=await run(arm,q,2)}
  console.log(q.qid,arm,'exit',r.code,'ms',r.ms)}}
