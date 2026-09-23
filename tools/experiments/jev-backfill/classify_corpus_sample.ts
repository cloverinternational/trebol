import {readFileSync,writeFileSync,appendFileSync,openSync,closeSync,unlinkSync,fsyncSync} from 'node:fs';
import {resolve} from 'node:path';
import {resolveJevCredential} from '../../../.pi/lib/context/jev-credential.ts';
import {auditWithJev} from '../../../.pi/lib/context/jev-knowledge-audit.ts';
const root=resolve('artifacts/jev-backfill/skills-tasks-v2');
const ledger=resolve('artifacts/jev-backfill/staged-scan-v2/pilot/calls.jsonl');
const lock=ledger+'.lock';const fd=openSync(lock,'wx',0o600);
try{
 const old=readFileSync(ledger,'utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l));
 const id='skills-tasks-v2-three-record-sample';if(old.some(r=>r.file_id===id))throw Error('Already reserved; inspect result');if(old.length>=100)throw Error('Budget exhausted');
 const source=JSON.parse(readFileSync(resolve(root,'sample.json'),'utf8'));
 const evidence=source.map((r:any,i:number)=>({id:`sample-${i}`,role:r.kind==='skill_section'?'skill':'task-note-assertion',sourceKind:r.kind==='skill_section'?'skill':'conversation',text:r.text,truncated:r.chunks>1}));
 const credential=await resolveJevCredential();if(!credential)throw Error('Credential unavailable');
 const l=openSync(ledger,'a');try{writeFileSync(l,JSON.stringify({file_id:id,status:'reserved',evidence_count:evidence.length,pilot:'skills-tasks-v2'})+'\n');fsyncSync(l);}finally{closeSync(l);}
 try{const result=await auditWithJev(evidence,{apiKey:credential.apiKey,timeoutMs:10000});writeFileSync(resolve(root,'sample-result.json'),JSON.stringify({status:'completed',result},null,2),{mode:0o600});console.log(JSON.stringify(result));}
 catch(e){writeFileSync(resolve(root,'sample-result.json'),JSON.stringify({status:'failed',errorType:e instanceof Error?e.name:'unknown'}));throw Error('Classification failed; reservation retained');}
}finally{closeSync(fd);unlinkSync(lock);}
