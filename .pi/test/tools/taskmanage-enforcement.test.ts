import {it,expect} from "vitest";
import {registerTaskManageExtension} from "../../extensions/30-tools/taskmanage.ts";
it("default adapter blocks mutation until an active task exists while allowing recovery and reads",async()=>{
 const handlers=new Map<string,Function[]>();const pi={on:(n:string,f:Function)=>handlers.set(n,[...(handlers.get(n)??[]),f]),appendEntry(){},registerTool(){}};
 const {manager}=registerTaskManageExtension(pi);
 const ctx={sessionId:"default-enforcement-test",hasUI:true};
 async function before(name:string,input:any){const results=[];for(const f of handlers.get("tool_call")??[])results.push(await f({toolName:name,input,toolCallId:Math.random().toString()},ctx));return results.find(r=>r?.block);}
 expect(await before("apply_patch",{input:"patch"})).toMatchObject({block:true});
 expect(await before("TaskManage",{operations:[]})).toBeUndefined();expect(await before("Read",{path:"file"})).toBeUndefined();
 manager.execute({operations:[{key:"task",op:"create",subject:"Implement fixture",questions:[{id:"q",text:"Does the fixture work?"}],status:"in_progress",active:true}]});
 expect(await before("apply_patch",{input:"patch"})).toBeUndefined();
});
