import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskManager, registerTaskManage, type JournalEntry } from '../src/task-manage.js';

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
  expect(m.execute({operations:[{key:'legacy',op:'create',subject:'Legacy',status:'completed'}]}).status).toBe('succeeded');
  expect(m.execute({operations:[{...create,questions:[{...question,text:'x'.repeat(241)}]}]}).status).toBe('failed');
 });
 it('registered tool resolves evidence using execution workspace',async()=>{
  const {root}=fixture(); let tool:any;
  registerTaskManage({registerTool:t=>{tool=t},appendEntry:()=>{},on:()=>{}});
  await tool.execute('c',{operations:[create]},undefined,undefined,{cwd:root});
  const result=await tool.execute('d',{operations:[done]},undefined,undefined,{cwd:root});
  expect(result.isError).toBe(false);
 });
});
