#!/usr/bin/env -S node --experimental-strip-types
/** Real Pi session + Tern bridge: live background work renders as a TSP card, caps at five rows, and is removed on completion. */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePiHost } from "../install/pi-host.mjs";
import { PiTernBridge } from "../../.pi/lib/tern/bridge.ts";
import { setRunningWork, removeRunningWork } from "../../.pi/lib/ui/running-work-store.ts";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const root = mkdtempSync(join(tmpdir(), "trebol-tern-bgcard-"));
let session;
const cleanup = () => { session?.dispose(); rmSync(root, { recursive: true, force: true }); };
const deadline = setTimeout(() => { console.error("FAIL tern background card timed out"); cleanup(); process.exit(1); }, 60_000);

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
  assert.ok(!writes.join("").includes('"role":"pi.background"'), "no background card when nothing is running");

  const launch = await globalThis.__bgCardLaunch();
  assert.ok(launch.text.includes('"backgrounded":true'), "background Bash launches");
  await new Promise((r) => setTimeout(r, 400));
  const during = writes.join("");
  assert.ok(during.includes('"role":"pi.background"'), "a live background command renders as a card");
  assert.ok(during.includes("Background work · 1 running"), "card head counts running work");
  assert.ok(during.includes('"text":"sleep 2"'), "bash row shows its command");
  assert.ok(during.includes('"k":"elapsed"'), "row shows a live elapsed timer");

  const frames = writes.length;
  await new Promise((r) => setTimeout(r, 3000));
  const after = writes.slice(frames).join("");
  assert.ok(after.includes('["del","background-work"'), "the card is removed once the command finishes");

  // Six live items: rows cap at five and the card points to /work for the rest.
  const manyFrames = writes.length;
  await globalThis.__bgCardLaunchMany();
  await new Promise((r) => setTimeout(r, 400));
  const many = writes.slice(manyFrames).join("");
  assert.ok(many.includes("Background work · 6 running"), "card head counts all six live items");
  assert.ok(many.includes("+1 more · /work"), "card reports the one row over the five-row cap");
  assert.equal((many.match(/"id":"bg-work-[^"]+","k":"row"/g) ?? []).length, 5, "card renders exactly five rows");
  // Subagent rows come from the same store the agent runtime writes (swarm-agent-tools.ts setRunningWork); this checks the card, not a model run.
  setRunningWork({ id: "agent-probe", kind: "subagent", label: "Agent agent-probe", status: "running", startedAt: Date.now() - 4000, detail: "Review the parser" });
  await new Promise((r) => setTimeout(r, 300));
  const agentRow = writes.slice(manyFrames).join("");
  assert.ok(agentRow.includes('"id":"bg-work-agent-probe","k":"agent"'), "a subagent renders as Tern's agent row, not a text row");
  assert.ok(agentRow.includes('"task":"Review the parser"'), "agent row carries the assignment");
  assert.ok(agentRow.includes('"role":"pi.background.agent"'), "agent row keeps its own role");
  removeRunningWork("agent-probe");
  console.log("PASS tern background card: one item shown and removed on completion; six items capped at five rows");
} catch (error) {
  console.error(`FAIL ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  cleanup();
}
