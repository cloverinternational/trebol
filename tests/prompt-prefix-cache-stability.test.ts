import { describe, expect, it, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerSwarmPrompt, resetWorkspaceContextCache } from "../extensions/swarm-prompt/extension.ts";

/** Minimal Pi surface: records the middleware the extension registers for before_agent_start. */
function harness() {
  const handlers = new Map<string, (event: any, ctx?: any) => any>();
  registerSwarmPrompt({ on: (name: string, handler: (event: any, ctx?: any) => any) => handlers.set(name, handler) } as any);
  const turn = async (cwd: string, sessionId: string) => {
    const event = { systemPrompt: "", systemPromptOptions: { cwd } };
    const ctx = { cwd, hasUI: true, sessionManager: { getSessionId: () => sessionId } };
    return await handlers.get("before_agent_start")!(event, ctx);
  };
  const run = async (cwd: string, sessionId: string) => String((await turn(cwd, sessionId))?.systemPrompt ?? "");
  return Object.assign(run, { turn });
}

function gitRepo() {
  const dir = mkdtempSync(join(tmpdir(), "prompt-cache-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
  execFileSync("git", ["add", "a.ts"], { cwd: dir });
  return dir;
}

const census = (prompt: string) => /<workspace_extensions[^>]*files="(\d+)"/.exec(prompt)?.[1];

describe("system prompt keeps a byte-stable prefix while the repo file census changes", () => {


  beforeEach(() => resetWorkspaceContextCache());

  it("does not rewrite the prompt when a file is added mid-session", async () => {
    const dir = gitRepo();
    const runTurn = harness();
    const before = await runTurn(dir, "session-1");
    expect(census(before)).toBe("1");

    // A file lands in the working tree mid-session, so `git ls-files` now counts 2.
    writeFileSync(join(dir, "b.py"), "print(1)\n");
    execFileSync("git", ["add", "b.py"], { cwd: dir });

    const again = await runTurn(dir, "session-1");
    expect(census(again)).toBe("1");
    // git status + date travel in a per-prompt message, so the whole system
    // prompt is byte-identical and the provider's cached prefix survives.
    expect(again).toBe(before);
    expect(before).not.toContain("<swarmos_context>");
  });

  it("delivers git status and date as a per-prompt message that reflects repo changes", async () => {
    const dir = gitRepo();
    const runTurn = harness();
    const first = await runTurn.turn(dir, "session-1");
    expect(first.message.customType).toBe("swarm-volatile-context");
    expect(first.message.content).toContain("<swarmos_context>");
    writeFileSync(join(dir, "c.txt"), "x\n");
    const second = await runTurn.turn(dir, "session-1");
    expect(second.systemPrompt).toBe(first.systemPrompt);
    expect(second.message.content).toContain("c.txt");
    expect(first.message.content).not.toContain("c.txt");
  });

  it("re-reads the census for a new session so a later prompt is not stale", async () => {
    const dir = gitRepo();
    const runTurn = harness();
    expect(census(await runTurn(dir, "session-a"))).toBe("1");
    writeFileSync(join(dir, "b.py"), "print(1)\n");
    execFileSync("git", ["add", "b.py"], { cwd: dir });
    expect(census(await runTurn(dir, "session-b"))).toBe("2");
  });
});
