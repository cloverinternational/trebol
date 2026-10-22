import { describe, expect, it } from "vitest";
import { createSwarmBuiltinPipeline, type HookTask } from "../../lib/runtime/swarm-builtin-hooks.ts";
import { READ_ONLY_DOMAIN_TOOLS } from "../../lib/runtime/swarm-toolclass.ts";

const BLOCK = "YOU CANNOT EXECUTE ANY TOOL WITHOUT A TASK";

/** task-enforcement in block mode: the state that produced the Hoja false positive. */
const pipeline = (tasks: HookTask[], session: string) =>
  createSwarmBuiltinPipeline({ session, tasks: () => tasks, enforcementMode: "block", completion: { enabled: false } });

const blockFor = (tasks: HookTask[], toolName: string, params: any = {}) =>
  pipeline(tasks, `readonly-domain-${toolName}-${tasks.length}`).preTool({ toolName, params }).block;

describe("read-only domain tools pass task enforcement without a focused task", () => {
  it("allows hoja_list and hoja_get when no task exists at all", () => {
    expect(blockFor([], "hoja_list")).toBeUndefined();
    expect(blockFor([], "hoja_get", { identifier: "TREBOL-320" })).toBeUndefined();
  });

  it("allows hoja_list and hoja_get after the worker's task completed (no focused task)", () => {
    const tasks: HookTask[] = [{ id: "1", subject: "TREBOL-320", status: "completed", active: false }];
    expect(blockFor(tasks, "hoja_list")).toBeUndefined();
    expect(blockFor(tasks, "hoja_get", { identifier: "TREBOL-320" })).toBeUndefined();
  });

  it("matches Hoja tool names case- and underscore-insensitively", () => {
    expect(blockFor([], "hojaList")).toBeUndefined();
    expect(blockFor([], "hoja_get", { identifier: "TREBOL-320" })).toBeUndefined();
  });

  it("allows read-only context retrieval but not its writing siblings", () => {
    expect(blockFor([], "context_search", { operation: "search", query: "task enforcement" })).toBeUndefined();
    expect(blockFor([], "context_outline", { operation: "outline", sourceId: "s1" })).toBeUndefined();
    expect(blockFor([], "context_read", { operation: "read", sourceId: "s1", nodeIds: ["n1"] })).toBeUndefined();
    expect(blockFor([], "context_inspect", { operation: "inspect" })).toBeUndefined();

    expect(blockFor([], "context_remember", { operation: "remember", note: "x" })).toContain(BLOCK);
    expect(blockFor([], "context_index", { operation: "index", text: "x" })).toContain(BLOCK);
    expect(blockFor([], "context_reindex", { operation: "reindex", sourceId: "s1" })).toContain(BLOCK);
    expect(blockFor([], "context_delete", { operation: "delete", sourceId: "s1" })).toContain(BLOCK);
  });

  it("allows HistorySearch and HistoryGet", () => {
    expect(blockFor([], "HistorySearch", { query: "hoja" })).toBeUndefined();
    expect(blockFor([], "HistoryGet", { conversation_id: "c1" })).toBeUndefined();
  });

  it("allows vault list and get but keeps vault add and remove blocked", () => {
    expect(blockFor([], "vault", { action: "list" })).toBeUndefined();
    expect(blockFor([], "vault", { action: "get", id: "linear" })).toBeUndefined();

    expect(blockFor([], "vault", { action: "add", id: "x", kind: "password", secret: "s" })).toContain(BLOCK);
    expect(blockFor([], "vault", { action: "remove", id: "x" })).toContain(BLOCK);
    // No action at all is not a read; it must stay gated.
    expect(blockFor([], "vault", {})).toContain(BLOCK);
  });

  it("still blocks mutating, spawning and sending tools in the same state", () => {
    expect(blockFor([], "apply_patch", { input: "x" })).toContain(BLOCK);
    expect(blockFor([], "claw_spawn", { task: "x" })).toContain(BLOCK);
    expect(blockFor([], "claw_send", { text: "x" })).toContain(BLOCK);
    expect(blockFor([], "bash", { command: "rm -rf /tmp/x" })).toContain(BLOCK);
  });

  it("still blocks an unknown tool", () => {
    expect(blockFor([], "totally_unknown_tool", {})).toContain(BLOCK);
    expect(blockFor([], "hoja_write", {})).toContain(BLOCK);
    expect(blockFor([], "vault_export", {})).toContain(BLOCK);
  });

  it("keeps the allowlist to the audited read-only names only", () => {
    expect([...READ_ONLY_DOMAIN_TOOLS].sort()).toEqual([
      "contextinspect", "contextoutline", "contextread", "contextsearch",
      "historyget", "historysearch", "hojaget", "hojalist",
    ]);
  });
});

describe("behavior with a focused task is unchanged", () => {
  const focused: HookTask[] = [{ id: "1", subject: "TREBOL-320", status: "in_progress", active: true }];

  it("allows reads, writes and unknown tools alike while a task is focused", () => {
    expect(blockFor(focused, "hoja_list")).toBeUndefined();
    expect(blockFor(focused, "hoja_get", { identifier: "TREBOL-320" })).toBeUndefined();
    expect(blockFor(focused, "vault", { action: "add" })).toBeUndefined();
    expect(blockFor(focused, "context_remember", { operation: "remember" })).toBeUndefined();
    expect(blockFor(focused, "totally_unknown_tool")).toBeUndefined();
    expect(blockFor(focused, "apply_patch", {})).toBeUndefined();
  });
});
