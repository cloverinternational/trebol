import { withDefaultToolRenderer } from "@pi-swarm/core";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

export type Transport = "stdio" | "http" | "sse";
// Plexus currently negotiates MCP 2025-11-25.
export const MCP_PROTOCOL_VERSION = "2025-11-25";
export type FailureKind = "config" | "auth" | "timeout" | "transport" | "protocol" | "server" | "denied";
export class MCPError extends Error { constructor(public readonly kind: FailureKind, message: string, public readonly cause?: unknown) { super(message); this.name = "MCPError"; } }
export interface MCPManifest { id: string; type: Transport; command?: string; args?: string[]; url?: string; cwd?: string; environment?: string[]; headers?: Record<string,string>; apiKey?: string; apiKeyHeader?: string; tools?: string[]; excludeTools?: string[]; enabled?: boolean; lazy?: boolean; timeoutMs?: number; oauth?: { tokenEnv: string; scopes?: string[] } }
export interface MCPTool { name: string; description?: string; inputSchema?: unknown; serverId: string }
export interface MCPResource { uri: string; name?: string; description?: string; mimeType?: string; serverId: string }
export interface MCPPrompt { name: string; description?: string; arguments?: unknown[]; serverId: string }
export interface MCPClient { initialize(): Promise<unknown>; listTools(): Promise<MCPTool[]>; callTool(name: string, args: unknown, signal?: AbortSignal): Promise<unknown>; listResources(): Promise<MCPResource[]>; readResource(uri: string, signal?: AbortSignal): Promise<unknown>; listPrompts(): Promise<MCPPrompt[]>; getPrompt(name: string, args: unknown, signal?: AbortSignal): Promise<unknown>; onDisconnect(listener: () => void): void; close(): Promise<void> }

const requestMeta = () => ({
  "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION,
  "io.modelcontextprotocol/clientInfo": { name: "pi-swarm", version: "1" },
  "io.modelcontextprotocol/clientCapabilities": {},
});
const withRequestMeta = (params: any = {}) => ({ ...params, _meta: { ...requestMeta(), ...(params?._meta ?? {}) } });

const ID = /^[a-zA-Z0-9_-]{1,128}$/;
export function validateManifest(m: MCPManifest, closed = true): string[] {
  const e: string[] = [];
  if (!m.id || !ID.test(m.id)) e.push("id must match [a-zA-Z0-9_-]{1,128}");
  if (!["stdio","http","sse"].includes(m.type)) e.push("type must be stdio, http, or sse");
  if (m.type === "stdio" && !m.command) e.push("stdio command is required");
  if (m.type !== "stdio" && !m.url) e.push("remote url is required");
  if (m.url) try { const u = new URL(m.url); if (!/^https?:$/.test(u.protocol)) e.push("url must use http or https"); } catch { e.push("url is invalid"); }
  if (m.tools?.length && m.excludeTools?.length) e.push("tools and excludeTools are mutually exclusive");
  if (m.timeoutMs !== undefined && (!Number.isFinite(m.timeoutMs) || m.timeoutMs <= 0)) e.push("timeoutMs must be positive");
  for (const n of m.environment ?? []) if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(n)) e.push(`invalid environment name: ${n}`);
  for (const [header, env] of Object.entries(m.headers ?? {})) if (!(m.environment ?? []).includes(env) && !(m.apiKey !== undefined && header.toLowerCase() === (m.apiKeyHeader ?? "authorization").toLowerCase())) e.push(`header ${header} references non-allowlisted environment ${env}`);
  if (m.oauth && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(m.oauth.tokenEnv)) e.push("oauth.tokenEnv is invalid");
  if (closed && m.type === "stdio" && m.command && !m.command.startsWith("/") && !m.command.includes("/")) e.push("closed mode requires a pinned stdio command path");
  return e;
}
function allowedTools(m: MCPManifest, tools: MCPTool[]) { return tools.filter(t => !m.tools?.length || m.tools.includes(t.name)).filter(t => !m.excludeTools?.includes(t.name)); }
function timeout(ms: number, signal?: AbortSignal) { const c = new AbortController(); const timer = setTimeout(() => c.abort(new MCPError("timeout", `MCP request timed out after ${ms}ms`)), ms); if (signal) signal.addEventListener("abort", () => c.abort(signal.reason), { once:true }); return { signal:c.signal, done:() => clearTimeout(timer) }; }

// A server that refuses to start usually says why on stderr ("no gh login", "command not found"). Keep
// its last line for the failure message, stripped of control codes, capped, and with credentials redacted.
const SECRET = /(token|api[-_]?key|authorization|secret|password)\s*[:=]\s*\S+/gi;
function lastLine(previous: string, chunk: string): string {
	const line = chunk.split(/\r?\n/).map((part) => part.trim()).filter(Boolean).pop();
	if (!line) return previous;
	return line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(SECRET, "$1=<redacted>").slice(0, 160);
}

class StdioClient implements MCPClient {
  private p: ChildProcessWithoutNullStreams; private listeners: (() => void)[] = []; private down?: MCPError; private next = 1; private pending = new Map<number,{resolve:(v:any)=>void;reject:(e:any)=>void}>(); private stderrTail = "";
  constructor(private m: MCPManifest) { const env: NodeJS.ProcessEnv = {}; for (const k of m.environment ?? []) if (process.env[k] !== undefined) env[k] = process.env[k]; this.p = spawn(m.command!, m.args ?? [], { cwd:m.cwd, env:{...env, PATH:process.env.PATH}, stdio:["pipe","pipe","pipe"] }); const rl=createInterface({input:this.p.stdout}); rl.on("line", line=>{ try { const x=JSON.parse(line); if (x.id && this.pending.has(x.id)) { const p=this.pending.get(x.id)!; this.pending.delete(x.id); x.error ? p.reject(new MCPError("server", x.error.message ?? "MCP server error", x.error)) : p.resolve(x.result); } } catch {} }); this.p.on("error", e=>this.fail(new MCPError("transport", "failed to start MCP server", e))); this.p.on("exit",()=>this.fail(new MCPError("transport", this.stderrTail ? `MCP server exited: ${this.stderrTail}` : "MCP server exited"))); this.guardPipes(); }
  // A server that dies (or closes its own stdin) surfaces as EPIPE on the child's pipes. Those are async
  // 'error' events: unlistened, Node rethrows them and the whole session exits. They become disconnect
  // failures instead, and stderr is drained so a chatty server cannot block on a full pipe.
  private guardPipes(){ for (const stream of [this.p.stdin, this.p.stdout, this.p.stderr]) stream.on("error", e=>this.fail(new MCPError("transport","MCP server pipe closed", e))); this.p.stderr.on("data", chunk=>{ this.stderrTail = lastLine(this.stderrTail, String(chunk)); }); this.p.stderr.resume(); }
  private rejectAll(e: Error){ for(const p of this.pending.values()) p.reject(e); this.pending.clear(); }
  private fail(e: MCPError){ if(this.down) return; this.down=e; this.rejectAll(e); for(const l of this.listeners) l(); }
  onDisconnect(listener: () => void){ this.listeners.push(listener); }
  private request(method:string, params:unknown = {}, signal?:AbortSignal):Promise<any>{ if(this.down) return Promise.reject(this.down); const id=this.next++; const t=timeout(this.m.timeoutMs ?? 30000, signal); return new Promise((resolve,reject)=>{ this.pending.set(id,{resolve:v=>{t.done();resolve(v)},reject:e=>{t.done();reject(e)}}); this.p.stdin.write(JSON.stringify({jsonrpc:"2.0",id,method,params:withRequestMeta(params)})+"\n",e=>{if(e)this.fail(new MCPError("transport","failed to write MCP request",e))}); t.signal.addEventListener("abort",()=>{this.pending.delete(id);reject(t.signal.reason instanceof Error?t.signal.reason:new MCPError("timeout","MCP request timed out"))},{once:true}); }); }
  // A notification has nobody to reject; a dead pipe here becomes a disconnect, never an uncaught throw.
  private notify(method:string, params:unknown):void{ if(this.down) return; try { this.p.stdin.write(JSON.stringify({jsonrpc:"2.0",method,params})+"\n"); } catch(e){ this.fail(new MCPError("transport","failed to write MCP notification",e)); } }
  async initialize(){const result=await this.request("initialize",{protocolVersion:MCP_PROTOCOL_VERSION,capabilities:{},clientInfo:{name:"pi-swarm",version:"1"}}); this.notify("notifications/initialized",{_meta:requestMeta()}); return result;}
  async listTools(){const r=await this.request("tools/list",{}); return (r?.tools??[]).map((x:any)=>({...x,serverId:this.m.id}));}
  async listResources(){const r=await this.request("resources/list",{}); return (r?.resources??[]).map((x:any)=>({...x,serverId:this.m.id}));}
  readResource(uri:string,signal?:AbortSignal){return this.request("resources/read",{uri},signal)}
  listPrompts(){return this.request("prompts/list",{}).then((r:any)=>(r?.prompts??[]).map((x:any)=>({...x,serverId:this.m.id})))}
  getPrompt(name:string,args:unknown,s?:AbortSignal){return this.request("prompts/get",{name,arguments:args},s)}
  callTool(name:string,args:unknown,signal?:AbortSignal){return this.request("tools/call",{name,arguments:args},signal)}
  async close(){ const e = this.down ?? new MCPError("transport","MCP client closed"); this.down = e; this.rejectAll(e); this.p.kill(); }
}
class RemoteClient implements MCPClient {
  private listeners: (() => void)[] = []; constructor(private m:MCPManifest){} onDisconnect(listener: () => void){ this.listeners.push(listener); } private lost(e: MCPError): never { for(const l of this.listeners) l(); throw e; } private async request(method:string,params:any={},signal?:AbortSignal){const t=timeout(this.m.timeoutMs??30000,signal); try { const headers:Record<string,string>={"content-type":"application/json",accept:"application/json, text/event-stream",...Object.fromEntries(Object.entries(this.m.headers??{}).map(([h,e])=>[h,process.env[e as string]??""]))}; headers["MCP-Protocol-Version"] = MCP_PROTOCOL_VERSION; if(this.m.apiKey) headers[this.m.apiKeyHeader ?? "authorization"] = this.m.apiKey; if(this.m.oauth){const token=process.env[this.m.oauth.tokenEnv]; if(!token) throw new MCPError("auth",`missing OAuth token in ${this.m.oauth.tokenEnv}`); headers.authorization=`Bearer ${token}`;} let r:Response; try { r=await fetch(this.m.url!,{method:"POST",headers,body:JSON.stringify({jsonrpc:"2.0",id:Date.now(),method,params:withRequestMeta(params)}),signal:t.signal}); } catch(e){ if(t.signal.aborted) throw e; this.lost(new MCPError("transport","MCP HTTP request failed",e)); } if(!r.ok) this.lost(new MCPError("transport",`MCP HTTP ${r.status}`)); const text=await r.text(); const line=text.split("\n").find(x=>x.startsWith("data:"))?.slice(5).trim()??text; const x=JSON.parse(line); if(x.error) throw new MCPError("server",x.error.message??"MCP server error",x.error); return x.result; } catch(e){if(e instanceof MCPError)throw e; if((e as any)?.name==="AbortError")throw new MCPError("timeout","MCP request timed out",e); throw new MCPError("protocol","invalid MCP response",e)} finally{t.done();} }
  async initialize(){const result=await this.request("initialize",{protocolVersion:MCP_PROTOCOL_VERSION,capabilities:{},clientInfo:{name:"pi-swarm",version:"1"}}); await this.request("notifications/initialized",{}).catch(()=>{}); return result;}
  listResources(){return this.request("resources/list",{}).then((r:any)=>(r?.resources??[]).map((x:any)=>({...x,serverId:this.m.id})))}
  readResource(uri:string,s?:AbortSignal){return this.request("resources/read",{uri},s)}
  listPrompts(){return this.request("prompts/list",{}).then((r:any)=>(r?.prompts??[]).map((x:any)=>({...x,serverId:this.m.id})))}
  getPrompt(name:string,args:unknown,s?:AbortSignal){return this.request("prompts/get",{name,arguments:args},s)}
  async listTools(){const r=await this.request("tools/list",{}); return (r?.tools??[]).map((x:any)=>({...x,serverId:this.m.id}));} callTool(n:string,a:unknown,s?:AbortSignal){return this.request("tools/call",{name:n,arguments:a},s)} close(){return Promise.resolve();}
}
export function createClient(m:MCPManifest, closed=true): MCPClient { const errors=validateManifest(m,closed); if(errors.length) throw new MCPError("config",errors.join("; ")); return m.type === "stdio" ? new StdioClient(m) : new RemoteClient(m); }

export class MCPManager { private clients=new Map<string,MCPClient>(); private discovered=new Map<string,MCPTool[]>(); private resources=new Map<string,MCPResource[]>(); private connecting=new Map<string,Promise<MCPTool[]>>(); private registered=new Set<string>(); private epoch=0; constructor(private manifests:MCPManifest[], private opts:{closed?:boolean; registerTool?:(tool:unknown)=>void; onConnectionChange?:()=>void}={}) { for(const m of manifests){const errs=validateManifest(m,opts.closed??true); if(errs.length) throw new MCPError("config",`${m.id}: ${errs.join("; ")}`); } }
  manifestsList(){return this.manifests.map(({apiKey: _apiKey, ...m})=>({...m, headers:undefined, oauth:m.oauth?{tokenEnv:m.oauth.tokenEnv,scopes:m.oauth.scopes}:undefined}));}
  connectedServers(){return [...this.clients.keys()];}
  async discover(id:string){const m=this.manifests.find(x=>x.id===id); if(!m)throw new MCPError("config",`unknown MCP server ${id}`); const known=this.discovered.get(id); if(known)return known; const inFlight=this.connecting.get(id); if(inFlight)return inFlight; const run=this.connect(m); this.connecting.set(id,run); try { return await run; } finally { if(this.connecting.get(id)===run) this.connecting.delete(id); } }
  private async connect(m:MCPManifest):Promise<MCPTool[]>{ const id=m.id; const epoch=this.epoch; const c=createClient(m,this.opts.closed??true); const link={lost:false}; c.onDisconnect(()=>{ link.lost=true; this.invalidate(id,c); }); let tools:MCPTool[]; let resources:MCPResource[]; try { await c.initialize(); tools=allowedTools(m,await c.listTools()); resources=await c.listResources().catch(()=>[]); if(link.lost) throw new MCPError("transport",`MCP server ${id} disconnected during discovery`); if(epoch!==this.epoch) throw new MCPError("transport",`MCP discovery for ${id} cancelled by close`); } catch(e){ await c.close().catch(()=>{}); throw e; } this.clients.set(id,c); this.discovered.set(id,tools); this.resources.set(id,resources); this.registerTools(id,tools); this.opts.onConnectionChange?.(); return tools; }
  private invalidate(id:string,c:MCPClient){ if(this.clients.get(id)!==c) return; this.clients.delete(id); this.discovered.delete(id); this.resources.delete(id); this.opts.onConnectionChange?.(); void c.close().catch(()=>{}); }
  private registerTools(id:string,tools:MCPTool[]){ for(const t of tools){ const name=`mcp__${id}__${t.name}`; if(this.registered.has(name)) continue; this.registered.add(name); this.opts.registerTool?.(withDefaultToolRenderer({name,label:t.name,description:t.description??`MCP tool ${t.name}`,parameters:t.inputSchema??{type:"object"},execute:(_call:string,args:unknown,signal?:AbortSignal)=>this.call(id,t.name,args,signal)})); } }
  listResources(id?:string){return id ? (this.resources.get(id) ?? []) : [...this.resources.values()].flat();}
  private async ready(server:string):Promise<MCPClient>{ if(!this.discovered.has(server)) await this.discover(server); const c=this.clients.get(server); if(!c) throw new MCPError("transport",`MCP server ${server} is not connected`); return c; }
  async readResource(server:string,uri:string,signal?:AbortSignal){const c=await this.ready(server); if(!this.resources.get(server)?.some(r=>r.uri===uri)) throw new MCPError("denied",`resource ${uri} is not allowed`); return c.readResource(uri,signal);}
  async call(server:string,tool:string,args:unknown,signal?:AbortSignal){const c=await this.ready(server); if(!this.discovered.get(server)?.some(t=>t.name===tool))throw new MCPError("denied",`tool ${tool} is not allowed`); return c.callTool(tool,args,signal);}
  async close(){ this.epoch++; const open=[...this.clients.values()]; this.clients.clear(); this.discovered.clear(); this.resources.clear(); await Promise.all(open.map(c=>c.close())); if(open.length) this.opts.onConnectionChange?.(); }
}
export const manifestSchema={type:"object",additionalProperties:false,required:["id","type"],properties:{id:{type:"string"},type:{type:"string",enum:["stdio","http","sse"]},command:{type:"string"},args:{type:"array",items:{type:"string"}},url:{type:"string"},environment:{type:"array",items:{type:"string"}},headers:{type:"object"},tools:{type:"array",items:{type:"string"}},excludeTools:{type:"array",items:{type:"string"}},lazy:{type:"boolean"},timeoutMs:{type:"number"},oauth:{type:"object"}}};
export default function mcpExtension(pi:any){ let manager:MCPManager|undefined; pi.on?.("session_start",()=>{ const manifests=pi.mcpManifests??[]; manager=new MCPManager(manifests,{closed:pi.mcpClosedMode??true,registerTool:t=>pi.registerTool(t)}); }); pi.registerCommand?.("mcp",{description:"Discover or close declared MCP servers",handler:async(args:string)=>{if(!manager)throw new MCPError("config","MCP not initialized"); const [op,id]=args.trim().split(/\s+/,2); if(op==="discover"&&id)return manager.discover(id); if(op==="close")return manager.close(); return manager.manifestsList();}}); return manager; }
