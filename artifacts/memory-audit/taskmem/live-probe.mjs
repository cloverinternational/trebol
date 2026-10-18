import {createJiti} from 'jiti';
const jiti=createJiti(import.meta.url),repo=process.cwd();
const {openKnowledgeStore}=await jiti.import(repo+'/.pi/lib/state/knowledge-store.ts');
const {recallKnowledge}=await jiti.import(repo+'/.pi/lib/context/knowledge-recall.ts');
const {memoryIdentity}=await jiti.import(repo+'/.pi/lib/state/shared-memory.ts');
const cwd=process.argv[2]??repo;
console.log('cwd',cwd,'identity',JSON.stringify(memoryIdentity(cwd)));
for(const scope of ['worktree','repository']){const s=openKnowledgeStore({cwd,scope}).snapshot();
 const by={};for(const r of s){const k=r.source.split(':')[0]+'/'+r.status;by[k]=(by[k]??0)+1}
 console.log(scope,s.length,JSON.stringify(by));}
for(const q of (process.argv[3]??'how does the task enforcement gate work|where are memory knowledge records stored|project_context hybrid search spark embedding|how do I run e2e tests').split('|')){
 const r=recallKnowledge(cwd,q);console.log('\nQ:',q,'| status',r.status,'mem',r.memories.length,'candEx',r.candidatesExcluded,'staleEx',r.staleExcluded);
 for(const m of r.memories.slice(0,4))console.log('  -',m.source?.split(':')[0],'|',String(m.text).replace(/\s+/g,' ').slice(0,140));}
