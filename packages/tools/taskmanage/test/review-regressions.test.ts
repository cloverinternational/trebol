import {it,expect,vi} from 'vitest';
import {execFileSync} from 'node:child_process';
vi.mock('node:child_process',()=>({execFileSync:vi.fn(()=>Buffer.from(''))}));
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TaskManager,resolveToolEvidence} from '../src/task-manage.js';
it('rejects legacy resolver combined with explicit root or read policies',()=>{
 expect(()=>new TaskManager(undefined,undefined,{resolveEvidence:()=>true,canReadEvidence:()=>false})).toThrow(/exclusive/);
 expect(()=>new TaskManager(undefined,undefined,{resolveEvidence:()=>true,evidenceRoots:['/']})).toThrow(/exclusive/);
});
it('discovers worktrees once per batch, refreshing on the next batch',()=>{
 const root=mkdtempSync(join(tmpdir(),'tm-review-'));writeFileSync(join(root,'proof.md'),'# Proof\nbody');
 const spy=vi.mocked(execFileSync).mockClear();
 try {
  const m=new TaskManager(undefined,undefined,{workspaceRoot:root});
  m.execute({operations:[{key:'c',op:'create',subject:'test',questions:[{id:'a',text:'A?'},{id:'b',text:'B?'}]}]});
  const complete={key:'d',op:'update' as const,taskId:'1',status:'completed' as const,answers:['a','b'].map(question=>({question,answer:'yes',evidence:'proof.md#Proof; proof.md#L1'}))};
  expect(m.execute({operations:[complete]}).status).toBe('succeeded');expect(spy).toHaveBeenCalledTimes(1);
  expect(m.execute({operations:[complete]}).status).toBe('succeeded');expect(spy).toHaveBeenCalledTimes(2);
 } finally {spy.mockClear();rmSync(root,{recursive:true,force:true});}
});
it('ignores malformed session entries',()=>{
 expect(resolveToolEvidence('tool:Bash',{getEntries:()=>[null,{}, {type:'message',message:null},{type:'message',message:{role:'toolResult',toolName:42}}]})).toBe(false);
});
it('contains host callback exceptions and rolls back atomic prefixes without leaking details',()=>{
 const m=new TaskManager(undefined,undefined,{canonicalizeToolEvidence:()=>{throw new Error('SECRET_HOST_DETAIL');}});
 const batch=m.execute({mode:'atomic',operations:[{key:'c',op:'create',subject:'test',questions:[{id:'q',text:'Proof?'}]},{key:'a',op:'update',taskId:{ref:'c'},answers:[{question:'q',answer:'yes',evidence:'proof.md'}]}]});
 expect(batch.status).toBe('failed');expect(m.snapshot().tasks).toHaveLength(0);
 expect(JSON.stringify(batch)).not.toContain('SECRET_HOST_DETAIL');
 expect(batch.results[1].error?.code).toBe('validation_failed');
});
it('preserves legacy answers on unrelated edits without permitting questionless completion',()=>{
 const m=new TaskManager();m.execute({operations:[{key:'c',op:'create',subject:'legacy',questions:[{id:'q',text:'Proof?'}]}]});
 const state=m.snapshot();state.tasks[0].questions=undefined;state.tasks[0].answers=[{question:'q',answer:'historical',evidence:'proof.md'}];m.restore(state);
 expect(m.execute({operations:[{key:'note',op:'update',taskId:'1',addNote:'retained'}]}).status).toBe('succeeded');
 expect(m.snapshot().tasks[0].answers).toEqual(state.tasks[0].answers);
 expect(m.execute({operations:[{key:'done',op:'update',taskId:'1',status:'completed'}]}).status).toBe('failed');
});
