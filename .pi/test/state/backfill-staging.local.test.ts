import {it,expect} from "vitest";
import {readFileSync,readdirSync,writeFileSync} from "node:fs";
import {resolve,join} from "node:path";
import {openKnowledgeStore} from "../../lib/state/knowledge-store.ts";
import {recallKnowledge} from "../../lib/context/knowledge-recall.ts";
it.skipIf(!process.env.PI_SWARM_BACKFILL_STAGING_TEST)("reviewed historical knowledge is discoverable in its own project only",()=>{
 const base=resolve("artifacts/jev-backfill/staged-scan-v2"),root=join(base,"staging-memory");
 const jobs=JSON.parse(readFileSync(join(base,"review-jobs/manifest.json"),"utf8")).jobs;
 const report:any[]=[];
 for(const job of jobs){
  const initial=openKnowledgeStore({cwd:job.cwd,root});
  const files=readdirSync(initial.directory).filter(f=>f.endsWith(".json"));
  const raw=files.map(f=>JSON.parse(readFileSync(join(initial.directory,f),"utf8")).record);
  for(const record of raw.filter(r=>r.namespace!=="default")){
   const current=openKnowledgeStore({cwd:job.cwd,root,namespace:record.namespace}).read(record.id);
   if(current?.revision===record.revision) initial.put({text:record.text,tags:record.tags,status:record.status,kind:record.kind,evidence:record.evidence,source:`staging namespace copy from ${record.namespace}/${record.id}@${record.revision}`});
  }
  const records=initial.snapshot().filter(r=>!r.deleted && r.namespace==="default");const verified=records.filter(r=>r.status==="verified");
  const query=verified[0]?.tags?.[0]??"historical";const recalled=recallKnowledge(job.cwd,query,{root,scopes:["repository"]});
  if(verified.length)expect(recalled.memories.length).toBeGreaterThan(0);
  for(const other of jobs.filter((j:any)=>j.repository_key!==job.repository_key)){
   const foreign=recallKnowledge(other.cwd,query,{root,scopes:["repository"]});
   for(const v of verified)expect(foreign.memories.some(m=>m.id.includes(v.id))).toBe(false);
  }
  report.push({projectKey:job.repository_key,candidates:records.filter(r=>r.status==="candidate").length,verified:verified.length,recalled:recalled.memories.length,namespace:"default",testType:"tag-derived smoke, not held-out retrieval quality"});
 }
 writeFileSync(join(base,"pilot/recall-smoke.json"),JSON.stringify(report,null,2));
});
