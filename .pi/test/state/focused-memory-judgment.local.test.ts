import {it,expect} from "vitest";
import {readFileSync,writeFileSync} from "node:fs";import {resolve,join} from "node:path";import {createHash} from "node:crypto";
import {openKnowledgeStore} from "../../lib/state/knowledge-store.ts";import {recallKnowledge} from "../../lib/context/knowledge-recall.ts";
it.skipIf(!process.env.PI_SWARM_FOCUSED_MEMORY_JUDGE)("stores source-checked project facts and retrieves them",()=>{
 const cwd=process.cwd(),base=resolve('artifacts/jev-backfill/staged-scan-v2'),root=join(base,'staging-memory');const store=openKnowledgeStore({cwd,root});
 const facts=[
 {text:'Pi-Swarm question-bearing tasks require an answer for every question ID and resolvable evidence before completion. Missing/unknown answers and unavailable references reject completion; reference availability is not semantic proof.',path:'packages/tools/taskmanage/src/task-manage.ts',needle:'missing answer for question id',tag:'task-completion',query:'question answers completion',sourceId:'457f8262'},
 {text:'Pi-Swarm registers MCP integration through .pi/extensions/00-runtime/swarm-runtime.ts using MCPManager from packages/tools/mcp. This identifies the local integration owner, not the capabilities of every upstream Pi version.',path:'.pi/extensions/00-runtime/swarm-runtime.ts',needle:'new MCPManager',tag:'mcp-owner',query:'MCPManager integration owner',sourceId:'99c14910'},
 {text:'Pi-Swarm /btw passes appendSystemPrompt as an array combining the existing prompt and SIDE_PROMPT, filtering absent values; callers should preserve that API shape.',path:'.pi/extensions/50-ui/swarm-btw.ts',needle:'appendSystemPrompt: [prompt.appendSystemPrompt, SIDE_PROMPT]',tag:'btw-prompt',query:'btw appendSystemPrompt array',sourceId:'3c2b2569'}];
 const result=[];
 for(const f of facts){const raw=readFileSync(f.path,'utf8');expect(raw).toContain(f.needle);const hash=createHash('sha256').update(raw).digest('hex');const record=store.put({text:f.text,tags:[f.tag],status:'verified',kind:'fact',source:'parent-source-review:'+f.sourceId,evidence:[{ref:f.path,quote:f.needle}]});const recall=recallKnowledge(cwd,f.query,{root,scopes:['repository']});expect(recall.memories.some(x=>x.id.includes(record.id))).toBe(true);result.push({id:record.id,text:f.text,sourceMessage:f.sourceId,codePath:f.path,sha256:hash,recalled:true});}
 // A narrated old test run is not current durable knowledge; downgrade rather than delete.
 for(const r of store.snapshot())if(r.namespace==='default'&&r.status==='verified'&&r.text.startsWith('Historical Jev outcome report'))store.put({...r,status:'candidate',expectedRevision:r.revision,source:'parent-review:historical-report-not-current-fact'});
 writeFileSync(join(base,'pilot/focused-code-judgment.json'),JSON.stringify(result,null,2));
});
