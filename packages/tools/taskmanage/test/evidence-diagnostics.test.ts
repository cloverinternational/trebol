import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskManager, resolveToolEvidence } from '../src/task-manage.js';
import { swarmValidateTaskManageParams } from '../src/swarm-validate.js';

describe('issue-linked evidence diagnostics and identity', () => {
  it('#169/#193 distinguishes missing, non-array and empty operations', () => {
    expect(swarmValidateTaskManageParams({})).toMatch(/operations is required/);
    expect(swarmValidateTaskManageParams({operations: '[]'})).toMatch(/operations must be an array/);
    expect(swarmValidateTaskManageParams({operations: []})).toMatch(/at least one operation/);
    expect(swarmValidateTaskManageParams({operations:[{key:'n',op:'update',taskId:'1',addNote:'«Cotización» <em>quoted "x"</em>\n# café',noteType:'observation'}]})).toBeUndefined();
  });
  it('#133/#178/#186/#189 resolves only exact names or explicitly registered unambiguous aliases', () => {
    const session = {getEntries: () => [{type:'message',message:{role:'toolResult',toolName:'Bash'}}]};
    expect(resolveToolEvidence('tool:mcp__Bash#1', session, {mcp__Bash:['Bash']})).toBe(true);
    expect(resolveToolEvidence('tool:bash', session, {})).toBe(false);
    expect(resolveToolEvidence('tool:mcp__Bash', session, {mcp__Bash:['Bash','Other']})).toBe(false);
    expect(resolveToolEvidence('tool:Bash#2', session, {})).toBe(false);
  });
  it('#176 rejects unknown answer IDs even on save without completion', () => {
    const manager = new TaskManager();
    expect(manager.execute({operations:[{key:'c',op:'create',subject:'test',questions:[{id:'q',text:'Proof?'}]}]}).status).toBe('succeeded');
    const before = manager.snapshot().tasks;
    expect(manager.execute({operations:[{key:'a',op:'update',taskId:'1',answers:[{question:'other',answer:'x',evidence:'proof.md'}]}]}).status).toBe('failed');
    expect(manager.snapshot().tasks).toEqual(before);
  });
  it('#134/#187/#194 distinguishes unavailable file from invalid range/heading and access denial', () => {
    const root = mkdtempSync(join(tmpdir(),'tm-diag-'));
    try {
      writeFileSync(join(root,'proof.md'),'# Proof\nbody\n');
      const manager = new TaskManager(undefined,undefined,{workspaceRoot:root});
      manager.execute({operations:[{key:'c',op:'create',subject:'test',questions:[{id:'q',text:'Proof?'}]}]});
      const check = (evidence:string) => manager.execute({operations:[{key:evidence,op:'update',taskId:'1',status:'completed',answers:[{question:'q',answer:'yes',evidence}]}]}).results[0].error?.message;
      expect(check('absent.md')).toMatch(/missing_file/);
      expect(check('proof.md#L900')).toMatch(/invalid_line_range/);
      expect(check('proof.md#Absent')).toMatch(/missing_heading/);
      expect(check('../outside.md')).toMatch(/outside_allowed_roots/);
      expect(check('tool:Unknown')).toMatch(/tool_result_unavailable/);
    } finally { rmSync(root,{recursive:true,force:true}); }
  });
});

describe('trusted evidence policy and revocation', () => {
  it('rechecks host authorization before reading saved evidence', () => {
    const root=mkdtempSync(join(tmpdir(),'tm-auth-'));
    let allowed=true;
    try {
      writeFileSync(join(root,'proof.md'),'# Proof\nbody');
      const manager=new TaskManager(undefined,undefined,{workspaceRoot:root,canReadEvidence:()=>allowed});
      expect(manager.execute({operations:[{key:'c',op:'create',subject:'policy',questions:[{id:'q',text:'Proof?'}]}]}).status).toBe('succeeded');
      expect(manager.execute({operations:[{key:'s',op:'update',taskId:'1',answers:[{question:'q',answer:'yes',evidence:'proof.md'}]}]}).status).toBe('succeeded');
      allowed=false;
      const result=manager.execute({operations:[{key:'d',op:'update',taskId:'1',status:'completed'}]});
      expect(result.status).toBe('failed');
      expect(result.results[0].error?.message).toContain('access_denied');
      expect(manager.snapshot().tasks[0].status).toBe('pending');
    } finally {rmSync(root,{recursive:true,force:true});}
  });
});

describe('registered adapter evidence roundtrip', () => {
  it('binds a current-branch result through an explicit host alias', async () => {
    const {registerTaskManage}=await import('../src/task-manage.js');
    const tools:any[]=[]; const handlers=new Map<string,Function>();
    const entries:any[]=[{type:'message',message:{role:'toolResult',toolName:'Bash',content:[{type:'text',text:'done'}]}}];
    const pi={registerTool:(tool:any)=>tools.push(tool),appendEntry:(type:string,data:any)=>entries.push({type,data}),on:(name:string,handler:Function)=>handlers.set(name,handler)};
    const aliases={mcp__Bash:['Bash']};
    const manager=registerTaskManage(pi as any,undefined,{toolAliases:aliases});
    handlers.get('session_start')!({}, {sessionManager:{getEntries:()=>entries,getBranch:()=>entries}});
    const tool=tools.find(t=>t.name==='TaskManage');
    const create=await tool.execute('c',{operations:[{key:'c',op:'create',subject:'roundtrip',questions:[{id:'q',text:'Proof?'}]}]});
    expect(JSON.stringify(create)).toContain('succeeded');
    const done=await tool.execute('d',{operations:[{key:'d',op:'update',taskId:'1',status:'completed',answers:[{question:'q',answer:'result exists',evidence:'tool:mcp__Bash#1'}]}]});
    expect(JSON.stringify(done)).toContain('"status":"completed"');
    expect(manager.snapshot().tasks[0].answers?.[0].evidence).toBe('tool:Bash#1');
    aliases.mcp__Bash=['Other'];
    expect(manager.execute({operations:[{key:'r',op:'update',taskId:'1',status:'pending'}]}).status).toBe('succeeded');
    expect(manager.execute({operations:[{key:'again',op:'update',taskId:'1',status:'completed'}]}).status).toBe('succeeded');
    entries.splice(0,1);
    manager.execute({operations:[{key:'r2',op:'update',taskId:'1',status:'pending'}]});
    expect(manager.execute({operations:[{key:'gone',op:'update',taskId:'1',status:'completed'}]}).status).toBe('failed');
  });
});

describe('file containment safety controls', () => {
  it('rejects symlink escapes and revoked extra roots on saved evidence', () => {
    const root=mkdtempSync(join(tmpdir(),'tm-safe-')); const extra=mkdtempSync(join(tmpdir(),'tm-extra-'));
    const options={workspaceRoot:root,evidenceRoots:[extra]};
    try {
      writeFileSync(join(extra,'proof.md'),'# Proof\nbody');
      symlinkSync(join(extra,'proof.md'),join(root,'escape.md'));
      const m=new TaskManager(undefined,undefined,options);
      m.execute({operations:[{key:'c',op:'create',subject:'safe',questions:[{id:'q',text:'Proof?'}]}]});
      const finish=(evidence:string,key:string)=>m.execute({operations:[{key,op:'update',taskId:'1',status:'completed',answers:[{question:'q',answer:'yes',evidence}]}]});
      expect(finish('escape.md','escape').status).toBe('failed');
      expect(m.execute({operations:[{key:'save',op:'update',taskId:'1',answers:[{question:'q',answer:'yes',evidence:join(extra,'proof.md')}]}]}).status).toBe('succeeded');
      options.evidenceRoots=[];
      expect(m.execute({operations:[{key:'revoked',op:'update',taskId:'1',status:'completed'}]}).status).toBe('failed');
    } finally {rmSync(root,{recursive:true,force:true});rmSync(extra,{recursive:true,force:true});}
  });
});

describe('session evidence safety controls', () => {
  it('uses only results on the current branch, counts per tool, and ignores pending calls', () => {
    const result=(toolName:string,isError=false)=>({type:'message',message:{role:'toolResult',toolName,isError}});
    const entries=[result('Bash'),result('Other'),result('Bash',true)];
    const session={getEntries:()=>entries,getBranch:()=>[entries[2],{type:'message',message:{role:'assistant',content:[{type:'toolCall',name:'Pending'}]}}]};
    expect(resolveToolEvidence('tool:Bash#1',session)).toBe(true);
    expect(resolveToolEvidence('tool:Bash#2',session)).toBe(false);
    expect(resolveToolEvidence('tool:Other',session)).toBe(false);
    expect(resolveToolEvidence('tool:Pending',session)).toBe(false);
    expect(resolveToolEvidence('tool:Bash#0',session)).toBe(false);
    expect(resolveToolEvidence('tool:Bash#-1',session)).toBe(false);
    expect(resolveToolEvidence('tool:Bash',undefined)).toBe(false);
  });
  it('prefers an exact stored name even when an alias with the same name points elsewhere', () => {
    const session={getEntries:()=>[{type:'message',message:{role:'toolResult',toolName:'Bash'}}]};
    expect(resolveToolEvidence('tool:Bash',session,{Bash:['Other','Third']})).toBe(true);
  });
});
