/** Run the fact curator over a records snapshot (jsonl of KnowledgeRecord).
 * Each batch of <=8 records (duplicates clustered by embedding cosine >= 0.9 go
 * together) is given to a read-only Pi agent (read/grep/find/ls, repo cwd), whose
 * proposals are checked by .pi/lib/state/fact-curator.ts. Writes OUT/facts.jsonl,
 * OUT/dropped.jsonl, OUT/batches/<n>.json (raw replies). Never writes a store.
 * Usage: node tools/memory/curate-facts.mjs --records F --out DIR [--kinds fact] [--jobs 4] [--model M]
 * Embedding clustering needs PI_SWARM_MEMORY_EMBED_URL; without it batches are by source order. */
import {spawn} from 'node:child_process';import {readFileSync,writeFileSync,appendFileSync,existsSync,mkdirSync} from 'node:fs';import {join,resolve} from 'node:path';import {fileURLToPath} from 'node:url';
import {createJiti} from '../../node_modules/jiti/lib/jiti.mjs';
const repo=resolve(fileURLToPath(new URL('../../',import.meta.url)));const jiti=createJiti(import.meta.url);
const C=await jiti.import('../../.pi/lib/state/fact-curator.ts');
const arg=(k,d)=>{const i=process.argv.indexOf(`--${k}`);return i>0?process.argv[i+1]:d;};
const out=resolve(arg('out')),kinds=arg('kinds','fact').split(','),jobs=Number(arg('jobs',4)),model=arg('model');
mkdirSync(join(out,'batches'),{recursive:true});
const R=readFileSync(resolve(arg('records')),'utf8').trim().split('\n').map(JSON.parse).filter(r=>kinds.includes(r.kind));
// cluster near-duplicates
let order=R.map((_,i)=>i);const url=process.env.PI_SWARM_MEMORY_EMBED_URL;
if(url){const V=[];for(let i=0;i<R.length;i+=8){const res=await fetch(url.replace(/\/$/,'')+'/v1/embeddings',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'embeddinggemma-2',input:R.slice(i,i+8).map(r=>r.text.slice(0,6000))})});V.push(...(await res.json()).data.map(d=>d.embedding));}
  const p=R.map((_,i)=>i),f=i=>p[i]===i?i:(p[i]=f(p[i]));
  for(let i=0;i<R.length;i++)for(let j=i+1;j<R.length;j++){let s=0;for(let k=0;k<V[i].length;k++)s+=V[i][k]*V[j][k];if(s>=0.9)p[f(i)]=f(j);}
  const g=new Map();R.forEach((_,i)=>{const r=f(i);g.set(r,[...(g.get(r)??[]),i]);});order=[...g.values()].sort((a,b)=>b.length-a.length).flat();
  writeFileSync(join(out,'clusters.json'),JSON.stringify([...g.values()].filter(x=>x.length>1).map(x=>x.map(i=>R[i].id))));}
const batches=[];for(let i=0;i<order.length;i+=8)batches.push(order.slice(i,i+8).map(i=>R[i]));
const sh=(args,input)=>new Promise(res=>{const c=spawn('pi',args,{cwd:repo,stdio:['ignore','pipe','pipe'],env:{...process.env,PI_SWARM_SUBAGENT:'1'}});let o='',e='';c.stdout.on('data',b=>o+=b);c.stderr.on('data',b=>e+=b);const k=setTimeout(()=>c.kill('SIGKILL'),600000);c.on('exit',code=>{clearTimeout(k);res({code,o,e});});});
async function one(n){const f=join(out,'batches',`${n}.json`);if(existsSync(f))return;const recs=batches[n];
  const args=[...(model?['--model',model]:[]),'--no-extensions','--no-skills','--no-context-files','--no-session','--no-prompt-templates','--tools','read,grep,find,ls','--mode','json','-p',C.curatorPrompt(recs)];
  let r,parsed,err;for(let t=0;t<2&&!parsed;t++){r=await sh(args);let last='';for(const l of r.o.split('\n')){try{const e=JSON.parse(l);if(e.type==='message_end'&&e.message?.role==='assistant'){const x=e.message.content.filter(p=>p.type==='text').map(p=>p.text).join('');if(x.trim())last=x;}}catch{}}
    try{parsed=C.parseCurated(last,recs.map(x=>x.id));}catch(e){err=String(e);}}
  const tools=r.o.split('\n').filter(l=>l.includes('"tool_execution_end"')).length;
  writeFileSync(f,JSON.stringify({n,ids:recs.map(x=>x.id),exit:r.code,tools,parsed:parsed??null,error:parsed?null:err}));
  if(!parsed){console.log('batch',n,'FAILED',err);return;}
  for(const fact of parsed.facts){const c=C.checkFact(repo,fact);const src=recs.filter(x=>fact.sources.includes(x.id));
    appendFileSync(join(out,'facts.jsonl'),JSON.stringify({...c,scope:src[0].scope,createdAt:src.map(x=>x.createdAt).sort().pop(),batch:n})+'\n');}
  for(const d of parsed.dropped)appendFileSync(join(out,'dropped.jsonl'),JSON.stringify({...d,batch:n})+'\n');
  console.log('batch',n,'facts',parsed.facts.length,'dropped',parsed.dropped.length,'unaccounted',parsed.unaccounted.length,'tools',tools);}
const q=[...batches.keys()];await Promise.all(Array.from({length:jobs},async()=>{while(q.length)await one(q.shift());}));
