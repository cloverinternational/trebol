#!/usr/bin/env -S node --experimental-strip-types
/** Real Pi session + real background Bash + Tern bridge: a row click opens live output, its x kills the process. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePiHost } from "../install/pi-host.mjs";
import { PiTernBridge } from "../../.pi/lib/tern/bridge.ts";
import { runningWorkSnapshot } from "../../.pi/lib/ui/running-work-store.ts";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const root = mkdtempSync(join(tmpdir(), "trebol-tern-bgstop-"));
const marker = `bgstop-${process.pid}-${Date.now()}`;
let session;
let bridge;
const cleanup = () => { bridge?.close(); session?.dispose(); rmSync(root, { recursive: true, force: true }); };
const deadline = setTimeout(() => { console.error("FAIL tern background stop timed out"); cleanup(); process.exit(1); }, 60_000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Independent of the bridge and the store: ask the OS which processes still carry the marker.
const alive = () => { try { return execFileSync("pgrep", ["-f", marker], { encoding: "utf8" }).trim(); } catch { return ""; } };
const action = (act, value, id = "x") => bridge.handle({ verb: "e", body: { ev: "action", sf: "pi", id, act, ...(value === undefined ? {} : { value }) } });

try {
  const agentDir = join(root, "agent");
  mkdirSync(agentDir);
  const probe = join(root, "bg-stop-probe.ts");
  writeFileSync(probe, `import { SwarmBackgroundProcessManager } from ${JSON.stringify(join(repo, ".pi/lib/tools/swarm-bgprocess.ts"))};
export default function bgStopProbe(pi: any) {
  pi.on("session_start", (_event: unknown, ctx: any) => {
    const manager = new SwarmBackgroundProcessManager();
    (globalThis as any).__bgStopLaunch = (command: string) => manager.executeBash({ command, background: true, description: "Stop probe" }, ctx.cwd);
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
  bridge = new PiTernBridge(session, { write: (d) => writes.push(d), surfaceId: "pi", credits: 1000 });
  bridge.start("pi");
  await session.bindExtensions({ mode: "tui", uiContext: bridge.uiContext() });
  await sleep(300);

  // A long-running command that prints a counter; the marker makes it findable by pgrep.
  await globalThis.__bgStopLaunch(`i=0; while true; do i=$((i+1)); echo "${marker} tick $i"; sleep 0.2; done`);
  await sleep(600);
  const item = runningWorkSnapshot().find((w) => w.detail.includes(marker));
  assert.ok(item, "the command is in the running-work store");
  assert.ok(alive(), "pgrep sees the live process before stop");
  const bar = writes.join("");
  assert.ok(bar.includes(`"click":"bg.open=${item.id}"`), "row carries the open action");
  assert.ok(bar.includes(`"click":"bg.stop=${item.id}"`), "running row carries the x");

  let from = writes.length;
  action("bg.open", item.id, `bg-work-${item.id}`);
  const firstTicks = writes.slice(from).join("").match(/tick (\d+)/g) ?? [];
  assert.ok(firstTicks.length > 0, "the output sheet shows the command's output");
  const firstMax = Math.max(...firstTicks.map((t) => Number(t.split(" ")[1])));
  from = writes.length;
  await sleep(1200);
  const laterTicks = writes.slice(from).join("").match(/tick (\d+)/g) ?? [];
  const laterMax = Math.max(0, ...laterTicks.map((t) => Number(t.split(" ")[1])));
  assert.ok(laterMax > firstMax, `the open sheet stays live (tick ${firstMax} → ${laterMax})`);

  action("bg.stop", item.id, "bg-output-stop");
  let gone = false;
  for (let i = 0; i < 40 && !gone; i++) { await sleep(150); gone = !alive(); }
  assert.ok(gone, "pgrep finds no process after the x");
  await sleep(300);
  const settled = runningWorkSnapshot().find((w) => w.id === item.id);
  assert.equal(settled?.status, "cancelled", "the store records the stop");
  assert.equal(settled?.stop, undefined, "settled work offers no stop");
  const after = writes.join("");
  assert.ok(after.includes(`"head":"Stop probe · cancelled"`) || after.includes("· cancelled"), "the sheet shows the cancelled state");
  assert.ok(after.includes('["del","background-work"'), "the bar drops the stopped work");
  console.log(`PASS tern background stop: live output tick ${firstMax}→${laterMax}, x killed the process (pgrep empty), store=cancelled`);
} catch (error) {
  console.error(`FAIL ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  cleanup();
  const leftover = alive();
  if (leftover) { console.error(`FAIL orphan process: ${leftover}`); process.exitCode = 1; }
  process.exit();
}
