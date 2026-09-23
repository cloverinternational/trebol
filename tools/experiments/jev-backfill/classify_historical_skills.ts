/** Authorized classification only: 360 additional reservations, no memory/skill writes. */
import {readFileSync,writeFileSync,mkdirSync,openSync,closeSync,fsyncSync,existsSync,unlinkSync} from 'node:fs';
import {createHash} from 'node:crypto';import {resolve} from 'node:path';
import {resolveJevCredential} from '../../../.pi/lib/context/jev-credential.ts';
import {auditWithJev} from '../../../.pi/lib/context/jev-knowledge-audit.ts';
const out=resolve('artifacts/jev-backfill/historical-skill-classification-v1');mkdirSync(out,{recursive:true,mode:0o700});
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const lock=resolve(out,'run.lock');const fd=openSync(lock,'wx',0o600);
const ledger=resolve(out,'reservations.jsonl');
try {
 const remaining=readFileSync('artifacts/jev-backfill/revision-label-coverage-v1/remaining-unique.jsonl','utf8').trim().split('\n').map(l=>JSON.parse(l));
 const rows=remaining.map(({representative:r})=>({...r,path:r.source_path,sha256:r.source_sha256,placement:'historical-revision'}));
 const valid:any[]=[],excluded:any[]=[];
 for(const r of rows){
  if(!r.text.trim()||r.text.includes('[OMITTED:')){excluded.push({path:r.path,reason:'empty-or-sensitive',start:r.start_offset});continue;}
  if(!existsSync(r.path)||hash(readFileSync(r.path,'utf8'))!==r.sha256)throw Error('Historical manifest changed');
  valid.push(r);
 }
 const batches:any[][]=[];let batch:any[]=[];let chars=0;
 for(const r of valid){if(batch.length>=8||chars+r.text.length>22000){batches.push(batch);batch=[];chars=0;}batch.push(r);chars+=r.text.length;}if(batch.length)batches.push(batch);
 writeFileSync(resolve(out,'plan.json'),JSON.stringify({version:1,authorizedAdditionalCalls:360,records:rows.length,eligibleChunks:valid.length,batches:batches.length,exclusions:excluded,classificationOnly:true,scope:'deduplicated historical revision text not matched unambiguously to current labels;360remaining additional calls'},null,2),{mode:0o600});
 const prior=existsSync(ledger)?readFileSync(ledger,'utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l)):[];const reserved=new Set(prior.map(r=>r.id));let used=prior.length;
 const credential=await resolveJevCredential();if(!credential)throw Error('Jev credential unavailable');
 let completed=0,failed=0,uncertain=0;
 for(const b of batches){
  const id=hash('historical-v1:jev-1.13.0:'+JSON.stringify(b));const resultPath=resolve(out,id+'.json');
  if(existsSync(resultPath)){const d=JSON.parse(readFileSync(resultPath,'utf8'));if(d.status==='completed')completed++;else failed++;continue;}
  if(reserved.has(id)){uncertain++;continue;} // No silent retry of uncertain spend.
  if(used>=360)break;
  const f=openSync(ledger,'a',0o600);try{writeFileSync(f,JSON.stringify({id,status:'reserved',at:new Date().toISOString(),records:b.length})+'\n');fsyncSync(f);}finally{closeSync(f);}used++;reserved.add(id);
  const evidence=b.map(r=>({id:hash(JSON.stringify([r.path,r.sha256,r.revision_file,r.blob_sha256,r.start_offset,r.text])).slice(0,24),role:'skill-source-assertion',sourceKind:'skill' as const,revision:r.sha256,truncated:true,text:JSON.stringify({heading:r.heading,ancestry:r.ancestry,placement:r.placement,source:r.path,span:[r.start_offset,r.end_offset],ownership:'unresolved',context:'Section/chunk from managed skill. Archived is not stale. Project claims require verification. Retain actionable procedures; mixed passages need splitting, never automatic deletion.',content:r.text})}));
  try{const result=await auditWithJev(evidence,{apiKey:credential.apiKey});writeFileSync(resultPath,JSON.stringify({id,status:'completed',sources:b.map(r=>({path:r.path,sha256:r.sha256,start:r.start_offset,end:r.end_offset,heading:r.heading,placement:r.placement})),findings:result.findings.map(f=>({id:f.id,category:f.category,confidence:f.confidence})),usage:result.usage}),{mode:0o600});completed++;}
  catch{writeFileSync(resultPath,JSON.stringify({id,status:'failed',records:b.length,error:'Jev request or validation failed; reservation charged'}),{mode:0o600});failed++;}
  writeFileSync(resolve(out,'progress.json'),JSON.stringify({plannedBatches:batches.length,reserved:used,completed,failed,uncertain,remaining:batches.length-completed-failed-uncertain,liveWrites:0},null,2));
  if(used%10===0)console.log(JSON.stringify({reserved:used,completed,failed,total:batches.length}));
 }
 console.log(JSON.stringify({finished:true,plannedBatches:batches.length,reserved:used,completed,failed,uncertain,liveWrites:0}));
}finally{closeSync(fd);unlinkSync(lock);}
