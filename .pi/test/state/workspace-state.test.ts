import { afterEach, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  adoptLegacyDir, adoptLegacyFile, stateRoot, workspaceKey, workspaceStateDir, type Adoption,
} from "../../lib/state/workspace-state.ts";

const roots: string[] = [];
const tmp = (tag: string) => { const dir = mkdtempSync(join(tmpdir(), `ws-state-${tag}-`)); roots.push(dir); return dir; };
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

it("resolves the state root from PI_SWARM_STATE_DIR, then XDG_STATE_HOME, then the home default", () => {
  expect(stateRoot({ PI_SWARM_STATE_DIR: "/explicit", XDG_STATE_HOME: "/xdg" }, "/home/u")).toBe("/explicit");
  expect(stateRoot({ XDG_STATE_HOME: "/xdg" }, "/home/u")).toBe("/xdg/pi-swarm");
  expect(stateRoot({}, "/home/u")).toBe("/home/u/.local/state/pi-swarm");
  // A relative XDG_STATE_HOME is not a valid base directory; fall back instead of writing under cwd.
  expect(stateRoot({ XDG_STATE_HOME: "relative/dir" }, "/home/u")).toBe("/home/u/.local/state/pi-swarm");
});

it("keys state by full path, so two checkouts with the same name never share a folder", () => {
  const a = workspaceKey("/work/one/app"), b = workspaceKey("/work/two/app");
  expect(a).not.toBe(b);
  expect(a.startsWith("app-")).toBe(true);
  expect(workspaceKey("/work/one/app")).toBe(a);
  expect(workspaceStateDir("/work/one/app", "claw")).toMatch(/\/workspaces\/app-[a-f0-9]{12}\/claw$/);
});

it("adopts a legacy in-repo directory once and leaves it alone afterwards", () => {
  const workspace = tmp("legacy"), legacy = join(workspace, ".swarm", "claw"), next = join(tmp("state"), "claw");
  mkdirSync(join(legacy, "runs"), { recursive: true });
  writeFileSync(join(legacy, "runs", "run-abc.json"), JSON.stringify({ id: "run-abc" }));

  expect(adoptLegacyDir(legacy, next)).toBe<Adoption>("adopted");
  expect(readFileSync(join(next, "runs", "run-abc.json"), "utf8")).toContain("run-abc");
  expect(existsSync(legacy)).toBe(false);
  expect(adoptLegacyDir(legacy, next)).toBe<Adoption>("none");
});

it("never merges into an existing state folder; the legacy copy stays for inspection", () => {
  const workspace = tmp("conflict"), legacy = join(workspace, ".swarm", "claw"), next = join(tmp("state"), "claw");
  mkdirSync(legacy, { recursive: true });
  writeFileSync(join(legacy, "control.json"), "{}");
  mkdirSync(next, { recursive: true });
  writeFileSync(join(next, "control.json"), "{\"enabled\":true}");

  expect(adoptLegacyDir(legacy, next)).toBe<Adoption>("conflict");
  expect(readFileSync(join(next, "control.json"), "utf8")).toBe("{\"enabled\":true}");
  expect(existsSync(join(legacy, "control.json"))).toBe(true);
});

it("adopts a legacy single file (scheduled tasks) without touching an existing target", () => {
  const workspace = tmp("file"), legacy = join(workspace, ".swarm", "scheduled_tasks.json"), next = join(tmp("state"), "scheduled_tasks.json");
  mkdirSync(join(workspace, ".swarm"), { recursive: true });
  writeFileSync(legacy, "{\"tasks\":[]}");
  expect(adoptLegacyFile(legacy, next)).toBe<Adoption>("adopted");
  expect(readFileSync(next, "utf8")).toBe("{\"tasks\":[]}");
  expect(adoptLegacyFile(legacy, next)).toBe<Adoption>("none");
});
