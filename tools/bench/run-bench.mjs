/** Prompt benchmark runner. Every task x arm x rep is one isolated traced Pi
 * session (tools/pilot/run-session.mjs) with the extension pack pinned to
 * --product and the arm prompt as the workspace's active custom prompt.
 * Graded immediately after the run, in the run's own worktree:
 *  fix: overlay the fix commit's shipped test files (hidden from the agent:
 *       the agent saw the parent versions) and run vitest on them; pass = exit 0.
 *  q:   final reply citations vs sealed qrels (same rule as ab/score_ab.py:
 *       pass = a cited range overlaps a grade-2 span of the same file).
 * Appends one JSON line per run to OUT/results.jsonl; skips runs already there.
 * Order: per (task, rep) the arm order is a seeded shuffle.
 * Usage: node tools/bench/run-bench.mjs --tasks F --arms F,M,FM,FL --reps N
 *        --product SHA --out DIR [--only id,id] [--jobs 4] [--seed 1] */
import {spawn,execFileSync} from 'node:child_process';import {readFileSync,appendFileSync,existsSync,mkdirSync,writeFileSync} from 'node:fs';import {join,resolve,dirname} from 'node:path';import {fileURLToPath} from 'node:url';
const repo=resolve(fileURLToPath(new URL('../../',import.meta.url)));
const arg=(k,d)=>{const i=process.argv.indexOf(`--${k}`);return i>0?process.argv[i+1]:d;};
const out=resolve(arg('out')),arms=arg('arms','F,M,FM,FL').split(','),reps=Number(arg('reps',1)),product=arg('product'),jobs=Number(arg('jobs',4));
const only=arg('only')?.split(','),seed0=Number(arg('seed',1));
const tasks=JSON.parse(readFileSync(resolve(arg('tasks')),'utf8')).tasks.filter(t=>!only||only.includes(t.id));
mkdirSync(out,{recursive:true});const resF=join(out,'results.jsonl');
const done=new Set(existsSync(resF)?readFileSync(resF,'utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l).run):[]);
// qrels (same construction as ab/score_ab.py)
const E=join(repo,'artifacts/memory-audit/eval');const P={};
for(const l of readFileSync(join(E,'passages.jsonl'),'utf8').split('\n').filter(Boolean)){const x=JSON.parse(l);if(x.lines&&!x.summary)P[x.doc]=x;}
const G={};for(const l of readFileSync(join(E,'qrels.jsonl'),'utf8').split('\n').filter(Boolean)){const x=JSON.parse(l);if(P[x.doc])(G[x.qid]??=[]).push([P[x.doc].ref,P[x.doc].lines[0],P[x.doc].lines[1],x.grade]);}
let s=seed0;const rnd=()=>(s=(s*1103515245+12345)%2147483648)/2147483648;
const shuffle=a=>{a=[...a];for(let i=a.length-1;i>0;i--){const j=Math.floor(rnd()*(i+1));[a[i],a[j]]=[a[j],a[i]];}return a;};
const queue=[];for(let r=1;r<=reps;r++)for(const t of tasks)for(const a of shuffle(arms))queue.push({t,a,r,run:`${t.id}.${a}.${r}`});
const sh=(cmd,args,cwd,ms=600000)=>new Promise(res=>{const c=spawn(cmd,args,{cwd,stdio:['ignore','pipe','pipe']});let o='';c.stdout.on('data',b=>o+=b);c.stderr.on('data',b=>o+=b);const k=setTimeout(()=>c.kill('SIGKILL'),ms);c.on('exit',code=>{clearTimeout(k);res({code,o});});});
function finalText(sessionFile){if(!existsSync(sessionFile))return '';let last='';for(const l of readFileSync(sessionFile,'utf8').split('\n')){if(!l)continue;let e;try{e=JSON.parse(l)}catch{continue}
  if(e.type==='message'&&e.message.role==='assistant'){const t=e.message.content.filter(p=>p.type==='text').map(p=>p.text).join('');if(t.trim())last=t;}}return last;}
async function grade(t,ws,dir){
  if(t.kind==='fix'){const {fixCommit,tests}=t.check;execFileSync('git',['-C',ws,'checkout','-q',fixCommit,'--',...tests]);
    const r=await sh('npx',['vitest','run',...tests],ws,300000);const tail=r.o.split('\n').filter(l=>/Tests +\d/.test(l)).pop()?.trim()??'';
    const diff=execFileSync('git',['-C',ws,'diff','--stat','HEAD','--',':!'+tests.join(' :!')],{encoding:'utf8'}).trim().split('\n').pop()??'';
    return {pass:r.code===0?1:0,detail:tail,diff};}
  const text=finalText(join(dir,'session.jsonl'));const cites=[...text.matchAll(/([\w./@-]+\.\w+)#L(\d+)(?:-L?(\d+))?/g)].map(m=>[m[1].startsWith('./')?m[1].slice(2):m[1],+m[2],+(m[3]??m[2])]).slice(0,3);
  const judged=cites.map(([p,a,b])=>{let best=-1;for(const [ref,x,y,g] of G[t.check.qid]??[])if(ref===p&&a<=y&&b>=x)best=Math.max(best,g);return best;});
  return {pass:judged.some(g=>g===2)?1:0,pass1:judged.some(g=>g>=1)?1:0,cites,judged};}
function metrics(dir){const m={tools:[],errors:0,memory:0,blocked:0,modelCalls:0,maxCtx:0,modeLines:0};const f=join(dir,'session.jsonl');if(!existsSync(f))return m;
  for(const l of readFileSync(f,'utf8').split('\n')){if(!l)continue;let e;try{e=JSON.parse(l)}catch{continue};if(e.type!=='message')continue;const x=e.message;
    if(x.role==='assistant'){m.modelCalls++;for(const p of x.content){if(p.type==='toolCall'){m.tools.push(p.name);if(['memory_history','project_context','bootstrap','context_search'].includes(p.name))m.memory++;}if(p.type==='text'&&/#\s*Mode:\s*(PLAN|ACT|AUTO|DEBUG)|\b(PLAN|ACT|DEBUG) mode\b/i.test(p.text))m.modeLines++;}}
    if(x.role==='toolResult'&&x.isError){m.errors++;const t=(x.content||[]).map(p=>p.text||'').join('');if(/block|requires a focused|denied/i.test(t))m.blocked++;}}
  const tr=join(dir,'trace');try{for(const p of execFileSync('ls',[tr],{encoding:'utf8'}).split('\n').filter(Boolean))for(const l of readFileSync(join(tr,p,'index.jsonl'),'utf8').split('\n').filter(Boolean)){const x=JSON.parse(l);if(x.reqBytes)m.maxCtx=Math.max(m.maxCtx,x.reqBytes);}}catch{}
  return m;}
async function one(job){const {t,a,r,run}=job;if(done.has(run))return;const dir=join(out,'runs',run);
  const s=await sh('node',[join(repo,'tools/pilot/run-session.mjs'),'--out',dir,'--memory',join(out,'mem',run),'--commit',t.commit,'--product',product,'--prompt',join(repo,'artifacts/prompt-bench/arms',`${a}.md`),'--task',t.task,'--timeout-s','600'],repo,700000);
  let meta={};try{meta=JSON.parse(readFileSync(join(dir,'meta.json'),'utf8'))}catch{}
  if(!meta.workspace){mkdirSync(dir,{recursive:true});writeFileSync(join(dir,'runner-error.txt'),`exit ${s.code}\n${s.o.slice(-8000)}`);}
  const g=meta.workspace?await grade(t,meta.workspace,dir).catch(e=>({pass:0,gradeError:String(e).slice(0,300)})):{pass:0,gradeError:'no-run'};
  const m=metrics(dir);const row={run,task:t.id,kind:t.kind,arm:a,rep:r,exit:meta.exit,seconds:meta.seconds,promptSha:meta.promptSha,product,...g,toolCalls:m.tools.length,errors:m.errors,blocked:m.blocked,memoryCalls:m.memory,modelCalls:m.modelCalls,modeLines:m.modeLines,tools:m.tools};
  appendFileSync(resF,JSON.stringify(row)+'\n');console.log(run,'pass',row.pass,'calls',row.toolCalls,'s',row.seconds,g.detail??'',g.gradeError??'');}
const workers=Array.from({length:jobs},async()=>{while(queue.length)await one(queue.shift());});await Promise.all(workers);
