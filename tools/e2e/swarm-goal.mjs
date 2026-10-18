#!/usr/bin/env node
/** Real Pi session and loopback scripted provider; covers /goal evaluator failure, completion paths, and judge MET. */
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePiHost } from "../install/pi-host.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const JUDGE_MARK = "transcript has";

function reply(res, plan) {
  if (plan.status) {
    res.writeHead(plan.status, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: plan.error } }));
    return;
  }
  const base = { id: "local", object: "chat.completion.chunk", created: 1, model: "script" };
  const frames = plan.toolCall
    ? [[{ role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: plan.toolCall, arguments: "{}" } }] }, null], [{}, "tool_calls"]]
    : [[{ role: "assistant", content: plan.text }, null], [{}, "stop"]];
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const [delta, finish_reason] of frames) res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  res.end("data: [DONE]\n\n");
}

async function startSession(plan) {
  const root = mkdtempSync(join(tmpdir(), "trebol-goal-"));
  const seen = { judge: 0, main: 0 };
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    if (JSON.stringify(body.messages).includes(JUDGE_MARK)) {
      seen.judge++;
      const replies = Array.isArray(plan.evaluator) ? plan.evaluator : [plan.evaluator];
      return reply(res, replies[Math.min(seen.judge, replies.length) - 1]);
    }
    seen.main++;
    return reply(res, body.messages.some(m => m.role === "tool") ? { text: "Done." } : plan.main);
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  execFileSync("git", ["init", "-q", root]);
  const agentDir = join(root, "agent"); mkdirSync(agentDir);
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "local", defaultModel: "script" }));
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { local: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: "openai-completions", apiKey: "dummy", models: [{ id: "script", contextWindow: 100000, maxTokens: 1024, reasoning: false }] } } }));
  const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } = await import(resolvePiHost({ executable: process.env.PI_EXECUTABLE }).sdkUrl);
  const settingsManager = SettingsManager.create(root, agentDir);
  const resourceLoader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager, noExtensions: true, noSkills: true, noThemes: true, noContextFiles: true, noPromptTemplates: true, additionalExtensionPaths: [join(repo, "extensions/swarm-goal/index.ts")] });
  await resourceLoader.reload(); assert.deepEqual(resourceLoader.getExtensions().errors, []);
  const { session } = await createAgentSession({ cwd: root, agentDir, settingsManager, resourceLoader, sessionManager: SessionManager.inMemory(root) });
  const notices = [];
  const ui = new Proxy({ notify: message => notices.push(String(message)) }, { get: (target, key) => (key in target ? target[key] : () => undefined) });
  const errors = [];
  await session.bindExtensions({ mode: "tui", uiContext: ui, onError: e => errors.push(e) });
  const goalState = () => session.sessionManager.getBranch().filter(e => e.customType === "pi-swarm-goal").at(-1)?.data;
  // A goal turn is dispatched asynchronously by the extension; wait for it and the judge to settle.
  const run = async text => { await session.prompt(text); await session.waitForIdle(); await new Promise(r => setTimeout(r, 100)); await session.waitForIdle(); };
  const close = async () => { session.dispose(); await new Promise(r => server.close(r)); rmSync(root, { recursive: true, force: true }); };
  return { session, notices, errors, seen, goalState, run, close };
}

const scenarios = [
  ["evaluator provider failure surfaces its real message and marks the goal error", {
    main: { text: "Working." }, evaluator: { status: 401, error: "invalid api key" },
    async run(s) {
      await s.run("/goal Ship the feature");
      assert.ok(s.seen.judge >= 1, `judge was called (main=${s.seen.main})`);
      assert.equal(s.goalState().status, "error");
      assert.ok(s.notices.some(n => n.includes("Goal evaluation stopped") && n.includes("invalid api key")), `notices: ${s.notices}`);
    },
  }],
  ["model completes the goal through goal_complete; judge is skipped", {
    main: { toolCall: "goal_complete" }, evaluator: { text: "NOT_MET" },
    async run(s) {
      await s.run("/goal Ship the feature");
      assert.equal(s.goalState().status, "met", `main=${s.seen.main} judge=${s.seen.judge} notices=${s.notices}`);
      assert.equal(s.seen.judge, 0, "judge not called after completion");
      assert.ok(s.notices.some(n => n.includes("Goal met: Ship the feature")), `notices: ${s.notices}`);
    },
  }],
  ["manual /goal complete ends an active goal without judging", {
    main: { status: 400, error: "bad request" }, evaluator: { text: "NOT_MET" },
    async run(s) {
      await s.run("/goal Ship the feature");
      assert.equal(s.goalState().status, "active", "failed turn leaves goal active and unjudged");
      assert.equal(s.seen.judge, 0);
      await s.run("/goal complete");
      assert.equal(s.goalState().status, "met");
      assert.equal(s.seen.judge, 0);
      assert.ok(s.notices.some(n => n.includes("Goal met: Ship the feature")), `notices: ${s.notices}`);
    },
  }],
  ["judge explains in prose, then answers with the bare verdict", {
    main: { text: "Working." }, evaluator: [{ text: "The file was never created." }, { text: "IMPOSSIBLE" }],
    async run(s) {
      await s.run("/goal Ship the feature");
      assert.equal(s.seen.judge, 2, `judge asked again after prose (main=${s.seen.main})`);
      assert.equal(s.goalState().status, "impossible", `notices: ${s.notices}`);
      assert.ok(!s.notices.some(n => n.includes("evaluation stopped")), `notices: ${s.notices}`);
    },
  }],
  ["judge MET still completes the goal (near-miss regression)", {
    main: { text: "Working." }, evaluator: { text: "MET" },
    async run(s) {
      await s.run("/goal Ship the feature");
      assert.ok(s.seen.judge >= 1, `judge was called (main=${s.seen.main})`);
      assert.equal(s.goalState().status, "met");
    },
  }],
];

const deadline = setTimeout(() => { console.error("FAIL swarm-goal e2e timed out"); process.exit(1); }, 120_000);
let failed = 0;
try {
  for (const [name, { main, evaluator, run }] of scenarios) {
    const s = await startSession({ main, evaluator });
    try {
      await run(s);
      assert.deepEqual(s.errors, []);
      console.log(`PASS ${name}`);
    } catch (error) {
      failed++; console.error(`FAIL ${name}: ${error.message}`);
    } finally { await s.close(); }
  }
} finally { clearTimeout(deadline); }
if (failed) process.exit(1);
console.log(`PASS all ${scenarios.length} swarm-goal e2e scenarios`);
