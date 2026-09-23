import {it,expect} from "vitest";
import {registerSupervisorBudget,observeSupervisorTool,observeSupervisorCompletion,readSupervisorLiveState,resetSupervisorInput,clearSupervisorLiveState} from "../../lib/context/supervisor-live-state.ts";
it("reads live counters and tracks background work by session without copying secrets",()=>{
 const a={sessionManager:{getSessionId:()=>"live-a"}},b={sessionManager:{getSessionId:()=>"live-b"}};let used=7;
 registerSupervisorBudget(a,()=>({used,budget:90}));expect(readSupervisorLiveState(a).budget).toEqual({used:7,budget:90});used=8;expect((readSupervisorLiveState(a).budget as any).used).toBe(8);
 observeSupervisorTool(a,{toolName:"Subagent",content:[{type:"text",text:'{"agent_id":"child","status":"async_launched"}'}]});expect(readSupervisorLiveState(a).waiting.backgroundWorkers).toBe(1);expect(readSupervisorLiveState(b).waiting.backgroundWorkers).toBe(0);
 observeSupervisorCompletion(a,"[agent completed] id=child status=completed");expect(readSupervisorLiveState(a).waiting.backgroundWorkers).toBe(0);
 observeSupervisorTool(a,{isError:true});expect(readSupervisorLiveState(a).waiting.priorToolFailure).toBe(true);resetSupervisorInput(a);expect(readSupervisorLiveState(a).waiting.priorToolFailure).toBe(false);clearSupervisorLiveState(a);clearSupervisorLiveState(b);
});
