import {it,expect} from "vitest";import {readdirSync,readFileSync,writeFileSync} from "node:fs";import {resolve,join} from "node:path";import {recallKnowledge} from "../../lib/context/knowledge-recall.ts";
it.skipIf(!process.env.PI_SWARM_DOGFOOD_RECALL)("real unscripted worker memory recalls with deployment caveat",()=>{
 const base=resolve("artifacts/jev-audit");const dir=readdirSync(base).filter(n=>n.startsWith("integrated-")).sort().at(-1)!;const root=join(base,dir);const r=recallKnowledge(join(root,"workspace"),"Aurora PostgreSQL deployment",{root:join(root,"memory"),scopes:["repository"]});
 expect(r.memories.length).toBeGreaterThan(0);expect(r.memories.some(m=>m.text.includes("not been tested"))).toBe(true);
 writeFileSync(join(root,"recall-proof.json"),JSON.stringify({status:r.status,records:r.memories.map(m=>({id:m.id,text:m.text,evidenceRefs:m.evidenceRefs})),crossScopeWrites:false},null,2));
});
