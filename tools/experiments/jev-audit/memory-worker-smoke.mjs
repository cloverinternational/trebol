#!/usr/bin/env node
/* Live, local-only proof of fork -> evidence review -> verified write -> query. */
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const checkout = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const worker = join(checkout, ".pi/lib/state/memory-maintenance-worker.ts");
const root = await mkdtemp(join(tmpdir(), "memory-worker-smoke-"));
const workspace = join(root, "workspace"), home = join(root, "home"), agent = join(home, ".pi", "agent");
const memory = join(root, "memory"), sessionDir = join(root, "sessions");
const snapshot = join(sessionDir, "snapshot.jsonl"), receipt = join(sessionDir, "receipt.jsonl"), lease = join(sessionDir, "active");
const requests = [], childOut = [], childErr = [];
const fact = "Project Orion uses PostgreSQL.";
const readBody = req => new Promise((ok, bad) => { let s = ""; req.on("data", c => s += c); req.on("end", () => ok(s)); req.on("error", bad); });
const toolCalls = body => (body.messages ?? []).flatMap(m => m.tool_calls ?? []);
const sse = (res, body, message) => {
  res.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
  const id = `memory-smoke-${requests.length}`;
  const delta = message.tool_calls ? { role: "assistant", tool_calls: message.tool_calls } : { role: "assistant", content: message.content };
  res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: message.tool_calls ? "tool_calls" : null }] })}\n\n`);
  if (!message.tool_calls) res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
  res.write("data: [DONE]\n\n"); res.end();
};
const call = (name, args) => [{ index: 0, id: `call-${requests.length}`, type: "function", function: { name, arguments: JSON.stringify(args) } }];
let provider;
try {
  await mkdir(agent, { recursive: true }); await mkdir(workspace, { recursive: true }); await mkdir(sessionDir, { recursive: true });
  await writeFile(snapshot, [
    JSON.stringify({ type: "session", version: 3, id: "parent-session", timestamp: new Date().toISOString(), cwd: workspace }),
    JSON.stringify({ type: "message", id: "fact-1", parentId: null, message: { role: "user", content: fact } }), "\n"
  ].join("\n"));
  await writeFile(lease, "active", { mode: 0o600 });
  provider = createServer(async (req, res) => {
    const body = JSON.parse(await readBody(req)); requests.push(body);
    const n = (body.messages ?? []).filter(m => m.role === "tool").length;
    if (n === 0) return sse(res, body, { tool_calls: call("memory_history", { operation: "search", scope: "repository", query: "Orion PostgreSQL", limit: 20 }) });
    if (n === 1) return sse(res, body, { tool_calls: call("memory_evidence", { ids: ["fact-1"] }) });
    if (n === 2) return sse(res, body, { tool_calls: call("memory_history", { operation: "remember", scope: "repository", text: fact, status: "verified", kind: "fact", tags: ["orion", "database"], evidence: [{ ref: "snapshot:fact-1", quote: fact }] }) });
    if (n === 3) return sse(res, body, { tool_calls: call("memory_history", { operation: "search", scope: "repository", query: "Project Orion uses PostgreSQL", status: "verified", limit: 20 }) });
    return sse(res, body, { content: "MEMORY_WORKER_SMOKE_DONE" });
  });
  await new Promise((ok, bad) => { provider.once("error", bad); provider.listen(0, "127.0.0.1", ok); });
  const port = provider.address().port;
  await writeFile(join(agent, "models.json"), JSON.stringify({ providers: { smoke: { baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions", apiKey: "local-only", models: [{ id: "smoke-model", name: "smoke", reasoning: false, contextWindow: 100000, maxTokens: 4096 }] } } }));
  await writeFile(join(agent, "settings.json"), JSON.stringify({ packages: [checkout] }));
  const args = ["--provider", "smoke", "--model", "smoke-model", "--fork", snapshot, "--session-dir", sessionDir, "--no-extensions", "--extension", worker, "--no-tools", "--tools", "memory_evidence,memory_history,supervisor_review,supervisor_task_proposal", "--no-context-files", "--no-skills", "--mode", "json", "--print", "--approve", "--", "Review the inherited fact. Search, read its evidence, save it as verified with the matching quote, then search for the verified record and finish."];
  const child = spawn("pi", args, { cwd: workspace, env: { ...process.env, HOME: home, PI_CODING_AGENT_DIR: agent, PI_SWARM_MEMORY_WORKER: "1", PI_SWARM_SUBAGENT: "1", PI_SWARM_MEMORY_SNAPSHOT: snapshot, PI_SWARM_MEMORY_RECEIPT: receipt, PI_SWARM_MEMORY_LEASE: lease, PI_SWARM_MEMORY_DIR: memory, PI_SWARM_MEMORY_WORKER_TURNS: "6", PI_OFFLINE: "1" }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", c => childOut.push(c)); child.stderr.on("data", c => childErr.push(c));
  const exit = await new Promise((ok, bad) => { const timer = setTimeout(() => { child.kill("SIGKILL"); bad(new Error("memory worker smoke exceeded strict 90 seconds")); }, 90000); child.once("error", bad); child.once("exit", (code, signal) => { clearTimeout(timer); ok({ code, signal }); }); });
  const stdout = Buffer.concat(childOut).toString(), stderr = Buffer.concat(childErr).toString();
  const receiptText = await readFile(receipt, "utf8").catch(() => "");
  const receiptRows = receiptText.split("\n").filter(Boolean).map(JSON.parse);
  const finalSearch = requests.flatMap(r => r.messages ?? []).filter(m => m.role === "tool").at(-1)?.content ?? "";
  const outgoingTools = [...new Set(requests.flatMap(r => [ ...(r.tools ?? []).map(t => t.function?.name ?? t.name), ...toolCalls(r).map(c => c.function?.name) ]).filter(Boolean))];
  const childIds = stdout.split("\n").filter(Boolean).flatMap(line => { try { const x = JSON.parse(line); return [x.session?.id, x.sessionId, x.id].filter(Boolean); } catch { return []; } });
  const proof = { exit, providerRequests: requests.length, outgoingTools, allowlistExact: JSON.stringify(outgoingTools.sort()) === JSON.stringify(["memory_evidence", "memory_history", "supervisor_review", "supervisor_task_proposal"]), noBash: !outgoingTools.includes("Bash") && !outgoingTools.includes("bash"), receiptJsonl: receiptRows, receiptSuccessfulWrite: receiptRows.some(x => x.operation === "remember" && x.outcome === "ok"), finalSearchContainsVerifiedFact: finalSearch.includes(fact) && finalSearch.includes('"status":"verified"'), forkChildDifferentSession: childIds.length > 0 && !childIds.includes("parent-session"), parentSnapshotUnchanged: (await readFile(snapshot, "utf8")).includes('"id":"parent-session"'), stdoutTail: stdout.slice(-1200), stderrTail: stderr.slice(-1200) };
  console.log(JSON.stringify(proof, null, 2));
  if (exit.code !== 0 || !proof.allowlistExact || !proof.noBash || !proof.receiptSuccessfulWrite || !proof.finalSearchContainsVerifiedFact || !proof.forkChildDifferentSession || !proof.parentSnapshotUnchanged) process.exitCode = 1;
} finally { if (provider) await new Promise(ok => provider.close(ok)); await rm(root, { recursive: true, force: true }); }
