#!/usr/bin/env -S node --experimental-strip-types
/**
 * Real Pi session + real Swarm agent tools + Tern bridge: Ctrl+B releases the agent call blocking the turn.
 *
 * The probe registers the production agent tools (`registerSwarmAgentTools`, the same call the extension
 * makes), whose runner never settles, so a `wait_for_agent` and a foreground `Subagent` block exactly as a
 * slow worker does. The key goes through Tern's own decode (`keyEffect`) and the bridge method `run.ts`
 * dispatches the `detach` effect to — the two lines run.ts runs — and the assertions read the tool results
 * and the running-work store, not the rendered text.
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePiHost } from "../install/pi-host.mjs";
import { PiTernBridge } from "../../.pi/lib/tern/bridge.ts";
import { keyEffect } from "../../.pi/lib/tern/keys.ts";
import { runningWorkSnapshot } from "../../.pi/lib/ui/running-work-store.ts";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const root = mkdtempSync(join(tmpdir(), "trebol-tern-ctrlb-"));
let session;
let bridge;
const cleanup = () => { bridge?.close(); session?.dispose(); rmSync(root, { recursive: true, force: true }); };
const deadline = setTimeout(() => { console.error("FAIL tern Ctrl+B detach timed out"); cleanup(); process.exit(1); }, 60_000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  const agentDir = join(root, "agent");
  mkdirSync(agentDir);
  const probe = join(root, "agent-wait-probe.ts");
  writeFileSync(probe, `import { registerSwarmAgentTools } from ${JSON.stringify(join(repo, "extensions/swarm-agent-tools/extension.ts"))};
import { AgentManager } from ${JSON.stringify(join(repo, "packages/tools/agents/src/index.ts"))};
export default function agentWaitProbe(pi: any) {
  const manager = new AgentManager({ cwd: pi.getCwd?.() ?? process.cwd(), runner: () => new Promise(() => {}) });
  const logic = registerSwarmAgentTools(pi, { manager });
  (globalThis as any).__launchAgent = async (task: string) => JSON.parse((await logic.backgroundTask({ task })).text).agent_id;
  (globalThis as any).__waitForAgent = async (id: string) => (await logic.waitForAgent({ agent_id: id, timeout_seconds: 600 })).text;
  (globalThis as any).__foregroundSubagent = async (task: string) => (await logic.subagent({ task })).text;
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

  // The two lines run.ts runs for a detach key: decode, then hand it to the bridge.
  const pressCtrlB = () => {
    const effect = keyEffect("\x02");
    assert.deepEqual(effect, { kind: "detach" }, "Ctrl+B decodes to the detach effect");
    assert.ok(!bridge.applyEditKey(effect), "detach is not a plain text-edit key");
    return bridge.backgroundForegroundWork();
  };

  // 1. wait_for_agent: the call blocks the turn; Ctrl+B releases it and the agent keeps running.
  const waited = await globalThis.__launchAgent("hold the turn");
  const waiting = globalThis.__waitForAgent(waited);
  await sleep(200);
  assert.equal(pressCtrlB(), true, "Ctrl+B finds the blocking wait");
  const waitResult = JSON.parse(await waiting);
  assert.equal(waitResult.wait_status, "backgrounded", "the wait returns instead of staying blocked");
  assert.equal(waitResult.agent.status, "running", "the agent was not cancelled");
  assert.equal(runningWorkSnapshot().find((w) => w.id === waited)?.status, "running", "its item is still live in the store");
  assert.ok(writes.join("").includes("Background work"), "the bridge draws the background card");

  // 2. A foreground Subagent, which used to hold the turn until the worker finished.
  const sub = globalThis.__foregroundSubagent("hold the turn too");
  await sleep(200);
  assert.equal(pressCtrlB(), true, "Ctrl+B releases a foreground Subagent");
  const subResult = JSON.parse(await sub);
  assert.equal(subResult.status, "async_launched", "the call returns the background envelope");
  assert.ok(subResult.agent_id, "the envelope names the agent to poll");
  assert.equal(runningWorkSnapshot().find((w) => w.id === subResult.agent_id)?.foreground, false, "the item left the turn");
  const bar = writes.join("");
  assert.ok(bar.includes('"role":"pi.background.agent"'), "the released subagent is drawn in the bar");

  // 3. With nothing blocking, the chord is inert: no error, no false "moved" result.
  assert.equal(pressCtrlB(), false, "Ctrl+B reports nothing to move");
  console.log("PASS tern Ctrl+B detach: wait_for_agent and a foreground Subagent released, agents still running");
} catch (error) {
  console.error(`FAIL ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  cleanup();
  process.exit();
}
