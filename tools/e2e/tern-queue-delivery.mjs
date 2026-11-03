#!/usr/bin/env -S node --experimental-strip-types
/**
 * Real Pi session + Tern bridge: a plain Enter sent while the agent is busy must steer into the
 * next provider request after the tool boundary (not wait for the final answer), while an explicit
 * Alt+Enter follow-up stays deferred until the agent yields. Isolated settings, loopback-only
 * OpenAI-compatible scripted provider, deterministic promises instead of sleeps.
 * Run: PI_EXECUTABLE=node_modules/.bin/pi node --experimental-strip-types tools/e2e/tern-queue-delivery.mjs
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { resolvePiHost } from "../install/pi-host.mjs";
import { PiTernBridge } from "../../.pi/lib/tern/bridge.ts";

const STEER = "STEER-MARKER";
const FOLLOW = "FOLLOW-MARKER";
const MAX_REQUESTS = 6;
const root = mkdtempSync(join(tmpdir(), "trebol-tern-delivery-"));
let session;
let fixtureCalls = 0;
const requestLog = [];
let releaseFirst;
const firstHeld = new Promise((resolve) => { releaseFirst = resolve; });
let markFirstSeen;
const firstSeen = new Promise((resolve) => { markFirstSeen = resolve; });

const chunk = (delta, finish = null) =>
  `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: "script", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;

const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (b) => { raw += b; });
  req.on("end", () => {
    let body = {};
    try { body = JSON.parse(raw); } catch { /* a request Pi aborted */ }
    const n = requestLog.length;
    requestLog.push(body);
    res.writeHead(200, { "content-type": "text/event-stream" });
    const reply = (delta, finish = null) => res.write(chunk(delta, finish));
    const done = (text) => { reply({ role: "assistant", content: text }); reply({}, "stop"); res.end("data: [DONE]\n\n"); };
    (async () => {
      if (n >= MAX_REQUESTS) { done("bounded reply"); return; }
      if (n === 0) {
        // Hold the first request open until the test queued both messages, so the provider cannot
        // race ahead of the queue. The first reply calls the registered fixture no-op tool.
        markFirstSeen();
        await firstHeld;
        reply({ role: "assistant", tool_calls: [{ index: 0, id: "call-fixture", type: "function", function: { name: "fixture_noop", arguments: "{}" } }] });
        reply({}, "tool_calls");
        res.end("data: [DONE]\n\n");
        return;
      }
      if (n === 1) { done("answer one"); return; }
      if (n === 2) { done("answer two"); return; }
      done(`settled ${n}`);
    })();
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));

const cleanup = () => {
  try { session?.dispose(); } catch { /* already disposed */ }
  try { server.close(); } catch { /* already closed */ }
  rmSync(root, { recursive: true, force: true });
};
const watchdog = setTimeout(() => { console.error("FAIL tern queue delivery timed out"); cleanup(); process.exit(1); }, 60_000);
const settle = async (promise, label) => {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} did not settle`)), 20_000); }),
    ]);
  } finally { clearTimeout(timer); }
};
const textsOf = (message) => {
  const content = message?.content;
  if (typeof content === "string") return content;
  return Array.isArray(content) ? content.map((p) => p?.text ?? "").join("") : "";
};
const userTexts = (request) => (request?.messages ?? []).filter((m) => m.role === "user").map(textsOf);
const contains = (request, marker) => userTexts(request).some((t) => t.includes(marker));

const failures = [];
try {
  const agentDir = join(root, "agent");
  mkdirSync(agentDir);
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "local", defaultModel: "script" }));
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { local: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: "openai-completions", apiKey: "dummy", models: [{ id: "script", contextWindow: 100000, maxTokens: 1024, reasoning: false }] } } }));
  const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } = await import(resolvePiHost({ executable: process.env.PI_EXECUTABLE }).sdkUrl);
  const settingsManager = SettingsManager.create(root, agentDir);
  const resourceLoader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager, noExtensions: true, noSkills: true, noThemes: true, noContextFiles: true, noPromptTemplates: true });
  await resourceLoader.reload();
  const fixture = {
    name: "fixture_noop",
    label: "Fixture no-op",
    description: "Do nothing; used to force a tool boundary in the scripted provider.",
    parameters: Type.Object({}),
    execute: async () => { fixtureCalls++; return { content: [{ type: "text", text: "noop" }], details: undefined }; },
  };
  ({ session } = await createAgentSession({
    cwd: root, agentDir, settingsManager, resourceLoader,
    sessionManager: SessionManager.inMemory(root),
    customTools: [fixture], tools: ["fixture_noop"],
  }));

  const writes = [];
  const bridge = new PiTernBridge(session, { write: (d) => writes.push(d), surfaceId: "pi", credits: 1000 });
  bridge.start("pi");
  await session.bindExtensions({ mode: "tui", uiContext: bridge.uiContext() });

  const turn = bridge.submit("begin turn");
  await firstSeen;
  if (!bridge.busy) failures.push("first turn never marked the bridge busy");

  // Plain Enter during the turn, then the explicit follow-up path (Pi's Alt+Enter).
  await bridge.submit(STEER);
  await bridge.submitFollowUp(FOLLOW);

  const steeringNow = session.getSteeringMessages();
  const followNow = session.getFollowUpMessages();
  const plainWentToSteering = steeringNow.includes(STEER);
  const plainLeakedToFollowUp = followNow.includes(STEER);
  const followDeferredInQueue = followNow.includes(FOLLOW);
  if (!plainWentToSteering) failures.push(`plain submit while busy did not steer (steering=${JSON.stringify(steeringNow)}, followUp=${JSON.stringify(followNow)})`);
  if (plainLeakedToFollowUp) failures.push("plain submit while busy was queued as a follow-up");
  if (!followDeferredInQueue) failures.push("explicit follow-up was not queued as a follow-up");

  // Unblock the provider only after both submissions observed their queue.
  releaseFirst();
  const settled = await settle(turn, "first turn");
  void settled;

  const r0 = requestLog[0];
  const r1 = requestLog[1];
  const r2 = requestLog[2];
  const last = requestLog.at(-1);

  const offered = (r0?.tools ?? []).map((t) => t?.function?.name ?? t?.name);
  if (!offered.includes("fixture_noop")) failures.push(`fixture tool not offered to the provider: ${JSON.stringify(offered)}`);
  if (fixtureCalls !== 1) failures.push(`fixture tool ran ${fixtureCalls} times, expected 1`);
  if (contains(r0, STEER) || contains(r0, FOLLOW)) failures.push("queued messages appeared in the held first request");
  if (!r1) failures.push("no second provider request after the tool boundary");
  if (r1 && !contains(r1, STEER)) failures.push(`steering message missing from the post-tool request users=${JSON.stringify(userTexts(r1))}`);
  if (r1 && contains(r1, FOLLOW)) failures.push("explicit follow-up was delivered before the agent yielded");
  if (r2 && !contains(r2, FOLLOW)) failures.push(`explicit follow-up missing from the request after the final answer users=${JSON.stringify(userTexts(r2))}`);
  if (requestLog.length > MAX_REQUESTS) failures.push(`provider loop was not bounded (${requestLog.length} requests)`);
  const finalFollowCount = last ? userTexts(last).filter((t) => t.includes(FOLLOW)).length : 0;
  const finalSteerCount = last ? userTexts(last).filter((t) => t.includes(STEER)).length : 0;
  if (finalFollowCount !== 1) failures.push(`follow-up persisted ${finalFollowCount} user messages in the final request, expected 1`);
  if (finalSteerCount !== 1) failures.push(`steering persisted ${finalSteerCount} user messages in the final request, expected 1`);
  if (session.pendingMessageCount !== 0) failures.push(`queue not empty at finish: steering=${JSON.stringify(session.getSteeringMessages())} followUp=${JSON.stringify(session.getFollowUpMessages())}`);

  const branch = session.sessionManager?.getBranch?.() ?? [];
  const persistedUser = branch
    .filter((e) => e?.type === "message" && e?.message?.role === "user")
    .map((e) => textsOf(e.message));
  const followEntries = persistedUser.filter((t) => t.includes(FOLLOW)).length;
  const steerEntries = persistedUser.filter((t) => t.includes(STEER)).length;
  if (followEntries !== 1) failures.push(`follow-up persisted ${followEntries} user transcript entries, expected 1`);
  if (steerEntries !== 1) failures.push(`steering persisted ${steerEntries} user transcript entries, expected 1`);
  if (bridge.busy) failures.push("bridge still busy after the turn settled");

  if (failures.length) {
    console.error(`FAIL tern queue delivery:\n- ${failures.join("\n- ")}`);
    console.error(`requests=${requestLog.length} users per request=${JSON.stringify(requestLog.map((r) => userTexts(r).map((t) => t.slice(0, 40))))}`);
    process.exitCode = 1;
  } else {
    console.log(`PASS tern queue delivery (${requestLog.length} bounded provider requests: steer after tool boundary, follow-up after final answer, queue drained, transcript persisted)`);
  }
  bridge.close();
} finally {
  clearTimeout(watchdog);
  cleanup();
}
