import { resolveJevCredential } from "../../lib/context/jev-credential.ts";
import { it, expect } from "vitest";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { auditWithJev, renderJevReview, type JevEvidence } from "../../lib/context/jev-knowledge-audit.ts";
it.skipIf(!process.env.PI_SWARM_JEV_LIVE_TEST)("real Jev audits bounded actual project evidence", async()=>{
 const text=readFileSync(process.env.JEV_SMOKE_DOCUMENT ?? "AGENTS.md","utf8");
 const evidence:JevEvidence[]=[{id:"priorities",role:"project_document",text:text.slice(0,1800),truncated:text.length>1800,sourceKind:"conversation"},{id:"contract",role:"project_document",text:readFileSync("AGENTS.md","utf8").slice(0,1600),truncated:true,sourceKind:"skill"}];
 const start=Date.now();const credential=await resolveJevCredential();expect(credential).toBeDefined();const result=await auditWithJev(evidence,{apiKey:credential!.apiKey,timeoutMs:3000});
 expect(result.findings).toHaveLength(2);mkdirSync("artifacts/jev-audit",{recursive:true});writeFileSync("artifacts/jev-audit/live.json",JSON.stringify({model:"jev-1.13.0",durationMs:Date.now()-start,usage:result.usage,findings:result.findings.map(f=>({id:f.id,category:f.category,confidence:f.confidence})),reviewChars:renderJevReview(result.findings).length},null,2));
},10000);
