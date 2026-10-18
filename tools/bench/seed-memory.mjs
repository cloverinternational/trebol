/** Build per-task seeded memory stores for the autonomous-retrieval run
 * (artifacts/memory-bench/PREREG-autonomy.md). For each q task: verified curated
 * facts whose every source record was created BEFORE the developer's original
 * query (timestamp of its source_ref session line) and none from that query's
 * session. Written through the real KnowledgeStore (repository scope), then one
 * ranked search warms the embedding cache. Usage:
 * node tools/bench/seed-memory.mjs TASKS FACTS SNAPSHOT OUTDIR */
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';import {join,resolve} from 'node:path';import {homedir} from 'node:os';
import {createJiti} from '../../node_modules/jiti/lib/jiti.mjs';
const jiti=createJiti(import.meta.url);const {openKnowledgeStore}=await jiti.import('../../.pi/lib/state/knowledge-store.ts');const {rankKnowledge}=await jiti.import('../../.pi/lib/state/fact-index.ts');
const [,,tasksF,factsF,snapF,outD]=process.argv;const repo=resolve('.');
const d=JSON.parse(readFileSync(tasksF,'utf8'));const T=(d.tasks??d).filter(t=>t.kind==='q');
const QQ=new Map(readFileSync('artifacts/memory-audit/eval/test-queries.jsonl','utf8').split('\n').filter(Boolean).map(l=>JSON.parse(l)).map(q=>[q.qid,q]));
const raw=new Map(readFileSync(snapF,'utf8').trim().split('\n').map(JSON.parse).map(r=>[r.id,r]));
const facts=readFileSync(factsF,'utf8').trim().split('\n').map(JSON.parse).filter(f=>f.status==='verified');
const S=join(homedir(),'.pi/agent/sessions/--Users-swarm-Work-Clover-trebol--');const manifest=[];
for(const t of T){const q=QQ.get(t.check.qid);const [file,ln]=q.source_ref.split('#L');const line=readFileSync(join(S,file),'utf8').split('\n')[+ln-1];const ts=new Date(JSON.parse(line).timestamp).toISOString();const sess=file.replace(/\.jsonl$/,'').split('_').pop();
  const keep=facts.filter(f=>f.sources.every(s=>{const r=raw.get(s);return r&&r.createdAt<ts&&!r.source.includes(sess);}));
  const root=join(resolve(outD),t.id);if(existsSync(root))throw new Error('exists '+root);mkdirSync(root,{recursive:true});
  const store=openKnowledgeStore({cwd:repo,scope:'repository',root});
  for(const f of keep)store.put({text:f.text,kind:'fact',status:'verified',tags:f.tags,evidence:f.anchored,source:'fact-curator:'+f.sources.join(',').slice(0,200)});
  const r=await rankKnowledge([{directory:store.directory,records:store.snapshot()}],q.text);
  manifest.push({task:t.id,qid:q.qid,queryTs:ts,facts:keep.length,ranking:r.mode,embedError:r.embedError??null});console.log(t.id,keep.length,r.mode,r.embedError??'');}
writeFileSync(join(outD,'manifest.json'),JSON.stringify(manifest,null,1));
