import {it,expect} from "vitest";
import {createMemoryQueryBudget} from "../../lib/context/memory-query-budget.ts";
it("reminds once at ten and rearms only on successful project query",()=>{
 const b=createMemoryQueryBudget();for(let i=0;i<9;i++)b.turnEnd();expect(b.takeReminder()).toBeUndefined();b.turnEnd();expect(b.takeReminder()).toContain("memory_history");b.turnEnd();expect(b.takeReminder()).toBeUndefined();
 b.toolCall({toolName:"memory_history",toolCallId:"q",input:{operation:"search"}});b.toolResult({toolCallId:"q",content:[{type:"text",text:'{"knowledge":[]}'}]});expect(b.snapshot().count).toBe(0);
});
it("errors writes other tools and global/session reads do not reset",()=>{
 const b=createMemoryQueryBudget();b.turnEnd();
 for(const [tool,op,scope,error] of [["memory_history","search","global",false],["memory_history","remember","repository",false],["context_search","search","repository",false],["memory_history","search","repository",true]]){
 b.toolCall({toolName:tool,toolCallId:"x",input:{operation:op,scope}});b.toolResult({toolCallId:"x",isError:error});expect(b.snapshot().count).toBe(1);
 }
});
it("restores count and ignores unknown or duplicate results",()=>{
 const b=createMemoryQueryBudget();b.restore({count:9,reminded:false});b.toolResult({toolCallId:"unknown"});b.turnEnd();expect(b.takeReminder()).toBeTruthy();b.newGoal();expect(b.snapshot()).toEqual({count:0,reminded:false});
});
