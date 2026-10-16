#!/usr/bin/env -S node --experimental-strip-types
/** Real Pi session + Tern bridge: raw key bytes drive caret, selection, word delete and undo; the sent prompt is checked. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePiHost } from "../install/pi-host.mjs";
import { PiTernBridge } from "../../.pi/lib/tern/bridge.ts";
import { keyEffect } from "../../.pi/lib/tern/keys.ts";

const root = mkdtempSync(join(tmpdir(), "trebol-tern-draft-"));
const requests = [];
let session;
const server = createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  requests.push(raw);
  const base = { id: "draft", object: "chat.completion.chunk", created: 1, model: "script" };
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const [delta, finish_reason] of [[{ role: "assistant", content: "ok" }, null], [{}, "stop"]]) {
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  }
  res.end("data: [DONE]\n\n");
});
const cleanup = () => { session?.dispose(); server.closeAllConnections(); server.close(); rmSync(root, { recursive: true, force: true }); };
const deadline = setTimeout(() => { console.error("FAIL tern draft editing timed out"); cleanup(); process.exit(1); }, 60_000);

// Same mapping run.ts applies to each key effect; the editing effects go to the bridge.
function press(bridge, bytes) {
  const effect = keyEffect(bytes);
  assert.ok(effect, `key ${JSON.stringify(bytes)} maps to an effect`);
  if (effect.kind === "text") bridge.appendDraft(effect.text);
  else if (effect.kind === "backspace") bridge.backspaceDraft();
  else if (effect.kind === "tabMove") bridge.moveTabOrCursor(effect.delta);
  else if (effect.kind === "cursor") bridge.moveCursor(effect.direction, effect.word, effect.extend);
  else if (effect.kind === "selectAll") bridge.selectAllDraft();
  else if (effect.kind === "undo") bridge.undoDraft();
  else if (effect.kind === "deleteWord") bridge.deleteWordDraft();
  else if (effect.kind === "submit") return bridge.submitDraft();
  else throw new Error(`unexpected effect ${effect.kind}`);
  return undefined;
}

try {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const agentDir = join(root, "agent");
  mkdirSync(agentDir);
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "local", defaultModel: "script" }));
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { local: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: "openai-completions", apiKey: "dummy", models: [{ id: "script", contextWindow: 100000, maxTokens: 1024, reasoning: false }] } } }));
  const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } = await import(resolvePiHost({ executable: process.env.PI_EXECUTABLE }).sdkUrl);
  const settingsManager = SettingsManager.create(root, agentDir);
  const resourceLoader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager, noExtensions: true, noSkills: true, noThemes: true, noContextFiles: true, noPromptTemplates: true });
  await resourceLoader.reload();
  ({ session } = await createAgentSession({ cwd: root, agentDir, settingsManager, resourceLoader, sessionManager: SessionManager.inMemory(root) }));
  const bridge = new PiTernBridge(session, { write: () => {}, surfaceId: "pi", credits: 1000 });
  bridge.start("pi");

  for (const ch of "hello big world") press(bridge, ch);
  press(bridge, "\x1b\x7f"); // alt+backspace
  assert.equal(bridge.draft, "hello big ", "alt+backspace deletes the word before the caret");
  press(bridge, "\x1b\x7f");
  assert.equal(bridge.draft, "hello ", "a second alt+backspace deletes the next word");
  press(bridge, "\x1b[1;3D"); // alt+left: start of previous word
  press(bridge, "\x1b[1;3D");
  press(bridge, "X");
  assert.equal(bridge.draft, "Xhello ", "alt+left moves the caret by word and typing inserts there");
  press(bridge, "\x01"); // ctrl+a
  press(bridge, "Y");
  assert.equal(bridge.draft, "Y", "ctrl+a selects all and typing replaces it");
  press(bridge, "\x1a"); // ctrl+z
  assert.equal(bridge.draft, "Xhello ", "ctrl+z restores the text before the replacement");
  press(bridge, "\x1b[1;2D"); // shift+left extends the selection one character
  press(bridge, "\x7f"); // backspace deletes the selection
  assert.equal(bridge.draft, "Xhello", "shift+left selects, backspace removes it");

  press(bridge, "\x1b[D"); // plain left: caret without deleting
  press(bridge, "\x1b[D");
  press(bridge, "!");
  assert.equal(bridge.draft, "Xhel!lo", "plain left moves the caret for insertion");
  await press(bridge, "\r");
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(requests.length, 1, "Enter sends the edited draft");
  assert.ok(requests[0].includes("Xhel!lo"), "the provider receives the edited text");
  console.log("PASS tern draft editing: caret, selection, word delete, and undo drive the composer");
} catch (error) {
  console.error(`FAIL ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  cleanup();
}
