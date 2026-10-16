#!/usr/bin/env -S node --experimental-strip-types
/** Real Pi session + Tern bridge: a TaskManage call renders as Hoja-style task rows and never as raw JSON. */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePiHost } from "../install/pi-host.mjs";
import { PiTernBridge } from "../../.pi/lib/tern/bridge.ts";
import { PI_COMPOSER_CSS } from "../../.pi/lib/tern/composer-style.ts";

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

const root = mkdtempSync(join(tmpdir(), "trebol-tern-taskcard-"));
let session;
const cleanup = () => { session?.dispose(); rmSync(root, { recursive: true, force: true }); };
const deadline = setTimeout(() => { console.error("FAIL tern taskmanage card timed out"); cleanup(); process.exit(1); }, 60_000);

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

  // Capture the session listener the bridge registers, so Pi-shaped tool events reach the real bridge.
  let emit;
  const subscribe = session.subscribe.bind(session);
  session.subscribe = (listener) => { emit = listener; return subscribe(listener); };
  const writes = [];
  const bridge = new PiTernBridge(session, { write: (d) => writes.push(d), surfaceId: "pi", credits: 1000 });
  bridge.start("pi");
  await new Promise((r) => setTimeout(r, 300));

  const operations = [
    { key: "a", op: "create", subject: "Ship the card and preserve the entire description when the task panel gets narrow enough to need multiple lines" },
    { key: "b", op: "update", taskId: "2", status: "completed" },
  ];
  const batch = { status: "partial", results: [
    { key: "a", op: "create", status: "succeeded", data: { task: { id: "4", subject: operations[0].subject, status: "pending" } } },
    { key: "b", op: "update", status: "failed", error: { message: "task 2 is blocked" } },
  ] };
  const result = { content: [{ type: "text", text: JSON.stringify(batch) }], details: { batch } };
  emit({ type: "tool_execution_start", toolCallId: "call-1", toolName: "TaskManage", args: { operations } });
  emit({ type: "tool_execution_end", toolCallId: "call-1", toolName: "TaskManage", result, isError: false });

  // Applies the TSP ops in order (add/del/set/text-append) so the final tree is what the frontend shows.
  const byId = new Map();
  const parentOf = new Map();
  const addTree = (parent, node) => {
    byId.set(node.id, { ...node, p: { ...(node.p ?? {}) }, c: undefined });
    parentOf.set(node.id, parent);
    for (const c of node.c ?? []) addTree(node.id, c);
  };
  const delTree = (id) => {
    for (const [child, parent] of parentOf) if (parent === id) delTree(child);
    byId.delete(id);
    parentOf.delete(id);
  };
  for (const w of writes) {
    if (!w.startsWith(PREFIX)) continue;
    const body = JSON.parse(w.slice(PREFIX.length).split(`${ESC}\\`)[0]);
    for (const op of body.ops) {
      if (op[0] === "add") addTree(op[2], op[4]);
      else if (op[0] === "del") delTree(op[1]);
      else if (op[0] === "set") {
        const n = byId.get(op[1]);
        if (n) for (const [k, v] of Object.entries(op[2])) { if (v === null) delete n.p[k]; else n.p[k] = v; }
      } else if (op[0] === "text" && op[2] === "append") {
        const n = byId.get(op[1]);
        if (n) n.p.text = `${n.p.text ?? ""}${op[3]}`;
      }
    }
  }
  const nodes = new Map([...byId].map(([id, node]) => [id, { parent: parentOf.get(id), node }]));
  const card = nodes.get("t-call-1")?.node;
  assert.ok(card, "TaskManage call renders a tool node");
  assert.equal(card.p.role, "tasks.call", "rendered with the task-card role");
  assert.equal(card.p.title, "Tasks", "card titled Tasks, not the tool name");
  const childrenOf = (id) => [...nodes].filter(([, v]) => v.parent === id).map(([, v]) => v.node);
  assert.equal(nodes.get("t-call-1-op-0")?.node.k, "col", "task card stacks its contents vertically");
  assert.equal(nodes.get("t-call-1-op-0-head")?.parent, "t-call-1-op-0", "operation occupies its own header row");
  assert.equal(childrenOf("t-call-1-op-0-head").find((n) => n.p.role === "tasks.op")?.p.text, "create #4");
  assert.equal(nodes.get("t-call-1-op-0-subject")?.parent, "t-call-1-op-0", "subject occupies a separate line");
  assert.equal(nodes.get("t-call-1-op-0-subject")?.node.p.text, operations[0].subject, "full long subject survives TSP projection");
  assert.equal(childrenOf("t-call-1-op-1-head").find((n) => n.p.role === "tasks.op")?.p.text, "update #2");
  assert.ok(childrenOf("t-call-1-op-1").some((c) => c.p.role === "tasks.error" && /blocked/.test(c.p.text)), "failed row shows the error text");
  assert.match(PI_COMPOSER_CSS, /\[data-role='tasks\.subject'\][^}]*white-space: normal;[^}]*overflow-wrap: anywhere;/, "subjects wrap instead of ellipsizing");
  const everything = JSON.stringify([...nodes.values()].map((n) => n.node.p));
  assert.ok(!everything.includes('"results"') && !everything.includes('"batch"') && !everything.includes("operations"), "no raw JSON in the rendered tree");
  console.log("PASS tern TaskManage card: Hoja-style task rows from a live bridge, no raw JSON rendered");
} finally {
  clearTimeout(deadline);
  cleanup();
}
