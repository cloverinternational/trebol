import {it,expect,vi} from "vitest";
import {mkdtempSync,rmSync} from "node:fs";import {tmpdir} from "node:os";import {join} from "node:path";
vi.mock("@earendil-works/pi-tui",()=>({SettingsList:class{}}));
vi.mock("../../lib/runtime/bootstrap-dispatch.ts",()=>({dispatchBootstrapHandoff:vi.fn(async()=>({content:[{type:"text",text:'{"status":"succeeded","results":[{"status":"succeeded"}]}'}]}))}));
import bootstrap from "../../extensions/00-runtime/bootstrap.ts";
import {dispatchBootstrapHandoff} from "../../lib/runtime/bootstrap-dispatch.ts";
it("establishes a task even with omitted commitTasks and missing model",async()=>{
 const cwd=mkdtempSync(join(tmpdir(),"bootstrap-seed-"));const tools=new Map<string,any>();
 try{
  (globalThis as any)[Symbol.for("pi-swarm-task-manager")]={snapshot:()=>({tasks:[]})};
  bootstrap({registerCommand(){},on(){},registerTool:(t:any)=>tools.set(t.name,t),getActiveTools:()=>["TaskManage"],appendEntry(){}});
  const result=await tools.get("bootstrap").execute("call",{task:"Inspect Jev behavior"},new AbortController().signal,undefined,{cwd,sessionManager:{getEntries:()=>[]}});
  expect(dispatchBootstrapHandoff).toHaveBeenCalledWith("TaskManage",expect.objectContaining({operations:[expect.objectContaining({op:"create",status:"in_progress",active:true})]}),expect.anything(),expect.anything(),["TaskManage"]);
  expect(result.isError).toBe(true);expect(result.content[0].text).toContain("Task established");
 }finally{delete (globalThis as any)[Symbol.for("pi-swarm-task-manager")];rmSync(cwd,{recursive:true,force:true});}
});
