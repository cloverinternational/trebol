import {describe,it,expect,vi} from 'vitest';
import {registerTaskManage} from '../src/task-manage.js';
function fixture() {
 const handlers=new Map<string,Function[]>(),tools:any[]=[];
 const pi={registerTool:(t:any)=>tools.push(t),appendEntry:()=>{},on:(e:string,h:Function)=>handlers.set(e,[...(handlers.get(e)??[]),h])};
 const manager=registerTaskManage(pi as any);
 const bind=(event:string,entries:any[])=>{for(const h of handlers.get(event)??[])h({}, {sessionManager:{getEntries:()=>entries,getBranch:()=>entries}});};
 return {manager,tool:tools[0],bind};
}
const result={type:'message',message:{role:'toolResult',toolName:'Bash',content:[{type:'text',text:'PRIVATE_RESULT_BODY'}]}};
const create={operations:[{key:'c',op:'create',subject:'lifecycle',questions:[{id:'q',text:'Proof?'}]}]};
const done=(evidence:string)=>({operations:[{key:'d',op:'update',taskId:'1',status:'completed',answers:[{question:'q',answer:'yes',evidence}]}]});
describe('evidence lifecycle',()=>{
 it('rebinds session_switch and discards previous-session tasks/results',async()=>{
  const f=fixture();f.bind('session_start',[result]);await f.tool.execute('c',create);
  f.bind('session_switch',[]);
  expect(f.manager.snapshot().tasks).toHaveLength(0);
  await f.tool.execute('c2',create);
  expect((await f.tool.execute('d',done('tool:Bash'))).isError).toBe(true);
 });
 it('pre-aborted execution persists no tasks',async()=>{
  const f=fixture();f.bind('session_start',[]);const controller=new AbortController();controller.abort();
  expect((await f.tool.execute('c',create,controller.signal)).isError).toBe(true);
  expect(f.manager.snapshot().tasks).toHaveLength(0);
 });
 it('suggests bounded canonical citations without exposing result bodies',async()=>{
  const f=fixture();f.bind('session_start',[result]);await f.tool.execute('c',create);
  const failure=await f.tool.execute('d',done('tool:Typo'));
  const message=JSON.stringify(failure);
  expect(message).toContain('tool:Bash#1');expect(message).not.toContain('PRIVATE_RESULT_BODY');
 });
 it('sees results appended in the same session turn',async()=>{
  const f=fixture(),entries:any[]=[];f.bind('session_start',entries);await f.tool.execute('c',create);
  entries.push(result);expect((await f.tool.execute('d',done('tool:Bash#1'))).isError).toBe(false);
 });
});

describe('parallel entry and cancelled completion controls',()=>{
 it('serializes synchronous manager mutations from concurrent tool invocations',async()=>{
  const f=fixture();f.bind('session_start',[result]);
  await Promise.all(['a','b'].map(key=>f.tool.execute(key,{operations:[{...create.operations[0],key}]})));
  expect(f.manager.snapshot().tasks.map(t=>t.id)).toEqual(['1','2']);
  expect(f.manager.snapshot().tasks.every(t=>t.status==='pending')).toBe(true);
 });
 it('cancelled completion preserves saved answers and allows recovery',async()=>{
  const f=fixture();f.bind('session_start',[result]);await f.tool.execute('c',create);
  const abort=new AbortController();abort.abort();
  const before=f.manager.snapshot().tasks;
  expect((await f.tool.execute('cancel',done('tool:Bash'),abort.signal)).isError).toBe(true);
  expect(f.manager.snapshot().tasks).toEqual(before);
  expect((await f.tool.execute('retry',done('tool:Bash'))).isError).toBe(false);
 });
 it('never treats a provider-visible prefix as an implicit alias',async()=>{
  const f=fixture();f.bind('session_start',[{...result,message:{...result.message,toolName:'mcp__github__list_issues'}}]);
  await f.tool.execute('c',create);
  expect((await f.tool.execute('wrong',done('tool:list_issues'))).isError).toBe(true);
  expect((await f.tool.execute('exact',done('tool:mcp__github__list_issues'))).isError).toBe(false);
 });
});

describe('MCP registration to task evidence integration',()=>{
 it('uses the actual MCPManager registered name without guessing aliases',async()=>{
  const {MCPManager}=await import('../../mcp/src/index.js');
  const tools:any[]=[];
  vi.stubGlobal('fetch',vi.fn(async(_url:any,init:any)=>{
   const request=JSON.parse(init.body);
   const payload=request.method==='tools/list'?{tools:[{name:'inspect',inputSchema:{type:'object'}}]}:request.method==='tools/call'?{content:[{type:'text',text:'fixture result'}]}:{};
   return new Response(JSON.stringify({jsonrpc:'2.0',id:request.id,result:payload}),{status:200});
  }));
  const mcp=new MCPManager([{id:'fixture',type:'http',url:'http://localhost.invalid/mcp'}],{registerTool:t=>tools.push(t)});
  try {
   await mcp.discover('fixture');expect(tools[0].name).toBe('mcp__fixture__inspect');
   const output=await tools[0].execute('call',{});
   const f=fixture();f.bind('session_start',[{type:'message',message:{role:'toolResult',toolName:tools[0].name,...output}}]);
   await f.tool.execute('c',create);
   expect((await f.tool.execute('d',done(`tool:${tools[0].name}#1`))).isError).toBe(false);
  } finally {await mcp.close();vi.unstubAllGlobals();}
 });
});

describe('atomic cancellation rollback',()=>{
 it('rolls back a successful prefix when cancellation occurs before the next operation',async()=>{
  const {TaskManager}=await import('../src/task-manage.js');const manager=new TaskManager();
  let checks=0;const signal={get aborted(){return ++checks>1;}} as AbortSignal;
  const before=manager.snapshot().tasks;
  const batch=manager.execute({mode:'atomic',operations:[{...create.operations[0],key:'first'} as any,{...create.operations[0],key:'second'} as any]},signal);
  expect(batch.status).toBe('failed');expect(manager.snapshot().tasks).toEqual(before);
 });
});

describe('historical alias migration safety',()=>{
 it('does not reinterpret a retained alias using a new host mapping',()=>{
  const tools:any[]=[];const handlers=new Map<string,Function>();
  const entries:any[]=[{type:'message',message:{role:'toolResult',toolName:'Other'}}];
  const manager=registerTaskManage({registerTool:(t:any)=>tools.push(t),appendEntry:()=>{},on:(n:string,h:Function)=>handlers.set(n,h)} as any,undefined,{toolAliases:{legacy:['Other']}});
  handlers.get('session_start')!({}, {sessionManager:{getEntries:()=>entries}});
  manager.execute(create as any);
  manager.execute({operations:[{key:'save',op:'update',taskId:'1',answers:[{question:'q',answer:'historical',evidence:'tool:legacy'}]}]});
  // Restore a historical snapshot whose alias provenance is unavailable.
  const snapshot=manager.snapshot();snapshot.tasks[0].answers![0].evidence='tool:legacy';manager.restore(snapshot);
  expect(manager.execute({operations:[{key:'finish',op:'update',taskId:'1',status:'completed'}]}).status).toBe('failed');
 });
});

describe('registration configuration ownership',()=>{
 it('accepts frozen options without installing callbacks on the caller object',()=>{
  const options=Object.freeze({});
  expect(()=>registerTaskManage({registerTool:()=>{},appendEntry:()=>{},on:()=>{}} as any,undefined,options)).not.toThrow();
  expect(Object.keys(options)).toEqual([]);
 });
 it('does not share session callbacks when registrations reuse options',()=>{
  const options={};const make=()=>{
   const handlers=new Map<string,Function>();const m=registerTaskManage({registerTool:()=>{},appendEntry:()=>{},on:(n:string,h:Function)=>handlers.set(n,h)} as any,undefined,options);
   return {m,bind:(entries:any[])=>handlers.get('session_start')!({}, {sessionManager:{getEntries:()=>entries}})};
  };
  const first=make(),second=make();first.bind([result]);second.bind([]);
  first.m.execute(create as any);second.m.execute(create as any);
  expect(first.m.execute(done('tool:Bash') as any).status).toBe('succeeded');
  expect(second.m.execute(done('tool:Bash') as any).status).toBe('failed');
 });
});
