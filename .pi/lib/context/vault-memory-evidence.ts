import { redactContext } from "./page-index-memory.ts";
/** Only explicit metadata-list results may become credential-reference evidence.
 * Never parse get/add/exec payloads or inspect the credential store here. */
export function vaultMemoryEvidence(tool:string, raw:string, args?:any):string|undefined {
 if(!/^vault(?:_|$)/i.test(tool))return raw;
 if(tool!=="vault_list" && !(tool==="vault" && args?.action==="list"))return undefined;
 if(raw.length>65536)return undefined;
 let value:any;
 try{value=JSON.parse(raw);}catch{
  const wrapped=/<data><!\[CDATA\[([\s\S]*?)\]\]><\/data>/.exec(raw);
  if(!wrapped)return undefined;try{value=JSON.parse(wrapped[1]);}catch{return undefined;}
 }
 if(!Array.isArray(value?.credentials))return undefined;
 const credentials=value.credentials.slice(0,20).flatMap((c:any)=>{
  if(typeof c?.id!=="string"||!c.id.trim())return [];
  const field=(s:unknown)=>typeof s==="string"?redactContext(s).slice(0,200):undefined;
  return [{id:field(c.id),purpose:field(c.name),scope:field(c.scope),kind:field(c.kind)}];
 });
 return JSON.stringify({credentialReferences:credentials,meaning:"Observed metadata only; not secret values, usage authorization, or proof of current validity. Purpose may be absent; do not infer it.",truncated:value.credentials.length>20||value.has_more===true});
}
