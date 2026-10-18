/** Memory retrieval benchmark over a frozen records snapshot (see artifacts/memory-bench/PREREG.md).
 * Query sets (retriever-independent gold):
 *   mined  - artifacts/memory-bench/qrels.json (tools/bench/mine-retrieval-qrels.py)
 *   span   - sealed test-split developer searches (memory-audit/eval/test-queries.jsonl) whose
 *            grade-2 qrels spans overlap a record's cited evidence span (grade 2)
 * Methods: current (memory_history search rule at b4dc9bc), bm25, dense, hybrid (fact-index.ts).
 * Corpus filter: env CORPUS=all|facts. Records snapshot: argv[2]. Output JSON: argv[3].
 * Embeddings: PI_SWARM_MEMORY_EMBED_URL (vectors cached in OUT.dir/vec-cache.jsonl). */
import {readFileSync,writeFileSync,existsSync,appendFileSync} from 'node:fs';import {dirname,join} from 'node:path';
import {createJiti} from '../../node_modules/jiti/lib/jiti.mjs';
const jiti=createJiti(import.meta.url);const FI=await jiti.import('../../.pi/lib/state/fact-index.ts');
const [,,snap,outF]=process.argv;const A='artifacts/memory-audit/eval/';
let R=readFileSync(snap,'utf8').trim().split('\n').map(JSON.parse);
if(process.env.CORPUS==='facts')R=R.filter(r=>r.kind!=='context');
const byId=new Map(R.map(r=>[r.id,r]));
const Q=[];
for(const q of JSON.parse(readFileSync('artifacts/memory-bench/qrels.json','utf8')).queries)Q.push({qid:q.qid,set:'mined-'+q.kind,text:q.text,ts:q.ts,gold:q.gold});
const P={};for(const l of readFileSync(A+'passages.jsonl','utf8').split('\n').filter(Boolean)){const x=JSON.parse(l);if(x.lines&&!x.summary)P[x.doc]=x;}
const G={};for(const l of readFileSync(A+'qrels.jsonl','utf8').split('\n').filter(Boolean)){const x=JSON.parse(l);if(P[x.doc]&&x.grade===2)(G[x.qid]??=[]).push([P[x.doc].ref,...P[x.doc].lines]);}
const SP=/([\w./@-]+\.\w+)#L(\d+)(?:-L?(\d+))?/g;
const spans=r=>(r.evidence||[]).flatMap(e=>[...e.ref.matchAll(SP)].map(m=>[m[1].startsWith('./')?m[1].slice(2):m[1],+m[2],+(m[3]??m[2])]));
for(const l of readFileSync(A+'test-queries.jsonl','utf8').split('\n').filter(Boolean)){const q=JSON.parse(l);const gold={};
  for(const r of R)if(spans(r).some(([p,a,b])=>(G[q.qid]||[]).some(([ref,x,y])=>p===ref&&a<=y&&b>=x)))gold[r.id]=2;
  if(Object.keys(gold).length)Q.push({qid:q.qid,set:'span',text:q.text,ts:'9999',gold});}
// current rule: extensions/memory-history/extension.ts (b4dc9bc) L215-222
function current(recs,query){const q=query.trim().toLocaleLowerCase();const terms=[...new Set(q.match(/[\p{L}\p{N}_.-]{3,}/gu)??[])];
  return recs.filter(r=>{const h=`${r.text} ${r.tags.join(' ')}`.toLocaleLowerCase();const rt=new Set(h.match(/[\p{L}\p{N}_.-]+/gu)??[]);return h.includes(q)||(terms.length>=2&&terms.every(t=>rt.has(t)));}).map(r=>r.id);}
const cfg=FI.embedConfig();const cacheF=join(dirname(outF),'vec-cache.jsonl');const vc=new Map();
if(existsSync(cacheF))for(const l of readFileSync(cacheF,'utf8').split('\n').filter(Boolean)){const x=JSON.parse(l);vc.set(x.k,x.v);}
async function vec(model,texts){const miss=[...new Set(texts.filter(t=>!vc.has(model+'|'+t)))];
  for(let i=0;i<miss.length;i+=8){let res;for(let t=0;t<3;t++){try{res=await fetch(cfg.url+'/v1/embeddings',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model,input:miss.slice(i,i+8).map(s=>s.slice(0,6000))})});break}catch(e){if(t===2)throw e}}const d=await res.json();
    d.data.forEach((e,j)=>{vc.set(model+'|'+miss[i+j],e.embedding);appendFileSync(cacheF,JSON.stringify({k:model+'|'+miss[i+j],v:e.embedding})+'\n');});}
  return texts.map(t=>vc.get(model+'|'+t));}
const dv=cfg?await vec(cfg.model,R.map(r=>r.text)):null;const dmap=new Map(R.map((r,i)=>[r.id,dv?.[i]]));
const qv=cfg?await vec(cfg.model+':query',Q.map(q=>q.text)):null;
const cos=(a,b)=>{let s=0;for(let i=0;i<a.length;i++)s+=a[i]*b[i];return s;};
const rrf=lists=>{const s=new Map();for(const l of lists)l.forEach((id,i)=>s.set(id,(s.get(id)??0)+1/(61+i)));return [...s].sort((a,b)=>b[1]-a[1]).map(x=>x[0]);};
const rows=[];
for(const [qi,q] of Q.entries()){const recs=R.filter(r=>r.createdAt<q.ts);
  const bm=FI.bm25Rank(recs,q.text).map(x=>x.id);const de=qv?recs.map(r=>[r.id,cos(qv[qi],dmap.get(r.id))]).sort((a,b)=>b[1]-a[1]).slice(0,100).map(x=>x[0]):[];
  const cur=current(recs,q.text);const ex=recs.filter(r=>`${r.text} ${r.tags.join(' ')}`.toLocaleLowerCase().includes(q.text.trim().toLocaleLowerCase())).map(r=>r.id);
  const M={current:cur,bm25:bm,dense:de,hybrid:[...ex,...rrf([bm,de]).filter(i=>!ex.includes(i))]};
  const row={qid:q.qid,set:q.set,nGold:Object.keys(q.gold).filter(i=>byId.has(i)).length,corpus:recs.length};
  for(const [m,ids] of Object.entries(M)){const top=ids.slice(0,5);const rel=top.map(i=>q.gold[i]??0);
    const dcg=rel.reduce((s,g,i)=>s+(2**g-1)/Math.log2(i+2),0);const ideal=Object.values(q.gold).filter((_,i)=>true).sort((a,b)=>b-a).slice(0,5).reduce((s,g,i)=>s+(2**g-1)/Math.log2(i+2),0);
    row[m]={hit5:rel.some(g=>g===2)?1:0,ndcg5:ideal?dcg/ideal:0,zero:ids.length===0?1:0};}
  rows.push(row);}
const sets=['all',...new Set(rows.map(r=>r.set))];const summary={};
const rng=(s=>()=>(s=(s*1103515245+12345)%2147483648)/2147483648)(20261018);
for(const set of sets){const rs=rows.filter(r=>set==='all'||r.set===set);summary[set]={n:rs.length};
  for(const m of ['current','bm25','dense','hybrid']){summary[set][m]={hit5:rs.reduce((s,r)=>s+r[m].hit5,0)/rs.length,ndcg5:rs.reduce((s,r)=>s+r[m].ndcg5,0)/rs.length,zero:rs.reduce((s,r)=>s+r[m].zero,0)};}
  for(const m of ['bm25','dense','hybrid']){const d=rs.map(r=>r[m].ndcg5-r.current.ndcg5);const bs=[];for(let k=0;k<10000;k++){let s=0;for(let i=0;i<d.length;i++)s+=d[Math.floor(rng()*d.length)];bs.push(s/d.length);}bs.sort((a,b)=>a-b);
    summary[set][m].vsCurrent={delta:d.reduce((a,b)=>a+b,0)/d.length,ci95:[bs[249],bs[9749]]};}
  {const d=rs.map(r=>r.hybrid.ndcg5-r.bm25.ndcg5);const bs=[];for(let k=0;k<10000;k++){let s=0;for(let i=0;i<d.length;i++)s+=d[Math.floor(rng()*d.length)];bs.push(s/d.length);}bs.sort((a,b)=>a-b);summary[set].hybrid.vsBm25={delta:d.reduce((a,b)=>a+b,0)/d.length,ci95:[bs[249],bs[9749]]};}}
writeFileSync(outF,JSON.stringify({snapshot:snap,corpus:process.env.CORPUS||'all',embed:cfg?.model??null,summary,rows},null,1));
for(const [set,s] of Object.entries(summary))console.log(set,'n',s.n,Object.entries(s).filter(([k])=>k!=='n').map(([m,v])=>`${m} hit5 ${v.hit5.toFixed(2)} ndcg ${v.ndcg5.toFixed(3)} zero ${v.zero}${v.vsCurrent?` d ${v.vsCurrent.delta.toFixed(3)} [${v.vsCurrent.ci95.map(x=>x.toFixed(3))}]`:''}`).join(' | '));
