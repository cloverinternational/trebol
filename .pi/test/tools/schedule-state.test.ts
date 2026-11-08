import { afterEach, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { registerScheduleExtension } from "../../../extensions/schedule/extension.ts";

const dirs: string[] = [];
const tmp = () => { const dir = mkdtempSync(join(tmpdir(), "schedule-state-")); dirs.push(dir); return dir; };
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

it("keeps scheduled tasks in the state root, not in the workspace", async () => {
  const workDir = tmp();
  const pi = {
    getCwd: () => workDir,
    registerTool: () => undefined,
    sendUserMessage: async () => undefined,
    on: () => undefined,
  };
  const scheduler = await registerScheduleExtension(pi, { workDir });
  try {
    // The legacy default was `<workDir>/.swarm/scheduled_tasks.json`, which appeared
    // untracked in a user's repository after any `/loop` or `/goal`.
    expect(existsSync(join(workDir, ".swarm"))).toBe(false);
  } finally {
    await scheduler.stop();
  }
});

it("adopts an existing in-workspace schedule file on first start", async () => {
  const workDir = tmp();
  const { mkdirSync, writeFileSync } = await import("node:fs");
  mkdirSync(join(workDir, ".swarm"), { recursive: true });
  writeFileSync(join(workDir, ".swarm", "scheduled_tasks.json"), "[]");
  const scheduler = await registerScheduleExtension({ getCwd: () => workDir, registerTool: () => undefined, sendUserMessage: async () => undefined, on: () => undefined }, { workDir });
  try {
    expect(existsSync(join(workDir, ".swarm", "scheduled_tasks.json"))).toBe(false);
  } finally {
    await scheduler.stop();
  }
});
