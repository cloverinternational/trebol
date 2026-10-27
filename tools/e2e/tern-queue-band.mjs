#!/usr/bin/env -S node --experimental-strip-types
/** Real Pi session + Tern bridge: messages queued during a turn render as OMP's omp.queue band from Pi's own queue, Edit restores them, and the band leaves when the queue drains. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePiHost } from "../install/pi-host.mjs";
import { PiTernBridge } from "../../.pi/lib/tern/bridge.ts";

const root = mkdtempSync(join(tmpdir(), "trebol-tern-queue-"));
let session;
let requests = 0;
// A slow OpenAI-compatible stream keeps the first turn busy long enough to queue behind it.
const server = createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    requests++;
    res.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = (delta, finish = null) => `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: "script", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    setTimeout(() => res.end(chunk({ role: "assistant", content: `reply ${requests}` }) + chunk({}, "stop") + "data: [DONE]\n\n"), 1500);
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const cleanup = () => { session?.dispose(); server.close(); rmSync(root, { recursive: true, force: true }); };
const deadline = setTimeout(() => { console.error("FAIL tern queue band timed out"); cleanup(); process.exit(1); }, 60_000);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  const agentDir = join(root, "agent");
  mkdirSync(agentDir);
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "local", defaultModel: "script" }));
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { local: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: "openai-completions", apiKey: "dummy", models: [{ id: "script", contextWindow: 100000, maxTokens: 1024, reasoning: false }] } } }));
  const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } = await import(resolvePiHost({ executable: process.env.PI_EXECUTABLE }).sdkUrl);
  const settingsManager = SettingsManager.create(root, agentDir);
  const resourceLoader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager, noExtensions: true, noSkills: true, noThemes: true, noContextFiles: true, noPromptTemplates: true });
  await resourceLoader.reload();
  ({ session } = await createAgentSession({ cwd: root, agentDir, settingsManager, resourceLoader, sessionManager: SessionManager.inMemory(root) }));

  const writes = [];
  const bridge = new PiTernBridge(session, { write: (d) => writes.push(d), surfaceId: "pi", credits: 1000 });
  bridge.start("pi");
  await session.bindExtensions({ mode: "tui", uiContext: bridge.uiContext() });

  const first = bridge.submit("first");
  await wait(200);
  assert.equal(bridge.busy, true, "first turn is running");
  void bridge.submit("second\nline");
  void bridge.submit("third");
  await wait(200);
  const queued = writes.join("");
  assert.ok(queued.includes('"role":"omp.queue"'), "queue band renders in the dock");
  assert.ok(queued.includes('"text":"second ↵ line"'), "multiline queued text shows on one line");
  assert.ok(queued.includes('"role":"omp.queue.count"') && queued.includes('"text":"2"'), "first pill counts the queue");
  assert.ok(!queued.includes("Follow-up queued"), "no transcript line for queueing");

  await bridge.handle({ verb: "e", body: { ev: "action", act: "queue.edit" } });
  assert.equal(bridge.draft, "second\nline\n\nthird", "Edit restores the queued text to the composer");
  const mark = writes.length;
  await first;
  await wait(300);
  const after = writes.slice(mark).join("");
  assert.ok(!after.includes('"role":"omp.queue.item"'), "band does not reappear after restore");
  assert.equal(requests, 1, "restored messages were not also delivered");
  bridge.close();
  console.log("PASS tern queue band (real Pi queue_update, Edit restore, single delivery)");
} finally {
  clearTimeout(deadline);
  cleanup();
}
