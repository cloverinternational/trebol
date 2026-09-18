import {it,expect} from "vitest";
import extension from "../../extensions/40-state/memory-history.ts";
it("registers memory tool and requests visible lookup without duplicate guidance",()=>{
 const hooks=new Map();const tools:any[]=[];
 extension({on:(n:string,h:any)=>hooks.set(n,h),registerTool:(t:any)=>tools.push(t),registerCommand(){},getActiveTools:()=>["memory_history"]});
 expect(tools.some(t=>t.name==="memory_history")).toBe(true);
 const start=hooks.get("before_agent_start");const a=start({systemPrompt:"base"});
 expect(a.systemPrompt).toContain("call memory_history search");
 expect(start(a).systemPrompt).toBe(a.systemPrompt);
});
it("respects explicitly unavailable tool rather than advertising it",()=>{
 const hooks=new Map();extension({on:(n:string,h:any)=>hooks.set(n,h),registerTool(){},registerCommand(){},getActiveTools:()=>[]});
 expect(hooks.get("before_agent_start")({systemPrompt:"base"})).toBeUndefined();
});
