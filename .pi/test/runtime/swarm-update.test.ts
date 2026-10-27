import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { compareVersions, validateManifest, CURRENT_VERSION, detectInstallKind, updateLocalCheckout } from "../../../extensions/swarm-update/extension.ts";

describe("swarm update metadata", () => {
  it("reads the version from this checkout after extension relocation", () => {
    const pkg = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8"));
    expect(CURRENT_VERSION).toBe(pkg.version);
  });
  it("compares release and prerelease versions", () => {
    expect(compareVersions("1.2.0", "1.1.9")).toBe(1);
    expect(compareVersions("1.0.0", "1.0.0-rc.1")).toBe(1);
    expect(compareVersions("1.0.0-rc.2", "1.0.0-rc.10")).toBe(-1);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
  });

  it("accepts only the documented manifest shape", () => {
    const value = { schemaVersion: 1, package: "@pi-swarm/integration", version: "1.2.3", releasedAt: "2026-01-01T00:00:00Z", changelog: "https://example.test/changelog", source: "git:github.com/example/repo@main", updateCommand: "pi update --extensions" };
    expect(validateManifest(value)).toEqual(value);
    expect(validateManifest({ ...value, version: "latest" })).toBeUndefined();
    expect(validateManifest({ ...value, schemaVersion: 2 })).toBeUndefined();
  });
});

describe("swarm update extension", () => {
  it("checks at startup and does not check again before the hourly interval", async () => {
    vi.stubEnv("PI_SWARM_AUTO_UPDATE", "0");
    const nextVersion = CURRENT_VERSION.split(".").map(Number); nextVersion[1] += 1; nextVersion[2] = 0;
    const newer = nextVersion.join(".");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ schemaVersion: 1, package: "@pi-swarm/integration", version: newer, releasedAt: "2026-01-01T00:00:00Z", changelog: "https://example.test/changelog", source: "git:github.com/example/repo@main", updateCommand: "pi update --extensions" }) }));
    const handlers = new Map<string, (event: unknown, ctx: any) => void>(); const commands = new Map<string, any>(); const notify = vi.fn();
    const pi = { on: (event: string, handler: any) => handlers.set(event, handler), registerCommand: (name: string, command: any) => commands.set(name, command) };
    const extension = (await import("../../../extensions/swarm-update/extension.ts")).default(pi);
    const ctx = { ui: { notify } }; handlers.get("session_start")?.({}, ctx); await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetch).toHaveBeenCalledTimes(1); expect(notify).toHaveBeenCalledWith(expect.stringContaining(newer), "warning");
    await extension.checkForUpdate(); expect(fetch).toHaveBeenCalledTimes(1);
    handlers.get("session_shutdown")?.({}, ctx); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  });
});

describe("installing an update into a real git checkout", () => {
  const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();
  function fixture() {
    const dir = mkdtempSync(join(tmpdir(), "trebol-update-"));
    const origin = join(dir, "origin.git"); const seed = join(dir, "seed"); const installed = join(dir, "installed");
    sh(dir, "init", "-q", "--bare", "-b", "main", origin); sh(dir, "clone", "-q", origin, seed);
    writeFileSync(join(seed, "file.txt"), "v1\n"); sh(seed, "add", "."); sh(seed, "commit", "-qm", "v1"); sh(seed, "push", "-q", "origin", "main");
    sh(dir, "clone", "-q", origin, installed);
    writeFileSync(join(seed, "file.txt"), "v2\n"); sh(seed, "commit", "-qam", "v2"); sh(seed, "push", "-q", "origin", "main");
    return { dir, seed, installed, release: sh(seed, "rev-parse", "HEAD") };
  }

  it("fast-forwards a clean local checkout to the upstream commit", async () => {
    const f = fixture();
    try {
      const outcome = await updateLocalCheckout(f.installed);
      expect(outcome.status).toBe("updated");
      expect(sh(f.installed, "rev-parse", "HEAD")).toBe(f.release);
      expect(readFileSync(join(f.installed, "file.txt"), "utf8")).toBe("v2\n");
      expect((await updateLocalCheckout(f.installed)).status).toBe("current");
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it("refuses to touch uncommitted or diverged work", async () => {
    const f = fixture();
    try {
      const before = sh(f.installed, "rev-parse", "HEAD");
      writeFileSync(join(f.installed, "file.txt"), "local edit\n");
      expect((await updateLocalCheckout(f.installed)).status).toBe("refused");
      expect(sh(f.installed, "rev-parse", "HEAD")).toBe(before);
      expect(readFileSync(join(f.installed, "file.txt"), "utf8")).toBe("local edit\n");
      sh(f.installed, "commit", "-qam", "local commit");
      const diverged = await updateLocalCheckout(f.installed);
      expect(diverged.status).toBe("refused"); expect(diverged.message).toContain("local commit");
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it("tells pi-managed git clones from local-path checkouts", () => {
    const agent = mkdtempSync(join(tmpdir(), "trebol-agent-")); const clone = join(agent, "git", "github.com", "o", "trebol"); mkdirSync(clone, { recursive: true });
    try {
      expect(detectInstallKind(clone, agent)).toBe("managed-git");
      expect(detectInstallKind(tmpdir(), agent)).toBe("local-checkout");
    } finally { rmSync(agent, { recursive: true, force: true }); }
  });
});
