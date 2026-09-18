// Explicit first reviewed batch. Uses the canonical store, never raw event edits.
// Run from Pi-Swarm root with: npx vite-node tools/experiments/memory-curation/save-reviewed.ts
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {openKnowledgeStore} from '../../../.pi/lib/state/knowledge-store.ts';
import {recallKnowledge} from '../../../.pi/lib/context/knowledge-recall.ts';
const cwd=process.cwd();
const facts=[
 {file:'.pi/lib/context/knowledge-recall.ts',needle:'if (record.status !== "verified")',text:'Pi-Swarm durable knowledge recall excludes candidate and tombstoned records, scans repository/worktree/global scopes by default, and caps returned memories at eight. Saved candidates are not automatically available through this verified-knowledge retrieval path. This describes the local implementation, not all legacy/session bootstrap inputs.',tag:'durable knowledge recall'},
 {file:'.pi/lib/context/supervisor-settings.ts',needle:'path.join(root, "pi-swarm/supervisor.json")',text:'Pi-Swarm supervisor settings merge defaults, global ~/.swarm/config/supervisor.json, then project overrides. For Git projects the project file is inside the Git common directory at pi-swarm/supervisor.json, not in the repository working-tree root. Outside Git it is cwd/.swarm/supervisor.json. This is the inspected local implementation.',tag:'supervisor configuration location'},
];
const store=openKnowledgeStore({cwd,scope:'worktree'});const receipts=[];
for(const fact of facts){
 const source=readFileSync(resolve(cwd,fact.file),'utf8');if(!source.includes(fact.needle))throw Error('Source changed; re-review required');
 const line=source.split('\n').findIndex(l=>l.includes(fact.needle))+1;
 const existing=store.snapshot().find(r=>!r.deleted&&r.text===fact.text);
 const record=existing??store.put({text:fact.text,tags:[fact.tag],status:'verified',kind:'fact',source:'manual-code-review',evidence:[{ref:`${resolve(cwd,fact.file)}#L${line}`,quote:fact.needle}]});
 const recall=recallKnowledge(cwd,fact.tag);
 receipts.push({id:record.id,revision:record.revision,scope:record.scope,created:!existing,recalled:recall.memories.some(m=>m.id.includes(record.id))});
}
mkdirSync('.swarmpi/execution',{recursive:true});writeFileSync('.swarmpi/execution/first-reviewed-memory-batch.json',JSON.stringify(receipts,null,2),{mode:0o600});console.log(JSON.stringify(receipts,null,2));
