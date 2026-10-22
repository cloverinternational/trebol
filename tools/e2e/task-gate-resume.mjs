#!/usr/bin/env node
/**
 * Actual installed Pi, loopback scripted provider, real taskmanage extension.
 * No network, no credentials, no personal settings.
 *
 * Proves the auto-continue end to end: a turn that ends right after the
 * task-enforcement gate blocks a tool is continued by the runtime instead of
 * idling, the injected instruction reaches the model, the gate still blocks,
 * and the budget stops at two continues.
 *
 * Request plan (hooks stay dormant for the first 5 turns, so warm up on an
 * exempt TaskManage call):
 *   r1..r5  TaskManage list            -> allowed, warms the hook gate up
 *   r6      bash "git commit -am probe"-> BLOCKED by task enforcement
 *   r7      plain text stop            -> the reported symptom; expect continue 1
 *   r8      bash retry                 -> BLOCKED again (a genuinely new block)
 *   r9      plain text stop            -> expect continue 2
 *   r10     plain text stop            -> budget spent, run settles
 *
 *   node tools/e2e/task-gate-resume.mjs
 */
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const repo = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const root = await realpath(await mkdtemp(join(tmpdir(), "task-gate-resume-")));
const agent = join(root, "agent");
const workspace = join(root, "workspace");
const REQUESTS = 10;
const WARMUP = 5;

/** Pi's session transcript for this throwaway HOME, so the visible notice can be checked. */
async function findSessionFile(dir) {
  const queue = [dir];
  while (queue.length) {
    const current = queue.shift();
    let entries;
    try { entries = await readdir(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) queue.push(path);
      else if (entry.name.endsWith(".jsonl")) return path;
    }
  }
  return undefined;
}

/** Per-request scripted answer; request index is 1-based. */
function answer(n) {
  const tool = (name, args) => ({ tool_calls: [{ index: 0, id: `call-${n}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
  if (n <= WARMUP) return { delta: tool("TaskManage", { operations: [{ key: "w", op: "list" }] }), finish: "tool_calls" };
  if (n === WARMUP + 1 || n === WARMUP + 3) return { delta: tool("bash", { command: "git commit -am probe" }), finish: "tool_calls" };
  return {
    delta: { content: n === WARMUP + 2
      ? "The tool call was blocked by the same enforcement hook I was fixing; I'll report the state as needs_user."
      : "Stopping here." },
    finish: "stop",
  };
}

const payloads = [];
let requests = 0;
let child;
const server = createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  requests += 1;
  payloads.push(body);
  const { delta, finish } = answer(requests);
  const base = { id: "local-proof", object: "chat.completion.chunk", created: 1, model: body.model };
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", ...delta }, finish_reason: null }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\n`);
  res.end("data: [DONE]\n\n");
});

try {
  await mkdir(agent, { recursive: true });
  await mkdir(workspace, { recursive: true });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  await writeFile(join(agent, "models.json"), JSON.stringify({
    providers: { local: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: "openai-completions", apiKey: "dummy",
      models: [{ id: "script", contextWindow: 100000, maxTokens: 2048, reasoning: false }] } },
  }));
  const executable = process.env.PI_EXECUTABLE ?? "pi";
  const args = [
    "--model", "local/script", "--no-extensions",
    "--extension", join(repo, "extensions/taskmanage/extension.ts"),
    "--no-tools", "--tools", "TaskManage,bash",
    "--no-skills", "--no-context-files", "--mode", "json", "--print", "--approve", "--",
    "Read and execute your Claw task file in full.",
  ];
  child = spawn(executable, args, {
    cwd: workspace,
    env: { ...process.env, HOME: root, PI_CODING_AGENT_DIR: agent, PI_SWARM_SUBAGENT: "0", PI_SWARM_NO_HOOKS: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", b => (stdout += b));
  child.stderr.on("data", b => (stderr += b));
  const timer = setTimeout(() => child.kill("SIGKILL"), 90_000);
  const code = await new Promise(r => child.once("exit", r));
  clearTimeout(timer);

  const events = stdout.split("\n").flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  const results = events.filter(e => e.type === "tool_execution_end");
  const bash = results.filter(r => String(r.toolName ?? "").toLowerCase() === "bash");
  const bashText = JSON.stringify(bash.at(-1)?.result ?? {});
  const text = i => JSON.stringify(payloads[i] ?? {});
  const sessionFile = await findSessionFile(root);
  const transcript = sessionFile ? await readFile(sessionFile, "utf8") : "";

  const proof = {
    code,
    requests,
    toolExecutions: results.length,
    blockedTwice: bash.length === 2 && bash.every(r => JSON.stringify(r.result ?? {}).includes("TASK ENFORCEMENT") && r.isError === true),
    continue1Delivered: text(WARMUP + 2).includes("AUTO-CONTINUE 1/2"),
    continue2Delivered: text(WARMUP + 4).includes("AUTO-CONTINUE 2/2"),
    noThirdContinue: requests === REQUESTS && !text(REQUESTS - 1).includes("AUTO-CONTINUE 3/"),
    spentNoticeSurfaced: transcript.includes("swarm-task-gate-auto-continue-spent") && transcript.includes("BUDGET SPENT"),
    sessionFile: Boolean(sessionFile),
  };
  console.log(JSON.stringify(proof, null, 2));
  if (process.env.DEBUG) for (const line of transcript.split("\n")) if (line.includes("TASK GATE") || line.includes("task-gate")) console.log("TRANSCRIPT", line.slice(0, 400));
  if (process.env.DEBUG) for (const p of payloads) console.log("---", p.messages?.at(-1)?.role, JSON.stringify(p.messages?.at(-1)?.content).slice(0, 300));
  const ok = proof.code === 0 && proof.requests === REQUESTS && proof.blockedTwice
    && proof.continue1Delivered && proof.continue2Delivered && proof.noThirdContinue && proof.spentNoticeSurfaced;
  if (!ok) {
    console.error(`FAIL task-gate resume e2e; stderr: ${stderr.slice(-800)}`);
    process.exitCode = 1;
  } else {
    console.log(`PASS actual Pi: gate block -> 2 auto-continues -> settles (${requests} provider requests, gate still enforced)`);
  }
} finally {
  if (child && child.exitCode === null) child.kill("SIGKILL");
  await new Promise(r => server.close(r));
  await rm(root, { recursive: true, force: true });
}
