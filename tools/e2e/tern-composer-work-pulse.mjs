#!/usr/bin/env -S node --experimental-strip-types
/** Real Pi session + Tern bridge: live background work is one composer pulse (spinner, count, ≤3 jobs in the
 * hover card) and nothing at all once it settles. The pulse replaced the dock card this file used to assert. */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePiHost } from "../install/pi-host.mjs";
import { PiTernBridge } from "../../.pi/lib/tern/bridge.ts";
import { setRunningWork, removeRunningWork } from "../../.pi/lib/ui/running-work-store.ts";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const root = mkdtempSync(join(tmpdir(), "trebol-tern-work-pulse-"));
let session;
const cleanup = () => { session?.dispose(); rmSync(root, { recursive: true, force: true }); };
const deadline = setTimeout(() => { console.error("FAIL tern composer work pulse timed out"); cleanup(); process.exit(1); }, 60_000);

try {
  const agentDir = join(root, "agent");
  mkdirSync(agentDir);
  // Pi's extension loader handles TypeScript parameter properties; this probe starts real background Bash inside the session.
  const probe = join(root, "bg-card-probe.ts");
  writeFileSync(probe, `import { SwarmBackgroundProcessManager } from ${JSON.stringify(join(repo, ".pi/lib/tools/swarm-bgprocess.ts"))};
export default function bgCardProbe(pi: any) {
  pi.on("session_start", (_event: unknown, ctx: any) => {
    const manager = new SwarmBackgroundProcessManager();
    (globalThis as any).__bgCardLaunch = () => manager.executeBash({ command: "sleep 2", background: true, description: "Card probe" }, ctx.cwd);
    (globalThis as any).__bgCardLaunchMany = () => Promise.all(Array.from({ length: 6 }, (_, i) => manager.executeBash({ command: "sleep 3; echo many-" + i, background: true, description: "Many " + i }, ctx.cwd)));
  });
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
  const bridge = new PiTernBridge(session, { write: (d) => writes.push(d), surfaceId: "pi", credits: 1000 });
  bridge.start("pi");
  await session.bindExtensions({ mode: "tui", uiContext: bridge.uiContext() });
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(!writes.join("").includes('"role":"pi.composer.work"'), "no work pulse when nothing is running");
  assert.ok(!writes.join("").includes('"role":"pi.background"'), "the dock card is gone for good");

  const launch = await globalThis.__bgCardLaunch();
  assert.ok(launch.text.includes('"backgrounded":true'), "background Bash launches");
  await new Promise((r) => setTimeout(r, 400));
  const during = writes.join("");
  assert.ok(during.includes('"role":"pi.composer.work"'), "a live background command renders as one pulse");
  assert.ok(during.includes('"role":"pi.composer.work.pulse"'), "the pulse draws Tern's own spinner");
  assert.ok(during.includes('"k":"spinner"'), "the spinner is a node Tern clocks, not text we redraw");
  assert.ok(during.includes('"role":"pi.composer.work.count","text":"1"'), "the pulse counts the live job");
  assert.ok(during.includes('"text":"sleep 2"'), "the hover card names the command");
  assert.ok(during.includes('"k":"elapsed"'), "each card row carries a Tern-clocked timer");

  const frames = writes.length;
  await new Promise((r) => setTimeout(r, 3000));
  const after = writes.slice(frames).join("");
  assert.ok(after.includes('["del","work"'), "the pulse is removed once the command finishes");

  // Six live items: the count sees all six and no list is drawn in the bar.
  const manyFrames = writes.length;
  await globalThis.__bgCardLaunchMany();
  await new Promise((r) => setTimeout(r, 400));
  const many = writes.slice(manyFrames).join("");
  assert.ok(many.includes('"role":"pi.composer.work.count","text":"6"'), "the pulse counts all six live jobs");
  assert.ok(!many.includes("pi.composer.work.item"), "no per-job rows are drawn in the bar");
  assert.ok(!many.includes("pi.composer.work.card"), "no hover card is drawn: the bar's band would clip it");
  // Subagent rows come from the same store the agent runtime writes (swarm-agent-tools.ts setRunningWork).
  setRunningWork({ id: "agent-probe", kind: "subagent", label: "Agent agent-probe", status: "running", startedAt: Date.now() - 4000, detail: "Review the parser" });
  await new Promise((r) => setTimeout(r, 300));
  const agentRow = writes.slice(manyFrames).join("");
  assert.ok(agentRow.includes("Agent agent-probe"), "the pulse names the newest job");
  assert.ok(agentRow.includes('"role":"pi.composer.work.now"'), "that name is the hover/focus reveal");
  removeRunningWork("agent-probe");
  console.log("PASS tern composer work pulse: one pulse while work runs, removed on completion, six jobs counted, no list in the bar");
} catch (error) {
  console.error(`FAIL ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  cleanup();
}
