import { execFile } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_UPDATE_URL = "https://raw.githubusercontent.com/cloverinternational/trebol/main/update-manifest.json";
export const updateUrl = () => process.env.PI_SWARM_UPDATE_URL || DEFAULT_UPDATE_URL;
export const CHECK_INTERVAL_MS = 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 5_000;
const COMMAND_TIMEOUT_MS = 5 * 60_000;
export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
function installedVersion(root = PACKAGE_ROOT): string {
  try {
    const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    return typeof packageJson.version === "string" ? packageJson.version : "0.0.0";
  } catch { return "0.0.0"; }
}
export const CURRENT_VERSION = installedVersion();

export type UpdateManifest = { schemaVersion: 1; package: string; version: string; releasedAt: string; changelog: string; source: string; updateCommand: string };
type ParsedVersion = { numbers: [number, number, number]; prerelease: string[] };

function parseVersion(value: unknown): ParsedVersion | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/.exec(value);
  return match ? { numbers: [Number(match[1]), Number(match[2]), Number(match[3])], prerelease: match[4]?.split(".") ?? [] } : undefined;
}

export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left); const b = parseVersion(right);
  if (!a || !b) throw new Error("versions must use strict semver (x.y.z)");
  for (let i = 0; i < 3; i += 1) if (a.numbers[i] !== b.numbers[i]) return a.numbers[i] > b.numbers[i] ? 1 : -1;
  if (!a.prerelease.length && !b.prerelease.length) return 0;
  if (!a.prerelease.length) return 1; if (!b.prerelease.length) return -1;
  for (let i = 0; i < Math.max(a.prerelease.length, b.prerelease.length); i += 1) {
    const av = a.prerelease[i]; const bv = b.prerelease[i];
    if (av === undefined) return -1; if (bv === undefined) return 1; if (av === bv) continue;
    const an = /^\d+$/.test(av); const bn = /^\d+$/.test(bv);
    if (an && bn) return Number(av) > Number(bv) ? 1 : -1;
    if (an !== bn) return an ? -1 : 1;
    return av > bv ? 1 : -1;
  }
  return 0;
}

export function validateManifest(value: unknown): UpdateManifest | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  if (v.schemaVersion !== 1 || v.package !== "@pi-swarm/integration" || !parseVersion(v.version)) return undefined;
  for (const key of ["releasedAt", "changelog", "source", "updateCommand"]) if (typeof v[key] !== "string" || !v[key]) return undefined;
  return v as UpdateManifest;
}

async function fetchManifest(url: string): Promise<UpdateManifest> {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`update manifest HTTP ${response.status}`);
    const manifest = validateManifest(await response.json());
    if (!manifest) throw new Error("update manifest has an invalid schema");
    return manifest;
  } finally { clearTimeout(timer); }
}

function notify(ctx: any, message: string, level: "info" | "warning" | "error" = "info") { ctx?.ui?.notify?.(message, level); }

type RunResult = { code: number; stdout: string; stderr: string };
function run(cmd: string, args: string[], cwd: string): Promise<RunResult> {
  return new Promise((done) => execFile(cmd, args, { cwd, timeout: COMMAND_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
    const code = error ? (typeof (error as any).code === "number" ? (error as any).code : 1) : 0;
    done({ code, stdout: String(stdout).trim(), stderr: (String(stderr).trim() || (error && !stdout && !stderr ? error.message : "")) });
  }));
}
const git = (root: string, ...args: string[]) => run("git", args, root);

export type InstallKind = "managed-git" | "local-checkout";
/** Pi only refreshes npm and git sources; a local-path package is skipped by `pi update`, so it must be fast-forwarded here. */
export function detectInstallKind(root = PACKAGE_ROOT, agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent")): InstallKind {
  const real = (p: string) => { try { return realpathSync(p); } catch { return resolve(p); } };
  const r = real(root); const managed = real(join(agentDir, "git")) + sep;
  return r.startsWith(managed) || r.includes(`${sep}.pi${sep}git${sep}`) ? "managed-git" : "local-checkout";
}

export type UpdateOutcome = { status: "updated" | "current" | "refused" | "failed"; message: string; from?: string; to?: string };

/** Fast-forward a local Trebol checkout to its upstream. Refuses rather than touching uncommitted or diverged work. */
export async function updateLocalCheckout(root = PACKAGE_ROOT, apply = true): Promise<UpdateOutcome> {
  if ((await git(root, "rev-parse", "--is-inside-work-tree")).stdout !== "true") return { status: "refused", message: `${root} is not a git checkout; reinstall Trebol with pi install git:github.com/cloverinternational/trebol.` };
  const upstream = await git(root, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}");
  if (upstream.code !== 0) return { status: "refused", message: `The checkout at ${root} has no upstream branch; nothing to update from.` };
  const fetched = await git(root, "fetch", "--quiet", "--no-tags", upstream.stdout.split("/")[0]);
  if (fetched.code !== 0) return { status: "failed", message: `git fetch failed: ${fetched.stderr}` };
  const from = (await git(root, "rev-parse", "HEAD")).stdout; const to = (await git(root, "rev-parse", "@{u}")).stdout;
  const [ahead, behind] = (await git(root, "rev-list", "--left-right", "--count", "HEAD...@{u}")).stdout.split(/\s+/).map(Number);
  if (!behind) return { status: "current", message: `Trebol checkout is current with ${upstream.stdout} (${from.slice(0, 7)}).`, from, to };
  if (ahead) return { status: "refused", message: `Checkout at ${root} has ${ahead} local commit(s) not on ${upstream.stdout}; rebase or merge manually.`, from, to };
  const dirty = (await git(root, "status", "--porcelain", "--untracked-files=no")).stdout;
  if (dirty) return { status: "refused", message: `Checkout at ${root} has uncommitted changes (${dirty.split("\n").length} file(s)); ${behind} commit(s) behind ${upstream.stdout}. Commit or stash, then run /trebol-update install.`, from, to };
  if (!apply) return { status: "updated", message: `${behind} commit(s) available on ${upstream.stdout}.`, from, to };
  const lockChanged = (await git(root, "diff", "--name-only", from, to, "--", "package-lock.json", "package.json")).stdout !== "";
  const merged = await git(root, "merge", "--ff-only", "--quiet", "@{u}");
  if (merged.code !== 0) return { status: "failed", message: `git merge --ff-only failed: ${merged.stderr}`, from, to };
  if (lockChanged) {
    const npm = await run(process.platform === "win32" ? "npm.cmd" : "npm", ["ci", "--no-audit", "--no-fund"], root);
    if (npm.code !== 0) return { status: "failed", message: `Updated code to ${to.slice(0, 7)} but npm ci failed: ${npm.stderr.split("\n").slice(-3).join(" ")}`, from, to };
  }
  return { status: "updated", message: `Trebol updated ${from.slice(0, 7)} → ${to.slice(0, 7)} (${behind} commit(s)${lockChanged ? ", dependencies reinstalled" : ""}).`, from, to };
}

async function updateManagedGit(root = PACKAGE_ROOT): Promise<UpdateOutcome> {
  const from = (await git(root, "rev-parse", "HEAD")).stdout;
  const result = await run("pi", ["update", "--extensions"], root);
  const to = (await git(root, "rev-parse", "HEAD")).stdout;
  if (result.code !== 0) return { status: "failed", message: `pi update --extensions exited ${result.code}: ${(result.stderr || result.stdout).split("\n").slice(-3).join(" ")}`, from, to };
  return from === to ? { status: "current", message: `pi update ran, Trebol stayed at ${to.slice(0, 7)}.`, from, to } : { status: "updated", message: `Trebol updated ${from.slice(0, 7)} → ${to.slice(0, 7)}.`, from, to };
}

export const installUpdate = (root = PACKAGE_ROOT) => detectInstallKind(root) === "managed-git" ? updateManagedGit(root) : updateLocalCheckout(root);
const autoUpdateEnabled = () => process.env.PI_SWARM_AUTO_UPDATE !== "0";

export default function swarmUpdateExtension(pi: any) {
  let lastCheck = 0; let timer: ReturnType<typeof setInterval> | undefined; let context: any; let installing: Promise<UpdateOutcome> | undefined;
  const install = (): Promise<UpdateOutcome> => installing ??= installUpdate().finally(() => { installing = undefined; });
  const check = async (force = false, ctx = context) => {
    if (!force && Date.now() - lastCheck < CHECK_INTERVAL_MS) return false;
    lastCheck = Date.now();
    if (process.env.PI_OFFLINE === "1" || process.env.PI_SWARM_SKIP_UPDATE_CHECK === "1") return false;
    try {
      const manifest = await fetchManifest(updateUrl());
      if (compareVersions(manifest.version, CURRENT_VERSION) > 0) {
        if (!force && autoUpdateEnabled()) {
          const outcome = await install();
          if (outcome.status === "updated") { notify(ctx, `${outcome.message} Trebol ${installedVersion()} is on disk; run /reload to load it.`); return true; }
          notify(ctx, `Trebol ${manifest.version} is available (installed ${CURRENT_VERSION}) but auto-update did not apply: ${outcome.message}`, "warning"); return true;
        }
        notify(ctx, `Trebol ${manifest.version} is available (installed ${CURRENT_VERSION}). Changelog: ${manifest.changelog}\nRun /trebol-update install to update.`, "warning"); return true;
      }
      if (force && detectInstallKind() === "local-checkout") {
        const pending = await updateLocalCheckout(PACKAGE_ROOT, false);
        if (pending.status === "updated") { notify(ctx, `Trebol ${CURRENT_VERSION} matches the latest release, but ${pending.message} Run /trebol-update install to fast-forward.`, "warning"); return true; }
        if (pending.status !== "current") { notify(ctx, `Trebol ${CURRENT_VERSION} matches the latest release. ${pending.message}`, "warning"); return false; }
      }
      if (force) notify(ctx, `Trebol is up to date (${CURRENT_VERSION}).`);
    } catch (error) { if (force) notify(ctx, `Could not check for Trebol updates: ${error instanceof Error ? error.message : String(error)}`, "error"); }
    return false;
  };
  const installCommand = async (ctx: any) => {
    if (process.env.PI_OFFLINE === "1") { notify(ctx, "Offline mode is enabled; update was not started.", "error"); return; }
    notify(ctx, `Updating Trebol (${detectInstallKind()} at ${PACKAGE_ROOT})…`);
    const outcome = await install();
    if (outcome.status !== "updated") { notify(ctx, outcome.message, outcome.status === "current" ? "info" : "error"); return; }
    notify(ctx, `${outcome.message} Reloading…`);
    await ctx.waitForIdle?.(); await ctx.reload?.();
  };
  pi.registerCommand?.("trebol-update", { description: "Check for or install Trebol updates", handler: async (args: string, ctx: any) => args.trim() === "install" ? installCommand(ctx) : check(true, ctx) });
  pi.on?.("session_start", (_event: any, ctx: any) => { context = ctx; if (timer) clearInterval(timer); void check(); timer = setInterval(() => void check(), CHECK_INTERVAL_MS); timer.unref?.(); });
  pi.on?.("session_shutdown", () => { if (timer) clearInterval(timer); timer = undefined; context = undefined; });
  return { checkForUpdate: check };
}
