#!/usr/bin/env -S node --experimental-strip-types
/**
 * Real Pi session + the production swarm-background-bash extension + Tern bridge: Tern's composer draws the
 * Background button while a foreground Bash call is running, one click moves that call to the background, and
 * the button disappears because its state did.
 *
 * Nothing here is stubbed but the model provider: the tool, the detach the extension publishes, the running-work
 * store and the frames Tern applies are the production ones. The assertions read the wire, so a passing run is
 * "Tern would draw this", not "a private field changed".
 *
 * Run: PI_EXECUTABLE=node_modules/.bin/pi node --experimental-strip-types tools/e2e/tern-background-button.mjs
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePiHost } from "../install/pi-host.mjs";
import { PiTernBridge } from "../../.pi/lib/tern/bridge.ts";
import { runningWorkSnapshot } from "../../.pi/lib/ui/running-work-store.ts";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const root = mkdtempSync(join(tmpdir(), "trebol-tern-bgbutton-"));
let session;
let bridge;
const cleanup = () => { bridge?.close(); session?.dispose(); rmSync(root, { recursive: true, force: true }); };
const deadline = setTimeout(() => { console.error("FAIL tern Background button timed out"); cleanup(); process.exit(1); }, 60_000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  const agentDir = join(root, "agent");
  mkdirSync(agentDir);
  // The probe stands in for the extension pack: it loads the production background-bash extension and hands the
  // scenario its real Bash tool. registerTool is captured before the extension wraps Pi, so the captured tool is
  // the one Tern's turns actually call.
  const probe = join(root, "background-bash-probe.ts");
  writeFileSync(probe, `import { registerSwarmBackgroundBash } from ${JSON.stringify(join(repo, "extensions/swarm-background-bash/extension.ts"))};
export default function backgroundBashProbe(pi: any) {
  const tools: any[] = [];
  const registerTool = pi.registerTool.bind(pi);
  pi.registerTool = (tool: any) => { tools.push(tool); return registerTool(tool); };
  registerSwarmBackgroundBash(pi);
  (globalThis as any).__bash = tools.find((tool: any) => tool.name === "Bash");
}
`);
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "local", defaultModel: "script" }));
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { local: { baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", apiKey: "dummy", models: [{ id: "script", contextWindow: 100000, maxTokens: 1024, reasoning: false }] } } }));
  const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } = await import(resolvePiHost({ executable: process.env.PI_EXECUTABLE }).sdkUrl);
  const settingsManager = SettingsManager.create(root, agentDir);
  const resourceLoader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager, noExtensions: true, noSkills: true, noThemes: true, noContextFiles: true, noPromptTemplates: true, additionalExtensionPaths: [probe] });
  await resourceLoader.reload();
  ({ session } = await createAgentSession({ cwd: root, agentDir, settingsManager, resourceLoader, sessionManager: SessionManager.inMemory(root) }));

  const writes = [];
  bridge = new PiTernBridge(session, { write: (d) => writes.push(d), surfaceId: "pi", credits: 1000 });
  bridge.start("pi");
  await session.bindExtensions({ mode: "tui", uiContext: bridge.uiContext() });
  await sleep(300);
  const frames = () => writes.join("");
  const bash = globalThis.__bash;
  assert.ok(bash, "the extension registered its Bash tool");

  // 1. Nothing to background: the bar carries no button.
  assert.ok(!frames().includes('"role":"omp.composer.background"'), "no button while nothing runs");

  // 2. A foreground Bash call: the button appears with the chord it mirrors.
  const command = "sleep 4; printf button-e2e";
  const running = bash.execute("call", { command, timeout_seconds: 60 }, undefined, undefined, { cwd: root });
  const live = await until(() => runningWorkSnapshot().find((w) => w.kind === "bash" && w.foreground === true && w.detail === command));
  await sleep(120);
  assert.ok(frames().includes('"role":"omp.composer.background"'), "the composer bar draws the button");
  assert.ok(frames().includes('"keys":["ctrl","b"]'), "the button shows ctrl+b");
  assert.ok(frames().includes('"click":"bg.background"'), "the button carries its action");

  // 3. One click: the same dispatch the key uses.
  bridge.handle({ verb: "e", body: { ev: "action", act: "bg.background" } });
  const result = JSON.parse((await running).content[0].text);
  assert.equal(result.backgrounded, true, "the call returns instead of blocking the turn");
  assert.equal(result.status, "running", "the command keeps running");
  assert.equal(runningWorkSnapshot().find((w) => w.id === live.id)?.foreground, false, "the item left the turn");

  // 4. The button went away because its state did, and the background card took the row.
  await sleep(120);
  assert.ok(frames().includes('["del","composer-background"]'), "the button is removed once nothing is foreground");
  assert.ok(frames().includes('"role":"pi.background"'), "the background card draws the moved work");
  runningWorkSnapshot().find((w) => w.id === live.id)?.stop?.();
  console.log("PASS tern Background button: drawn only for a live foreground call, one click detaches it");
} catch (error) {
  console.error(`FAIL ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  cleanup();
  process.exit();
}

async function until(check, tries = 400) {
  for (let i = 0; i < tries; i++) {
    const value = check();
    if (value !== undefined) return value;
    await sleep(25);
  }
  throw new Error("condition never held");
}
