#!/usr/bin/env -S node --experimental-strip-types
/** Real Pi session + Tern bridge: the task block is emitted inside the composer column, so it shares the input's bounds. */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePiHost } from "../install/pi-host.mjs";
import { PiTernBridge } from "../../.pi/lib/tern/bridge.ts";

const ESC = "\u001b";
const PREFIX = `${ESC}_tsp;f;`;
// Applied TSP ops in order: an `add` op is [op, id, parentId, index, node]; a node's `c` holds its children.
function collect(parent, node, out) {
  out.push({ parent, node });
  for (const child of node?.c ?? []) collect(node.id, child, out);
}
function tspAdds(writes) {
  const adds = [];
  for (const w of writes) {
    if (!w.startsWith(PREFIX)) continue;
    const body = JSON.parse(w.slice(PREFIX.length).split(`${ESC}\\`)[0]);
    for (const op of body.ops) if (op[0] === "add") collect(op[2], op[4], adds);
  }
  return adds;
}

const root = mkdtempSync(join(tmpdir(), "trebol-tern-width-"));
let session;
const cleanup = () => { session?.dispose(); rmSync(root, { recursive: true, force: true }); };
const deadline = setTimeout(() => { console.error("FAIL tern composer width timed out"); cleanup(); process.exit(1); }, 60_000);

try {
  const agentDir = join(root, "agent");
  mkdirSync(agentDir);
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "local", defaultModel: "script" }));
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { local: { baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", apiKey: "dummy", models: [{ id: "script", contextWindow: 100000, maxTokens: 1024, reasoning: false }] } } }));

  const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } = await import(resolvePiHost({ executable: process.env.PI_EXECUTABLE }).sdkUrl);
  const settingsManager = SettingsManager.create(root, agentDir);
  const resourceLoader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager, noExtensions: true, noSkills: true, noThemes: true, noContextFiles: true, noPromptTemplates: true });
  await resourceLoader.reload();
  ({ session } = await createAgentSession({ cwd: root, agentDir, settingsManager, resourceLoader, sessionManager: SessionManager.inMemory(root) }));
  session.sessionManager.appendCustomEntry("pi-swarm-task-state", {
    schemaVersion: 2, revision: 1, savedAt: "2026-01-01T00:00:00Z", nextId: 2, keys: {},
    tasks: [{ id: "1", subject: "Inspect renderer", status: "in_progress", active: true, priority: "medium", dependsOn: [], notes: [],
      createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", questions: [{ id: "q1", text: "Full width?" }] }],
  });

  const writes = [];
  const bridge = new PiTernBridge(session, { write: (d) => writes.push(d), surfaceId: "pi", credits: 1000 });
  bridge.start("pi");
  await new Promise((r) => setTimeout(r, 300));

  const adds = tspAdds(writes);
  const task = adds.find((a) => a.node?.id === "task-top");
  assert.ok(task, "task block is rendered");
  assert.equal(task.parent, "composer-col", "task block is nested in the composer column, so it takes the input's bounds");
  assert.equal(adds.find((a) => a.node?.id === "composer-col")?.parent, "dock", "composer column stays a direct dock child");
  console.log("PASS tern composer width: task block shares the composer column bounds");
} finally {
  clearTimeout(deadline);
  cleanup();
}
