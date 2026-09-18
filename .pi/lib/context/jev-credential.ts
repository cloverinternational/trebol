import { vaultGet } from "../tools/swarm-vault-tools.ts";
/** Internal secret resolution only: never serialize this return value. */
export async function resolveJevCredential(options: {
 env?: Record<string,string|undefined>;
 get?: typeof vaultGet;
 config?:{credentialMode:"auto"|"provider"|"environment"|"vault";provider:string;envVar:string;credentialId:string};
 registry?:{getApiKeyForProvider(provider:string):Promise<string|undefined>};
} = {}): Promise<{ apiKey:string; source:"environment"|"vault"|"provider" } | undefined> {
 const env=options.env??process.env;
 const config=options.config;const mode=config?.credentialMode??"auto";
 if(options.registry&&(mode==="auto"||mode==="provider")){
  try{const key=await options.registry.getApiKeyForProvider(config?.provider??"typesafe");if(key?.trim())return{apiKey:key.trim(),source:"provider"};}catch{}
  if(mode==="provider")return undefined;
 } else if(mode==="provider")return undefined;
 if(mode==="auto"||mode==="environment"){
  const key=env[config?.envVar??"TYPESAFE_API_KEY"];if(key?.trim())return {apiKey:key.trim(),source:"environment"};
  if(mode==="environment")return undefined;
 }
 if(env.PI_SWARM_JEV_VAULT==="off")return undefined;
 try {
  const result=await (options.get??vaultGet)({id:config?.credentialId??(env.PI_SWARM_JEV_CREDENTIAL_ID?.trim()||"typesafe-api-key")});
  if(result.success===true && ["api_key","bearer_token","env_var"].includes(result.kind) && typeof result.secret==="string" && result.secret.trim())return {apiKey:result.secret.trim(),source:"vault"};
 }catch{/* Never surface vault exception contents. */}
 return undefined;
}
