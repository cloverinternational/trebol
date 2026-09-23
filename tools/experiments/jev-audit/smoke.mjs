#!/usr/bin/env node
/* Live Pi smoke: temporary HOME/foreign workspace, local provider, and a
 * preload-only Jev mock. No install, host config, or production endpoint use. */
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const checkout = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const here = resolve(fileURLToPath(new URL(".", import.meta.url)));
const root = await mkdtemp(join(tmpdir(), "jev-audit-smoke-"));
const home = join(root, "home"), agent = join(home, ".pi", "agent"), workspace = join(root, "foreign");
const jevLog = join(root, "jev.ndjson");
const requests = []; const stopOnly = process.env.JEV_SMOKE_STOP_ONLY === "1";
const readBody = req => new Promise((ok, bad) => { let s = ""; req.on("data", c => s += c); req.on("end", () => ok(s)); req.on("error", bad); });
const sse = (res, body, chunks) => { res.writeHead(200, { "content-type": "text/event-stream", connection: "close" }); const emit = value => res.write(`data: ${JSON.stringify({ id: "smoke", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta: value, finish_reason: null }] })}\n\n`); for (const c of chunks) emit(c); res.write(`data: ${JSON.stringify({ id: "smoke", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: chunks.some(c => c.tool_calls) ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`); res.end(); };
try {
  await mkdir(agent, { recursive: true }); await mkdir(join(workspace, ".git"), { recursive: true });
  const provider = createServer(async (req, res) => { const body = JSON.parse(await readBody(req)); requests.push(body); const n = (body.messages ?? []).filter(m => m.role === "tool").length; if (n >= (stopOnly ? 1 : 6)) return sse(res, body, [{ role: "assistant", content: "SMOKE_DONE" }]); return sse(res, body, [{ role: "assistant", content: `turn-${n + 1}` }, { role: "assistant", tool_calls: [{ index: 0, id: `smoke-${n + 1}`, type: "function", function: { name: "bash", arguments: JSON.stringify({ command: `printf smoke-${n + 1}` }) } }] }]); });
  await new Promise((ok, bad) => { provider.once("error", bad); provider.listen(0, "127.0.0.1", ok); });
  const port = provider.address().port;
  const preload = join(root, "preload.mjs");
  await writeFile(preload, `const f=globalThis.fetch; globalThis.fetch=async (u,o)=>{if(String(u)!=="https://api.typesafe.ai/v1/systemone")return f(u,o);const b=JSON.parse(o.body),e=b.state.excerpts,p={memory:0,procedure:0,mixed:0,temporary:0,unresolved:1,noise:0};await import("node:fs").then(m=>m.appendFileSync(${JSON.stringify(jevLog)},JSON.stringify({url:String(u),body:b})+"\\n"));return new Response(JSON.stringify({answers:Object.fromEntries(e.map((_,i)=>["e"+i,{type:"choice",choice:"unresolved",confidence:1,probabilities:p}]))}),{status:200,headers:{"content-type":"application/json"}})};`);
  const mockExtension=join(root,"mock-jev.ts");
  await writeFile(mockExtension, `import { readFileSync } from "node:fs"; export default function(pi:any){pi.on("session_start",async()=>{ await import(${JSON.stringify(preload)}+"?late=1"); });}`);
  await writeFile(join(agent, "settings.json"), JSON.stringify({ packages: [checkout] })); await writeFile(join(agent, "models.json"), JSON.stringify({ providers: { smoke: { baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions", apiKey: "dummy", models: [{ id: "smoke-model", name: "smoke", reasoning: false, contextWindow: 100000, maxTokens: 2048 }] } } }));
  const live = process.env.JEV_SMOKE_LIVE === "1";
  const args = [...(live ? [] : ["--extension", mockExtension]), "--provider", "smoke", "--model", "smoke-model", "--no-session", "--mode", "json", "--print", "--approve", "--tools", "bash", "Run six scripted tool turns."];
  const child = spawn("pi", args, { cwd: workspace, env: { ...process.env, HOME: home, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", PI_SWARM_NO_HOOKS: "1", PI_SWARM_SUBAGENT: "0", PI_SWARM_JEV_AUDIT: "on", PI_SWARM_MEMORY_CAPTURE: "off", TYPESAFE_API_KEY: live ? process.env.TYPESAFE_API_KEY : "dummy", NODE_OPTIONS: live ? "" : `--import ${preload}` }, stdio: ["ignore", "pipe", "pipe"] }); const out = [], err = []; child.stdout.on("data", c => out.push(c)); child.stderr.on("data", c => err.push(c));
  const exit = await new Promise((ok, bad) => { const t = setTimeout(() => { child.kill("SIGKILL"); bad(new Error("Pi smoke exceeded 90 seconds")); }, 90000); child.once("error", bad); child.once("exit", (code, signal) => { clearTimeout(t); ok({ code, signal }); }); }); await new Promise(ok => provider.close(ok));
  const stdout = Buffer.concat(out).toString(), stderr = Buffer.concat(err).toString(); await writeFile(join(here,"smoke-stdout.jsonl"),stdout); const toolCalls = new Set(requests.flatMap(r => (r.messages ?? []).flatMap(m => m.tool_calls ?? [])).map(c => c.id)).size; const reviewRequests = requests.filter(r => JSON.stringify(r).includes("[Jev first-finder: UNTRUSTED review proposals")); const jevCalls = await import("node:fs/promises").then(m => m.readFile(jevLog, "utf8").catch(() => "")).then(s => s.split("\n").filter(Boolean).length);
  const auditStates=stdout.split("\n").flatMap(l=>{try{const x=JSON.parse(l);return x.entry?.customType==="pi-swarm-jev-audit"?[x.entry.data]:[];}catch{return[];}});
  const stopReviewPending=auditStates.some(s=>s.turns<5&&s.pending?.content?.includes("Jev first-finder"));
  const proof = { stopOnly, stopReviewPending, mode: live ? "live-jev" : "mock-jev", command: `PI_SWARM_JEV_AUDIT=on PI_SWARM_MEMORY_CAPTURE=off pi ${args.join(" ")}`, exit, providerRequests: requests.length, toolCalls, jevMockCalls: jevCalls, reviewRequests: reviewRequests.length, reviewInOutgoingProviderContext: reviewRequests.length > 0, noExtraAutonomousTurn: toolCalls === (stopOnly ? 1 : 6) && stdout.split("\n").filter(l => { try { return JSON.parse(l).type === "agent_start"; } catch { return false; } }).length === 1, legacyCaptureDisabled: !stdout.includes("pi-swarm-knowledge-enrichment") && !stderr.includes("pi-swarm-knowledge-enrichment"), stdoutTail: stdout.slice(-1200), stderrTail: stderr.slice(-1200) }; await writeFile(join(here, "smoke-result.json"), JSON.stringify(proof, null, 2)); console.log(JSON.stringify(proof, null, 2)); if (!(stopOnly ? stopReviewPending : proof.reviewInOutgoingProviderContext) || !proof.noExtraAutonomousTurn || !proof.legacyCaptureDisabled) process.exitCode = 1;
} finally { await rm(root, { recursive: true, force: true }); }
