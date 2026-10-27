import { describe, expect, it, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { installToolOutputSpill, spillToolResultEvent } from "../../lib/runtime/swarm-toolout-boundary.ts";
import { registerSwarmBuiltinHooks } from "../../lib/runtime/swarm-builtin-hooks-runtime.ts";
import { toggleHook } from "../../lib/runtime/hook-state.ts";
import { MIN_TOOL_OUTPUT_TOKENS, SPILL_DIR } from "../../lib/runtime/swarm-toolout.ts";

const tempRoot = () => mkdtempSync(join(tmpdir(), "toolout-boundary-"));
const textBlock = (text: string) => ({ type: "text", text });
const imageBlock = { type: "image", data: "aGVsbG8=", mimeType: "image/png" };
/** A body just over the smallest accepted budget, so tests stay fast. */
const oversized = (tag = "x") => `${tag}${"y".repeat(MIN_TOOL_OUTPUT_TOKENS * 4)}`;

describe("tool_result spill middleware", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => { while (cleanups.length) cleanups.pop()!(); });
  const root = () => { const dir = tempRoot(); cleanups.push(() => rmSync(dir, { recursive: true, force: true })); return dir; };

  it("leaves a small result completely unchanged", () => {
    expect(spillToolResultEvent({ content: [textBlock("ok")], isError: false })).toBeUndefined();
    expect(spillToolResultEvent({ content: [] })).toBeUndefined();
    expect(spillToolResultEvent({ content: [imageBlock] })).toBeUndefined();
  });

  it("bounds one oversized text block and names the spill file", () => {
    const dir = root();
    const full = oversized();
    const patch = spillToolResultEvent({ content: [textBlock(full)] }, { maxTokens: MIN_TOOL_OUTPUT_TOKENS, root: dir })!;
    const text = patch.content[0].text as string;
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(MIN_TOOL_OUTPUT_TOKENS * 4);
    expect(text).toContain("Full output saved to: ");
    expect(text).toContain("Use `sed -n 'START,ENDp' FILE`");
    const path = /Full output saved to: (.+)/.exec(text)![1]!.trim();
    expect(path.startsWith(join(dir, SPILL_DIR))).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(full);
  });

  it("preserves images and block order while clipping every text block", () => {
    const dir = root();
    const patch = spillToolResultEvent(
      { content: [textBlock(oversized("a")), imageBlock, textBlock(oversized("b"))] },
      { maxTokens: MIN_TOOL_OUTPUT_TOKENS, root: dir },
    )!;
    expect(patch.content).toHaveLength(3);
    expect(patch.content[1]).toBe(imageBlock);
    expect(patch.content[0].text).toContain("ayy");
    expect(patch.content[2].text).toContain("byy");
    expect(patch.content[0].text).not.toBe(oversized("a"));
    expect(readdirSync(join(dir, SPILL_DIR))).toHaveLength(1);
    const spilled = readFileSync(join(dir, SPILL_DIR, readdirSync(join(dir, SPILL_DIR))[0]!), "utf8");
    expect(spilled).toContain(oversized("a"));
    expect(spilled).toContain(oversized("b"));
  });

  it("never changes the error status", () => {
    const dir = root();
    const patch = spillToolResultEvent({ content: [textBlock(oversized())], isError: true }, { maxTokens: MIN_TOOL_OUTPUT_TOKENS, root: dir })!;
    expect("isError" in patch).toBe(false);
  });

  it("keeps structuredContent only when the tool produced it", () => {
    const dir = root();
    const kept = spillToolResultEvent(
      { content: [textBlock(oversized())], structuredContent: { output: "full" } },
      { maxTokens: MIN_TOOL_OUTPUT_TOKENS, root: dir },
    )!;
    expect(kept.structuredContent).toEqual({ output: "full" });
    const absent = spillToolResultEvent({ content: [textBlock(oversized())] }, { maxTokens: MIN_TOOL_OUTPUT_TOKENS, root: dir })!;
    expect("structuredContent" in absent).toBe(false);
  });

  it("budgets through the documented environment override and ignores invalid values", () => {
    const dir = root();
    const bounded = spillToolResultEvent(
      { content: [textBlock(oversized())] },
      { env: { PI_SWARM_TOOL_OUTPUT_TOKENS: String(MIN_TOOL_OUTPUT_TOKENS) }, root: dir },
    )!;
    expect(Buffer.byteLength(bounded.content[0].text, "utf8")).toBeLessThanOrEqual(MIN_TOOL_OUTPUT_TOKENS * 4);
    const ignored = spillToolResultEvent(
      { content: [textBlock(oversized())] },
      { env: { PI_SWARM_TOOL_OUTPUT_TOKENS: "nonsense" }, root: dir },
    );
    expect(ignored).toBeUndefined();
  });
});

describe("installToolOutputSpill", () => {
  it("registers one plain tool_result handler per Pi instance", () => {
    const handlers: Record<string, Function[]> = {};
    const pi = { on: (event: string, handler: Function) => { (handlers[event] ??= []).push(handler); } };
    installToolOutputSpill(pi);
    installToolOutputSpill(pi);
    expect(handlers.tool_result).toHaveLength(1);
  });

  it("runs with no session, no turns, and every hook group disabled", async () => {
    const dir = tempRoot();
    const handlers: Record<string, Function[]> = {};
    const pi = { on: (event: string, handler: Function) => { (handlers[event] ??= []).push(handler); } };
    installToolOutputSpill(pi, { maxTokens: MIN_TOOL_OUTPUT_TOKENS, root: dir });
    const previous = process.env.PI_SWARM_NO_HOOKS;
    process.env.PI_SWARM_NO_HOOKS = "1";
    try {
      toggleHook("taskmanage", false);
      // No session id and zero turns: a registerHook-based handler would be dormant here.
      for (const handler of handlers.tool_result!) {
        const patch = await handler({ content: [textBlock(oversized())] }, {});
        expect(patch?.content?.[0]?.text).toContain("Full output saved to: ");
      }
    } finally {
      toggleHook("taskmanage", true);
      if (previous === undefined) delete process.env.PI_SWARM_NO_HOOKS; else process.env.PI_SWARM_NO_HOOKS = previous;
    }
  });

  it("is installed by the Swarm builtin-hook registration, before the task hook", () => {
    const handlers: Record<string, Function[]> = {};
    const pi = {
      on: (event: string, handler: Function) => { (handlers[event] ??= []).push(handler); },
      appendEntry: () => {},
      sendMessage: () => {},
    };
    registerSwarmBuiltinHooks(pi as any, { enforcementMode: "off" });
    // One spill handler (plain) plus the taskmanage tool_result hook.
    expect(handlers.tool_result?.length).toBeGreaterThanOrEqual(2);
  });
});

/**
 * The real installed Pi runner, not a stand-in: `emitToolResult` is the code
 * path that merges extension patches into the model-facing result. If the
 * installed Pi is absent the suite reports it as skipped rather than passing
 * silently.
 */
function installedSdkUrl(): string | undefined {
  const installRoot = process.env.PI_MANAGED_INSTALL_ROOT ?? join(homedir(), ".pi/agent/install");
  try {
    const version = readFileSync(join(installRoot, "current-version"), "utf8").trim();
    const sdk = join(installRoot, "releases", version, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js");
    return existsSync(sdk) ? pathToFileURL(sdk).href : undefined;
  } catch { return undefined; }
}

const sdkUrl = installedSdkUrl();
const describeInstalled = sdkUrl ? describe : describe.skip;

describeInstalled("installed Pi result path", () => {
  const runnerFor = async (options: Record<string, unknown>) => {
    const { ExtensionRunner, createExtensionRuntime } = await import(sdkUrl!);
    const handlers: Function[] = [];
    installToolOutputSpill({ on: (event: string, handler: Function) => { if (event === "tool_result") handlers.push(handler); } }, options);
    const extensions = [{ path: "toolout-probe", handlers: new Map([["tool_result", handlers]]) }];
    return { runner: new ExtensionRunner(extensions as any, createExtensionRuntime(), process.cwd(), {}, {}), version: sdkUrl };
  };

  it("patches the model-facing text of a successful result", async () => {
    const dir = tempRoot();
    const { runner } = await runnerFor({ maxTokens: MIN_TOOL_OUTPUT_TOKENS, root: dir });
    const full = oversized();
    const patch = await runner.emitToolResult({
      type: "tool_result", toolName: "bash", toolCallId: "call-1", input: {},
      content: [textBlock(full)], isError: false, details: { exit_code: 0 },
    });
    expect(patch).toBeTruthy();
    expect(patch.isError).toBe(false);
    expect(Buffer.byteLength(patch.content[0].text, "utf8")).toBeLessThanOrEqual(MIN_TOOL_OUTPUT_TOKENS * 4);
    expect(readFileSync(/Full output saved to: (.+)/.exec(patch.content[0].text)![1]!.trim(), "utf8")).toBe(full);
    expect(patch.details).toEqual({ exit_code: 0 });
  });

  it("keeps a failed result failed and still bounds its text", async () => {
    const dir = tempRoot();
    const { runner } = await runnerFor({ maxTokens: MIN_TOOL_OUTPUT_TOKENS, root: dir });
    const patch = await runner.emitToolResult({
      type: "tool_result", toolName: "bash", toolCallId: "call-2", input: {},
      content: [textBlock(oversized())], isError: true, details: { exit_code: 1 },
    });
    expect(patch.isError).toBe(true);
    expect(patch.content[0].text).toContain("Full output saved to: ");
  });

  it("keeps images and structured content across the installed merge", async () => {
    const dir = tempRoot();
    const { runner } = await runnerFor({ maxTokens: MIN_TOOL_OUTPUT_TOKENS, root: dir });
    const patch = await runner.emitToolResult({
      type: "tool_result", toolName: "mixed", toolCallId: "call-3", input: {},
      content: [textBlock(oversized()), imageBlock], isError: false, details: {},
      structuredContent: { output: "structured" },
    });
    expect(patch.content[1]).toEqual(imageBlock);
    expect(patch.structuredContent).toEqual({ output: "structured" });
  });

  it("leaves a small result untouched", async () => {
    const { runner } = await runnerFor({ maxTokens: MIN_TOOL_OUTPUT_TOKENS, root: tempRoot() });
    const patch = await runner.emitToolResult({
      type: "tool_result", toolName: "read", toolCallId: "call-4", input: {},
      content: [textBlock("small")], isError: false, details: {},
    });
    expect(patch).toBeUndefined();
  });
});
