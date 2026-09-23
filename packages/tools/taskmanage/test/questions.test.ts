import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskManager, registerTaskManage, splitEvidence, type JournalEntry } from '../src/task-manage.js';
import { swarmValidateTaskManageParams } from '../src/swarm-validate.js';

const question = {id:'q1',text:'Does it work?'};
const answer = {question:'q1',answer:'Verified fixture.',evidence:'proof.md#Proof'};
const create = {key:'new',op:'create' as const,subject:'Test',questions:[question]};
const done = {key:'done',op:'update' as const,taskId:'1',status:'completed' as const,answers:[answer]};
function fixture() {
 const root=mkdtempSync(join(tmpdir(),'task-questions-'));
 writeFileSync(join(root,'proof.md'),'# Proof\nObserved success.\n');
 const entries: JournalEntry[]=[];
 const manager=new TaskManager(e=>entries.push(e),undefined,{workspaceRoot:root});
 expect(manager.execute({operations:[create]}).status).toBe('succeeded');
 return {manager,root,entries};
}
describe('compact task completion questions',()=>{
 it('rejects missing answers then repairs in one completion call and reloads',()=>{
  const {manager,entries,root}=fixture();
  expect(manager.execute({operations:[{...done,answers:undefined}]}).status).toBe('failed');
  expect(manager.snapshot().tasks[0].status).toBe('pending');
  expect(manager.execute({operations:[done]}).status).toBe('succeeded');
  const reloaded=new TaskManager(undefined,undefined,{workspaceRoot:root}); reloaded.rehydrate(entries);
  expect(reloaded.snapshot().tasks[0].answers).toEqual([answer]);
 });
 it.each(['absent.md#Proof','proof.md#Absent','proof.md#L99-L100','../outside.md#Proof'])('rejects unavailable reference %s',evidence=>{
  const {manager}=fixture();
  expect(manager.execute({operations:[{...done,answers:[{...answer,evidence}]}]}).status).toBe('failed');
  expect(manager.snapshot().tasks[0].status).toBe('pending');
 });
 // Agents routinely cite several files in one answer, and a whole file or a
 // single line rather than a range. Rejecting those shapes produced failures
 // that looked like the citation was wrong when only its syntax was.
 it.each(['proof.md#Proof; proof.md#L1-L2','proof.md#L1-L2, proof.md#Proof','proof.md#L1','proof.md'])('accepts citation shape %s',evidence=>{
  const {manager}=fixture();
  expect(manager.execute({operations:[{...done,answers:[{...answer,evidence}]}]}).status).toBe('succeeded');
 });
 it('names only the unresolvable reference in a multi-file citation',()=>{
  const {manager}=fixture();
  const batch=manager.execute({operations:[{...done,answers:[{...answer,evidence:'proof.md#Proof; absent.md#L1-L2'}]}]});
  expect(batch.results[0].error?.message).toBe('evidence reference is unavailable: absent.md#L1-L2');
 });
 it('splits multi-file citations without corrupting headings that contain separators',()=>{
  expect(splitEvidence('a.ts#L1-L2; b.ts#L3')).toEqual(['a.ts#L1-L2','b.ts#L3']);
  expect(splitEvidence('x.md#A, y.md#B')).toEqual(['x.md#A','y.md#B']);
  expect(splitEvidence('AGENTS.md#Results, caveats')).toEqual(['AGENTS.md#Results, caveats']);
  expect(splitEvidence('one.ts#L1')).toEqual(['one.ts#L1']);
 });
 // The pre-gate used to report every one of these as the same structural
 // message, so a caller who exceeded a length bound saw a shape error.
 it('names the answer field and bound that actually failed',()=>{
  const answers=(patch:Record<string,unknown>)=>({operations:[{key:'a',op:'update',taskId:'1',status:'completed',answers:[{...answer,...patch}]}]});
  expect(swarmValidateTaskManageParams(answers({answer:'x'.repeat(241)}))).toBe('operation "a": answers[0].answer is 241 characters; the limit is 240');
  expect(swarmValidateTaskManageParams(answers({evidence:'y'.repeat(513)}))).toBe('operation "a": answers[0].evidence is 513 characters; the limit is 512');
  expect(swarmValidateTaskManageParams(answers({answer:''}))).toBe('operation "a": answers[0].answer must be a non-empty string');
  expect(swarmValidateTaskManageParams(answers({extra:1}))).toBe('operation "a": answers[0] has unknown field "extra"; allowed fields are question, answer and evidence');
  expect(swarmValidateTaskManageParams(answers({}))).toBeUndefined();
 });
 // A pre-gate rejection used to surface as one bare string, so a multi-operation
 // call could not show which operation was refused or whether the others ran.
 it('reports pre-gate rejections as a per-operation batch without changing the wire string',async()=>{
  const root=mkdtempSync(join(tmpdir(),'task-envelope-'));
  let tool:any; registerTaskManage({registerTool:t=>{tool=t},appendEntry:()=>{},on:()=>{}});
  const call=tool.execute('id',{operations:[
   {key:'ok1',op:'create',subject:'fine',questions:[{id:'q',text:'t'}]},
   {key:'bad',op:'get',subject:'illegal-for-get'},
   {key:'ok2',op:'list'}]},undefined,undefined,{cwd:root});
  await expect(call).rejects.toThrow(/field "subject" is not valid for get/);
  const error=await call.catch((e:any)=>e);
  expect(error.details.batch.results.map((r:any)=>[r.key,r.status])).toEqual([['ok1','skipped'],['bad','failed'],['ok2','skipped']]);
  expect(error.details.batch.results[1].error.code).toBe('validation_failed');
 });
 it('preserves answers across a reopen but drops them when questions change',()=>{
  const {manager}=fixture();
  expect(manager.execute({operations:[done]}).status).toBe('succeeded');
  expect(manager.execute({operations:[{key:'reopen',op:'update',taskId:'1',status:'in_progress'}]}).status).toBe('succeeded');
  expect(manager.snapshot().tasks[0].answers).toEqual([answer]);
  // The completion gate is deliberately unchanged: reopened work must be
  // re-evidenced in the completing call. Preserving the prior answers keeps
  // them readable via `get` so they can be restated rather than invented.
  expect(manager.execute({operations:[{key:'again',op:'update',taskId:'1',status:'completed'}]}).status).toBe('failed');
  expect(manager.execute({operations:[done]}).status).toBe('succeeded');
  // Replacing the questions invalidates the answers that referenced them.
  expect(manager.execute({operations:[{key:'re',op:'update',taskId:'1',status:'in_progress'}]}).status).toBe('succeeded');
  expect(manager.execute({operations:[{key:'q',op:'update',taskId:'1',questions:[{id:'q2',text:'Different?'}]}]}).status).toBe('succeeded');
  expect(manager.snapshot().tasks[0].answers).toBeUndefined();
 });
 it.each([[{...answer,question:'wrong'}],[answer,answer],[{question:'q1',answer:'unsupported'}]])('rejects malformed answer coverage',answers=>{
  const {manager}=fixture();expect(manager.execute({operations:[{...done,answers} as any]}).status).toBe('failed');
 });
 it('rejects question removal on completion and rolls back atomic prefixes',()=>{
  const {manager}=fixture();
  expect(manager.execute({mode:'atomic',operations:[{key:'rename',op:'update',taskId:'1',subject:'Changed'},{...done,questions:[]}]}).status).toBe('failed');
  expect(manager.snapshot().tasks[0].subject).toBe('Test');
 });
 it('preserves legacy tasks and enforces field bounds',()=>{
  const m=new TaskManager();
  expect(m.execute({operations:[{key:'legacy',op:'create',subject:'Legacy',questions:[question]}]}).status).toBe('succeeded');
  expect(m.execute({operations:[{...create,questions:[{...question,text:'x'.repeat(241)}]}]}).status).toBe('failed');
 });
 it('reports the exact answer field that violates a bound',()=>{
  const {manager}=fixture();
  const result=manager.execute({operations:[{...done,answers:[{...answer,answer:'x'.repeat(241)}]}]});
  expect(result.results[0].error?.message).toContain('answers[0].answer exceeds 240 characters');
 });
 it('registered tool resolves evidence using execution workspace',async()=>{
  const {root}=fixture(); let tool:any;
  registerTaskManage({registerTool:t=>{tool=t},appendEntry:()=>{},on:()=>{}});
  await tool.execute('c',{operations:[create]},undefined,undefined,{cwd:root});
  const result=await tool.execute('d',{operations:[done]},undefined,undefined,{cwd:root});
  expect(result.isError).toBe(false);
 });
});

describe('question completion guidance', () => {
 it('names every missing question and gives the valid recovery shape without mutating state', () => {
  const {manager} = fixture();
  const before = manager.snapshot().tasks.map(task => ({id: task.id, status: task.status, answers: task.answers, questions: task.questions}));
  const result = manager.execute({operations:[{...done, answers:undefined}]});
  expect(result.results[0].error?.message).toContain('q1 (Does it work?)');
  expect(result.results[0].error?.message).toContain('answers:[{question:"<question id>"');
  expect(manager.snapshot().tasks.map(task => ({id: task.id, status: task.status, answers: task.answers, questions: task.questions}))).toEqual(before);
 });
});
