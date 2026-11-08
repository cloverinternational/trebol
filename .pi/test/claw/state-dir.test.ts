import { afterEach, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ClawStore, clawStateDir } from "../../lib/claw/store.ts";

const dirs: string[] = [];
const tmp = (tag: string) => { const dir = mkdtempSync(join(tmpdir(), `claw-state-${tag}-`)); dirs.push(dir); return dir; };
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

it("keeps Claw state out of the workspace entirely", () => {
  const workspace = tmp("ws");
  const store = ClawStore.forWorkspace(workspace);
  expect(store.dir).toBe(clawStateDir(workspace));
  expect(store.dir.startsWith(workspace)).toBe(false);
  // The reported symptom: `.swarm/claw/{control,sessions/*}.json` in the user's `git status`.
  expect(existsSync(join(workspace, ".swarm"))).toBe(false);
});

it("adopts legacy in-repo state so in-flight runs and cursors survive the move", () => {
  const workspace = tmp("legacy");
  const legacyRun = { id: "run-abc123", label: "L", task: "t", cwd: workspace, status: "running", phase: "tab_open", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", project: "P", eventsOffset: 0, settles: 0, attempts: 0, outbox: [], seen: [] };
  mkdirSync(join(workspace, ".swarm", "claw", "runs"), { recursive: true });
  writeFileSync(join(workspace, ".swarm", "claw", "runs", "run-abc123.json"), JSON.stringify(legacyRun));

  const store = ClawStore.forWorkspace(workspace);
  expect(store.getRun("run-abc123")?.id).toBe("run-abc123");
  expect(store.listRuns().map((run) => run.id)).toEqual(["run-abc123"]);
  expect(existsSync(join(workspace, ".swarm", "claw"))).toBe(false);
});

it("keeps two workspaces on separate stores", () => {
  const a = ClawStore.forWorkspace(tmp("a")), b = ClawStore.forWorkspace(tmp("b"));
  expect(a.dir).not.toBe(b.dir);
});
