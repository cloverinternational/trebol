#!/usr/bin/env node
/**
 * Raw evidence for the cache-break report. Writes JSON only, no charts.
 *   node tools/cache-report/probe.mjs ab        A/B: git status on vs off, same repo change between prompts
 *   node tools/cache-report/probe.mjs upstream  N append-only calls straight to clover-plexus, raw usage saved
 *   node tools/cache-report/probe.mjs realistic Multi-prompt RPC session in a scratch copy-free worktree of THIS repo: tools, hooks, file edits
 * Output: artifacts/cache-report/raw/*.json
 */
import { spawn, execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

const OUT = join(process.cwd(), "artifacts/cache-report/raw");
mkdirSync(OUT, { recursive: true });
const MODEL = "clover-plexus/deepseek-flash-latest";

function sessionDirFor(cwd) { return join(homedir(), ".pi/agent/sessions", `--${cwd.replace(/^\//, "").replace(/\//g, "-")}--`); }

function rpcSession(cwd) {
  const p = spawn("pi", ["--mode", "rpc", "--model", MODEL], { cwd, stdio: ["pipe", "pipe", "ignore"] });
  let buf = "", done;
  p.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); try { if (JSON.parse(l).type === "agent_end") done?.(); } catch {} } });
  const send = (m) => new Promise((r) => { done = r; p.stdin.write(JSON.stringify({ type: "prompt", message: m }) + "\n"); });
  return { send, close: () => p.kill() };
}

function readCalls(cwd) {
  const dir = sessionDirFor(cwd);
  const file = join(dir, readdirSync(dir).sort().at(-1));
  const rows = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const calls = [];
  let pending, prompt = 0, before = [];
  for (const r of rows) {
    if (r.type === "message" && r.message?.role === "user") prompt++;
    if (r.customType === "pi-swarm-cache-telemetry") pending = r.data.prefixBreak ?? null;
    else if (r.type === "custom_message") before.push(r.customType);
    else if (r.type === "message" && r.message?.role === "toolResult") before.push("tool:" + r.message.toolName);
    const m = r.message;
    if (r.type === "message" && m?.role === "assistant" && m.usage) { calls.push({ prompt, input: m.usage.input, cacheRead: m.usage.cacheRead, prefixBreak: pending, before }); before = []; }
  }
  return { sessionFile: file, calls };
}

async function runArm(name, gitStatusEnabled) {
  const repo = mkdtempSync(join(tmpdir(), `cache-ab-${name}-`));
  execSync("git init -q && echo base > a.txt", { cwd: repo });
  mkdirSync(join(repo, ".pi/config"), { recursive: true });
  writeFileSync(join(repo, ".pi/config/prompt-context.json"), JSON.stringify({ version: 1, prompts: [], context: { enabledSources: { git_status: gitStatusEnabled } } }));
  const { send, close } = rpcSession(repo);
  const steps = ["one", "two", "CHANGE", "three", "four"];
  for (const s of steps) {
    if (s === "CHANGE") { writeFileSync(join(repo, "changed.txt"), "x"); continue; }
    await send(`Reply with just: ${s}`);
  }
  close();
  return { arm: name, gitStatusEnabled, repo, changeBeforeCall: 3, ...readCalls(repo) };
}

/** A git worktree of this repo, so every trebol extension and hook is live, with real tool use and edits. */
async function realistic() {
  const wt = mkdtempSync(join(tmpdir(), "cache-real-"));
  execSync(`git worktree add -q --detach ${wt} HEAD`, { cwd: process.cwd() });
  // The fix is uncommitted: carry the working-tree diff into the worktree.
  execSync(`git diff HEAD | git -C ${wt} apply --allow-empty`, { cwd: process.cwd(), shell: process.env.SHELL || "bash" });
  for (const f of execSync("git ls-files --others --exclude-standard", { cwd: process.cwd(), encoding: "utf8" }).split("\n").filter(Boolean)) execSync(`mkdir -p "$(dirname ${wt}/${f})" && cp "${f}" "${wt}/${f}"`, { cwd: process.cwd(), shell: process.env.SHELL || "bash" });
  const { send, close } = rpcSession(wt);
  const prompts = [
    "Create a task with TaskManage titled 'probe' with one question id q text 'done?', set it in_progress. Then read package.json's name field with the read tool or rg. Reply briefly.",
    "Create the file probe-a.txt containing 'alpha' using apply_patch. Reply briefly.",
    "Run `git status --short` and tell me how many lines it printed.",
    "Append a line 'beta' to probe-a.txt with apply_patch, then show its contents.",
    "Mark the probe task completed: answer q with 'yes', evidence probe-a.txt. Reply briefly.",
    "Reply with just: done",
  ];
  for (const m of prompts) await send(m);
  close();
  const out = { worktree: wt, ...readCalls(wt) };
  execSync(`git worktree remove --force ${wt}`, { cwd: process.cwd() });
  return out;
}

async function upstream(n) {
  const prov = JSON.parse(readFileSync(join(homedir(), ".pi/agent/models.json"), "utf8")).providers["clover-plexus"];
  const key = execSync(prov.apiKey.slice(1), { encoding: "utf8", shell: process.env.SHELL || "bash" }).trim();
  const sys = `Probe ${Date.now()} ` + Array.from({ length: 4000 }, (_, i) => `Rule ${i}: keep answers short.`).join(" ");
  const msgs = [{ role: "system", content: sys }];
  const calls = [];
  for (let k = 0; k < n; k++) {
    msgs.push({ role: "user", content: `turn ${k} say ok` });
    const res = await fetch(prov.baseUrl + "/chat/completions", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: JSON.stringify({ model: "deepseek-flash-latest", max_tokens: 3, messages: msgs }) });
    const body = await res.json();
    msgs.push({ role: "assistant", content: body.choices?.[0]?.message?.content ?? "ok" });
    calls.push({ k, at: new Date().toISOString(), slot: res.headers.get("x-plexus-slot"), usage: body.usage });
  }
  return { model: "deepseek-flash-latest", appendOnly: true, calls };
}

const mode = process.argv[2];
if (mode === "ab") {
  const on = await runArm("gitstatus-on", true), off = await runArm("gitstatus-off", false);
  writeFileSync(join(OUT, "ab.json"), JSON.stringify({ on, off }, null, 2));
  console.log("wrote ab.json");
} else if (mode === "upstream") {
  const n = Number(process.argv[3] ?? 60);
  writeFileSync(join(OUT, "upstream.json"), JSON.stringify(await upstream(n), null, 2));
  console.log("wrote upstream.json");
} else if (mode === "realistic") {
  writeFileSync(join(OUT, "realistic.json"), JSON.stringify(await realistic(), null, 2));
  console.log("wrote realistic.json");
} else { console.error("usage: probe.mjs ab|upstream [n]|realistic"); process.exit(2); }
