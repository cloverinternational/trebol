#!/usr/bin/env -S node --experimental-strip-types
/** Real Pi session + Tern bridge: the task popover toggles between list and Hoja-style board, and board cards reference tasks. */
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

const root = mkdtempSync(join(tmpdir(), "trebol-tern-board-"));
let session;
const cleanup = () => { session?.dispose(); rmSync(root, { recursive: true, force: true }); };
const deadline = setTimeout(() => { console.error("FAIL tern task board timed out"); cleanup(); process.exit(1); }, 60_000);
const task = (id, status, extra = {}) => ({ id, subject: `Task ${id}`, status, priority: "medium", dependsOn: [], notes: [],
  createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", questions: [], ...extra });

try {
  const agentDir = join(root, "agent");
  mkdirSync(agentDir);
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "local", defaultModel: "script" }));
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { local: { baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", apiKey: "dummy", models: [{ id: "script", contextWindow: 8000, maxTokens: 1000 }] } } }));

  const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } = await import(resolvePiHost({ executable: process.env.PI_EXECUTABLE }).sdkUrl);
  const settingsManager = SettingsManager.create(root, agentDir);
  const resourceLoader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager, noExtensions: true, noSkills: true, noThemes: true, noContextFiles: true, noPromptTemplates: true });
  await resourceLoader.reload();
  ({ session } = await createAgentSession({ cwd: root, agentDir, settingsManager, resourceLoader, sessionManager: SessionManager.inMemory(root) }));
  session.sessionManager.appendCustomEntry("pi-swarm-task-state", {
    schemaVersion: 2, revision: 1, savedAt: "2026-01-01T00:00:00Z", nextId: 4, keys: {},
    tasks: [task("1", "pending"), task("2", "in_progress", { active: true }), task("3", "completed")],
  });

  const writes = [];
  const bridge = new PiTernBridge(session, { write: (d) => writes.push(d), surfaceId: "pi", credits: 1000 });
  bridge.start("pi");
  await new Promise((r) => setTimeout(r, 300));
  const act = (id, actName, extra = {}) => bridge.handle({ verb: "e", body: { ev: "action", id, act: actName, ...extra } });
  // Replay the applied tree, not historical add operations: toggling removes old cards.
  const latest = () => {
    const nodes = new Map();
    const walk = (parent, node) => { nodes.set(node.id, { parent, node }); for (const c of node.c ?? []) walk(node.id, c); };
    const remove = (id) => {
      for (const [child, entry] of nodes) if (entry.parent === id) remove(child);
      nodes.delete(id);
    };
    for (const w of writes) {
      if (!w.startsWith(PREFIX)) continue;
      const body = JSON.parse(w.slice(PREFIX.length).split(`${ESC}\\`)[0]);
      for (const op of body.ops) {
        if (op[0] === "add") walk(op[2], op[4]);
        else if (op[0] === "del") remove(op[1]);
        else if (op[0] === "set" && nodes.has(op[1])) {
          const props = nodes.get(op[1]).node.p ?? {};
          for (const [key, value] of Object.entries(op[2])) {
            if (value === null) delete props[key]; else props[key] = value;
          }
        }
      }
    }
    return nodes;
  };

  assert.equal(latest().has("task-board"), false, "list is the default view");
  assert.ok(latest().has("task-pop-2"), "list rows are rendered");

  act("task-pop-head", "tasks.view");
  const board = latest();
  const columns = ["task-board-todo", "task-board-in_progress", "task-board-done"];
  for (const id of columns) assert.equal(board.get(id)?.parent, "task-board", `${id} is a board column`);
  assert.equal(board.has("task-pop-2"), false, "list rows are removed from the board tree");
  assert.equal([...board.keys()].filter((id) => id.startsWith("task-board-card-")).length, 3, "each task has one board card");
  assert.equal(board.get("task-board-card-1")?.parent, "task-board-todo", "pending task is in Todo");
  assert.equal(board.get("task-board-card-2")?.parent, "task-board-in_progress", "in_progress task is in In Progress");
  assert.equal(board.get("task-board-card-3")?.parent, "task-board-done", "completed task is in Done");
  assert.deepEqual(board.get("task-board-card-2")?.node.p.actions, { click: "tasks.reference=2" }, "card click references the task");

  act("task-pop-head", "tasks.view");
  const restored = latest();
  assert.equal(restored.has("task-board"), false, "board is removed when list returns");
  assert.equal(restored.get("task-pop-2")?.node.p.role, "pi.tasks.row", "toggling back restores the list");
  console.log("PASS tern task board: list/board toggle and column placement from a live bridge");
} finally {
  clearTimeout(deadline);
  cleanup();
}
