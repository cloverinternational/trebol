import {it,expect} from "vitest";
import {vaultMemoryEvidence} from "../../lib/context/vault-memory-evidence.ts";
import {collectJevEvidence} from "../../lib/context/jev-knowledge-audit.ts";
it("projects only reference metadata, never secret or permission fields",()=>{
 const s=vaultMemoryEvidence("vault_list",JSON.stringify({credentials:[{id:"demo",name:"Testing integration",scope:"global",kind:"api_key",secret:"SENTINEL",allowedCommands:["EVERYTHING"],secretBase64:"ENCODED"}]}))!;
 expect(s).toContain("demo");expect(s).not.toContain("SENTINEL");expect(s).not.toContain("ENCODED");expect(s).not.toContain("EVERYTHING");expect(s).toContain("not secret values");
});
it("rejects get/add/exec, malformed metadata and unknown vault operations",()=>{
 for(const name of ["vault_get","vault_add","vault_exec","vault"])expect(vaultMemoryEvidence(name,'{"secret":"SENTINEL"}')).toBeUndefined();
 expect(vaultMemoryEvidence("vault_list","not-json")).toBeUndefined();
});
it("collector links list action but skips value-bearing results",()=>{
 const entries=[{id:"call",message:{role:"assistant",content:[{type:"toolCall",id:"v",name:"vault",arguments:{action:"list"}}]}},{id:"list",message:{role:"toolResult",toolName:"vault",toolCallId:"v",content:'{"credentials":[{"id":"demo","scope":"global"}]}'}},{id:"secret",message:{role:"toolResult",toolName:"vault_get",content:'{"secret":"SENTINEL"}'}}];
 const b=collectJevEvidence(entries);expect(b.evidence).toHaveLength(1);expect(JSON.stringify(b)).not.toContain("SENTINEL");
});
