import {it,expect,vi} from "vitest";
import {resolveJevCredential} from "../../lib/context/jev-credential.ts";
it("environment wins without reading vault",async()=>{const get=vi.fn();expect(await resolveJevCredential({env:{TYPESAFE_API_KEY:"test-env"},get})).toEqual({apiKey:"test-env",source:"environment"});expect(get).not.toHaveBeenCalled();});
it("uses only explicit TypeSafe credential ID",async()=>{const get=vi.fn(async()=>({success:true,kind:"api_key",secret:"test-value"}));expect((await resolveJevCredential({env:{},get}))?.source).toBe("vault");expect(get).toHaveBeenCalledWith({id:"typesafe-api-key"});});
it("missing, expired, wrong kind, disabled and errors do not yield a credential",async()=>{for(const value of [{success:false},{success:true,kind:"password",secret:"x"},{success:true,kind:"api_key",secret:""}])expect(await resolveJevCredential({env:{},get:async()=>value})).toBeUndefined();const get=vi.fn();expect(await resolveJevCredential({env:{PI_SWARM_JEV_VAULT:"off"},get})).toBeUndefined();expect(get).not.toHaveBeenCalled();expect(await resolveJevCredential({env:{},get:async()=>{throw Error("secret")}})).toBeUndefined();});
it("resolves configured provider first and never falls back for explicit provider failure",async()=>{
 const config={credentialMode:"provider" as const,provider:"typesafe",envVar:"TYPESAFE_API_KEY",credentialId:"typesafe-api-key"};const get=vi.fn();const registry={getApiKeyForProvider:vi.fn(async()=>"provider-key")};
 expect(await resolveJevCredential({config,registry,get,env:{TYPESAFE_API_KEY:"env-key"}})).toEqual({apiKey:"provider-key",source:"provider"});expect(get).not.toHaveBeenCalled();
 expect(await resolveJevCredential({config,registry:{getApiKeyForProvider:async()=>undefined},get,env:{TYPESAFE_API_KEY:"env-key"}})).toBeUndefined();
});
