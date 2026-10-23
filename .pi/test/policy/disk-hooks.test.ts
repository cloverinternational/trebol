import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerDiskHooks } from "../../../extensions/swarm-disk-hooks/extension.ts";
import { establishedHookContext } from "../support/hook-session.ts";

describe("disk hook Pi adapter", () => {
  it("translates a blocking hook decision into Pi's tool_call contract", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-disk-hooks-"));
    const home = mkdtempSync(join(tmpdir(), "pi-disk-hooks-home-"));
    mkdirSync(join(cwd, ".claude"));
    writeFileSync(join(cwd, ".claude", "settings.json"), JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: "bash", hooks: [{ type: "command", command: "exit 2" }] }],
      },
    }));
    const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
    const pi = {
      appendEntry() {},
      on(event: string, handler: (payload: any, ctx: any) => unknown) {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      },
      registerCommand() {},
    };

    const runtime = registerDiskHooks(pi, { cwd, home });
    // Tool gates stay dormant for the first HOOK_WARMUP_TURNS turns of a session.
    const ctx = establishedHookContext();
    const decision = await handlers.get("tool_call")![0]({
      toolName: "bash",
      toolCallId: "blocked-call",
      input: { command: "echo no" },
    }, ctx);
    // Blocks gain same-step correction guidance (see hook-correction); the
    // original hook reason must remain the leading text.
    expect(decision).toMatchObject({
      block: true,
      reason: expect.stringContaining("disk hook blocked (exit 2)"),
    });
    await expect(handlers.get("tool_call")![0]({
      toolName: "read",
      toolCallId: "allowed-call",
      input: { path: "README.md" },
    }, ctx)).resolves.toBeUndefined();
  });

  it("dispatches configured lifecycle hooks", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-disk-hooks-"));
    const home = mkdtempSync(join(tmpdir(), "pi-disk-hooks-home-"));
    mkdirSync(join(cwd, ".claude"));
    writeFileSync(join(cwd, ".claude", "settings.json"), JSON.stringify({
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: "touch lifecycle-ran" }] }],
      },
    }));
    const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
    registerDiskHooks({
      appendEntry() {},
      on(event: string, handler: (payload: any, ctx: any) => unknown) {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      },
      registerCommand() {},
    }, { cwd, home });

    // The hook-correction coordinator registers its own session_start handler
    // first, so dispatch every registered handler the way Pi does.
    for (const start of handlers.get("session_start") ?? []) await start({}, {});
    expect(existsSync(join(cwd, "lifecycle-ran"))).toBe(true);
    expect(handlers.has("session_shutdown")).toBe(true);
    expect(handlers.has("before_agent_start")).toBe(true);
    expect(handlers.has("session_before_compact")).toBe(true);
  });
});
