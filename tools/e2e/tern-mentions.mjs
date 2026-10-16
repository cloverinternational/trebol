#!/usr/bin/env -S node --experimental-strip-types
/** Real Pi session + Tern bridge + loopback scripted provider: an @mention reaches the model, and escapes do not. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePiHost } from "../install/pi-host.mjs";
import { PiTernBridge } from "../../.pi/lib/tern/bridge.ts";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const root = mkdtempSync(join(tmpdir(), "trebol-tern-mentions-"));
const outside = mkdtempSync(join(tmpdir(), "trebol-tern-outside-"));
const requests = [];
let session;
const server = createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  requests.push(raw);
  const base = { id: "local-mentions", object: "chat.completion.chunk", created: 1, model: body.model };
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const [delta, finish_reason] of [[{ role: "assistant", content: "ok" }, null], [{}, "stop"]]) {
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  }
  res.end("data: [DONE]\n\n");
});
const cleanup = () => { session?.dispose(); server.closeAllConnections(); server.close(); rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); };
const deadline = setTimeout(() => { console.error("FAIL tern mentions timed out"); cleanup(); process.exit(1); }, 60_000);

try {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  mkdirSync(join(root, "docs"));
  writeFileSync(join(root, "notes.txt"), "ALPHA_NOTE_CONTENT\n");
  writeFileSync(join(root, "docs", "my plan.md"), "BETA_PLAN_CONTENT\n");
  writeFileSync(join(outside, "secret.txt"), "OUTSIDE_SECRET_CONTENT\n");
  symlinkSync(join(outside, "secret.txt"), join(root, "link.txt"));
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
  const escape = `../${outside.split("/").pop()}/secret.txt`;
  await bridge.submit(`Compare @notes.txt with @"docs/my plan.md", @${escape} and @link.txt`);
  await new Promise((r) => setTimeout(r, 300));

  assert.equal(requests.length, 1, "exactly one provider request");
  const sent = requests[0];
  assert.ok(sent.includes("ALPHA_NOTE_CONTENT"), "bare @notes.txt content reaches the model");
  assert.ok(sent.includes("BETA_PLAN_CONTENT"), "quoted @\"docs/my plan.md\" content reaches the model");
  assert.ok(!sent.includes("OUTSIDE_SECRET_CONTENT"), "a path escaping the workspace is never read");
  assert.ok(writes.join("").includes("outside the workspace"), "the user is told the escape was not attached");

  // Keystroke path: typing @notes opens the picker; Enter completes it; a second Enter sends.
  for (const ch of "@notes") bridge.appendDraft(ch);
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(writes.join("").includes("omp.autocomplete"), "typing @ opens the mention picker");
  bridge.submitDraft();
  assert.equal(bridge.draft, "@notes.txt ", "Enter applies the picker selection without sending");
  assert.equal(requests.length, 1, "applying a completion does not send");
  bridge.submitDraft();
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(requests.length, 2, "second Enter sends the prompt");
  assert.ok(requests[1].includes("ALPHA_NOTE_CONTENT"), "a picker-selected @notes.txt reaches the model");
  console.log("PASS tern @mentions: attached files reach the provider; escape blocked");
} catch (error) {
  console.error(`FAIL ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  cleanup();
}
