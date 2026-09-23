/** Explicit reviewed batch: staging-only CAS corrections, no promotion/deletion. */
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {openKnowledgeStore} from '../../../.pi/lib/state/knowledge-store.ts';
const base=resolve('artifacts/jev-backfill/staged-scan-v2');
const root=resolve(base,'staging-memory');
const report=JSON.parse(readFileSync(resolve(base,'disposition-review.json'),'utf8'));
const mappings=JSON.parse(readFileSync(resolve(base,'project-map.json'),'utf8'));
const cwds=[...new Set<string>(mappings.rows.filter((r:any)=>r.mapping.status==='mapped').map((r:any)=>r.mapping.target_cwd))];
const code:Record<string,[string,string]>={
 '2614734c-0dda-43aa-a497-05d53c4d2792':['packages/tools/taskmanage/src/task-manage.ts','if (missing.length) return fail'],
 '5b7485f9-d50a-4de0-8b4b-1d9e6873dc37':['.pi/extensions/00-runtime/swarm-runtime.ts','state.mcp = new MCPManager'],
 'c47fed20-d23b-4a7e-b3ba-93b2554ebd8c':['.pi/extensions/50-ui/swarm-btw.ts','appendSystemPrompt: [prompt.appendSystemPrompt, SIDE_PROMPT]']
};
const receiptPath=resolve(base,'citation-repair-receipt.json');
if(existsSync(receiptPath))throw Error('Batch already has receipt; inspect it before another run');
const proposals:any[]=[];
for(const item of report.records){
 if(!['keep','revise'].includes(item.disposition))continue;
 const matches=cwds.map(cwd=>({cwd,store:openKnowledgeStore({cwd,root,scope:item.scope,namespace:item.namespace})})).map(x=>({...x,record:x.store.read(item.id)})).filter(x=>x.record);
 const unique=[...new Map(matches.map(x=>[x.store.directory,x])).values()];
 if(unique.length!==1)throw Error(`Ambiguous owning store ${item.id}`);
 const {store,record:r}=unique[0];if(!r||r.revision!==item.revision)throw Error(`Stale review ${item.id}`);
 let evidence=r.evidence.map((e,i)=>{const repair=item.citation_repairs[i];return repair?.resolution==='unique'?{...e,ref:repair.proposal.original_ref}:e;});
 let status=r.status;let text=r.text;let codeHash:string|undefined;
 if(code[item.id]){
  const [file,needle]=code[item.id],path=resolve(file),bytes=readFileSync(path,'utf8');const lines=bytes.split('\n');const at=lines.findIndex(l=>l.includes(needle));if(at<0)throw Error(`Re-review changed source ${file}`);
  evidence=[{ref:`${path}#L${at+1}-L${Math.min(lines.length,at+3)}`,quote:lines[at].trim()}];
  codeHash=createHash('sha256').update(bytes).digest('hex');
  // Current local code does not prove repository-wide/merged state.
  status='candidate';
 }
 if(item.id==='a14e407d-a3b6-44a2-aeba-95fd7f82acd7'){
  const ref=evidence[0].ref; evidence.push({ref:ref.slice(0,ref.lastIndexOf('#'))+'#39a99e17',quote:'Questionnaire asked about OAuth-client choice, installation location, and accounts to add.'});
  text='On 2026-09-16, in a Google Workspace setup discussion, the user requested global availability, multiple accounts, and slash-command/widget controls for adding, enabling and toggling them. This is a historical preference, not implementation proof. The freeform answer did not select an OAuth client. Later requirements were not reviewed.';
  status='candidate'; // recovered context narrows attribution, not automatic re-verification
 }
 proposals.push({store,r,input:{...r,text,status,evidence,id:r.id,expectedRevision:r.revision,source:'staged-citation-review'},codeHash});
}
const receipts:any[]=[];
// Preflight all revisions before first write. Each put is independently CAS guarded.
try{for(const p of proposals){const result=p.store.put(p.input);receipts.push({id:result.id,oldRevision:p.r.revision,newRevision:result.revision,status:result.status,codeSha256:p.codeHash});}}
finally{writeFileSync(receiptPath,JSON.stringify({stagingRoot:root,liveWrites:0,atomicBatch:false,records:receipts},null,2),{mode:0o600});}
console.log(JSON.stringify({corrected:receipts.length,liveWrites:0,receipt:receiptPath}));
