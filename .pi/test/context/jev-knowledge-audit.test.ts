import { expect, it, vi } from "vitest";
import { auditWithJev, collectJevEvidence, renderJevReview } from "../../lib/context/jev-knowledge-audit.ts";
const user=(id:string,content:any)=>({id,message:{role:"user",content}});
const answer=(category="memory")=>({type:"choice",choice:category,confidence:.9,probabilities:Object.fromEntries(["memory","procedure","mixed","temporary","unresolved","noise"].map(c=>[c,c===category?1:0]))});
it("keeps overflow evidence for next batch and excludes runtime/private reasoning",()=>{
 const rows=[user("r","Goal check: NOT_MET"),{id:"a",message:{role:"assistant",content:[{type:"thinking",thinking:"secret"}]}},...Array.from({length:10},(_,i)=>user(`u${i}`,"x".repeat(1800)))];
 const b=collectJevEvidence(rows);expect(b.evidence.length).toBe(3);expect(b.cursor).toBe("u2");expect(b.skipped).toBe(2);
 expect(collectJevEvidence(rows,b.cursor).evidence[0].id).toBe("u3");expect(collectJevEvidence(rows,"missing").status).toBe("cursor-missing");
});
it("links human answers and skill views using actual tool call metadata before cursor",()=>{
 const rows=[{id:"call",message:{role:"assistant",content:[{type:"toolCall",id:"t",name:"ask_user_question",arguments:{question:"Which store?"}},{type:"toolCall",id:"s",name:"SkillManage",arguments:{action:"view"}}]}},{id:"a",message:{role:"toolResult",toolName:"ask_user_question",toolCallId:"t",content:"User answered: PostgreSQL"}},{id:"s",message:{role:"toolResult",toolName:"SkillManage",toolCallId:"s",content:'{"revision":"v1","instructions":"Verify before changing."}'}}];
 const b=collectJevEvidence(rows,"call");expect(b.evidence[0]).toMatchObject({role:"human_answer"});expect(b.evidence[0].text).toContain("Which store?");expect(b.evidence[1]).toMatchObject({sourceKind:"skill",revision:"v1"});
});
it("uses actual typed state/questions API and rejects invented answers",async()=>{
 const evidence=collectJevEvidence([user("u","Use PostgreSQL")]).evidence;
 const f=vi.fn(async(_url:any,init:any)=>{const p=JSON.parse(init.body);expect(p.state.excerpts).toEqual(evidence);expect(p.questions.e0.type).toBe("choice");expect(p.input).toBeUndefined();return new Response(JSON.stringify({answers:{e0:answer()}}));});
 const r=await auditWithJev(evidence,{apiKey:"test",fetch:f as any});expect(r.findings[0].category).toBe("memory");
 await expect(auditWithJev(evidence,{apiKey:"test",fetch:async()=>new Response(JSON.stringify({answers:{invented:answer()}}))})).rejects.toThrow("unavailable");
});
it("honors abort and rejects oversized responses without returning secret errors",async()=>{
 const e=collectJevEvidence([user("u","fact")]).evidence;const c=new AbortController();c.abort();
 await expect(auditWithJev(e,{apiKey:"test",signal:c.signal,fetch:async(_u,init)=>{expect(init?.signal?.aborted).toBe(true);throw Error("secret");}})).rejects.toThrow("aborted");
 await expect(auditWithJev(e,{apiKey:"test",fetch:async()=>new Response("x".repeat(70000))})).rejects.toThrow("unavailable");
});
it("noise produces no injected review; review remains bounded and source-linked",()=>{
 const e=collectJevEvidence([user("u","fact")]).evidence[0];expect(renderJevReview([{id:"u",category:"noise",confidence:1,evidence:e}])).toBe("");
 const s=renderJevReview(Array.from({length:8},()=>({id:"u",category:"memory" as const,confidence:.9,evidence:{...e,text:"x".repeat(1800)}})));expect(s.length).toBeLessThanOrEqual(6000);expect(s).toContain("source=u");
});
