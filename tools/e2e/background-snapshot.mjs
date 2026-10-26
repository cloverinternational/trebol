#!/usr/bin/env -S node --experimental-strip-types
/** Real Pi session: BackgroundSnapshot is read-only, bounded, and reports unknown and finished ids correctly. */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePiHost } from "../install/pi-host.mjs";
import { PiTernBridge } from "../../.pi/lib/tern/bridge.ts";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const root = mkdtempSync(join(tmpdir(), "trebol-bg-snapshot-"));
let session;
const cleanup = () => { session?.dispose(); rmSync(root, { recursive: true, force: true }); };
const deadline = setTimeout(() => { console.error("FAIL background snapshot timed out"); cleanup(); process.exit(1); }, 60_000);

try {
  const agentDir = join(root, "agent");
  mkdirSync(agentDir);
  // The probe runs inside Pi's extension loader (which handles TypeScript parameter properties); it keeps the manager reachable from the test.
  const probe = join(root, "snapshot-probe.ts");
  writeFileSync(probe, `import { SwarmBackgroundProcessManager } from ${JSON.stringify(join(repo, ".pi/lib/tools/swarm-bgprocess.ts"))};
export default function snapshotProbe(pi: any) {
  pi.on("session_start", (_event: unknown, ctx: any) => {
    setTimeout(() => {
      const manager = new SwarmBackgroundProcessManager();
      (globalThis as any).__bgm = manager;
      manager.executeBash({ command: "echo SNAP_LINE; sleep 1", background: true, description: "Snapshot probe" }, ctx.cwd)
        .then((result: { text: string }) => { (globalThis as any).__bgLaunch = result.text; }, (error: Error) => { (globalThis as any).__bgLaunch = String(error); });
    }, 300);
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
  const bridge = new PiTernBridge(session, { write: () => {}, surfaceId: "pi", credits: 1000 });
  bridge.start("pi");
  await session.bindExtensions({ mode: "tui", uiContext: bridge.uiContext() });

  await new Promise((r) => setTimeout(r, 800));
  const manager = globalThis.__bgm;
  assert.ok(manager, "probe created the manager");
  const launch = JSON.parse(String(globalThis.__bgLaunch));
  const id = launch.task_id;
  assert.ok(id, `background launch returned a task_id (got ${globalThis.__bgLaunch})`);

  const first = manager.snapshot(id);
  const second = manager.snapshot(id);
  assert.deepEqual(second, first, "repeated snapshots while running are identical (no side effects)");
  assert.equal(first.status, "running", "live item reports running");
  assert.equal(first.ended_at, undefined, "live item has no ended_at");
  assert.ok(first.output_tail.length <= 20, "output tail is bounded to 20 lines");

  await new Promise((r) => setTimeout(r, 1800));
  const done = manager.snapshot(id);
  assert.equal(done.status, "completed", "finished item keeps its terminal state");
  assert.equal(done.exit_code, 0, "finished item reports exit_code");
  assert.ok(typeof done.ended_at === "number", "finished item reports ended_at");
  assert.ok(done.output_tail.includes("SNAP_LINE"), "finished item keeps its output tail");
  assert.equal(manager.snapshot("bg-does-not-exist"), undefined, "unknown id returns undefined");
  // ReadBackgroundCommand delegates to manager.read; the tool registration itself is not exercised here.
  const finishedStatus = JSON.parse((await manager.read({ action: "status", task_id: id, format: "json" })).text);
  assert.equal(finishedStatus.status, "completed", "ReadBackgroundCommand status reports a finished item as completed");
  assert.equal(finishedStatus.exit_code, 0, "ReadBackgroundCommand status keeps exit_code for a finished item");
  await assert.rejects(manager.read({ action: "status", task_id: "bg-does-not-exist" }), /process not found/, "unknown id is rejected with process not found");
  console.log("PASS background snapshot: read-only while running, terminal state kept, unknown id undefined");
} catch (error) {
  console.error(`FAIL ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  cleanup();
}
