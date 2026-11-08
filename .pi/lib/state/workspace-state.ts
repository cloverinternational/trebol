/**
 * Machine-local runtime state belongs outside the workspace.
 *
 * A harness that writes its own bookkeeping into the repository it edits produces
 * untracked files in every `git status`: `.swarm/claw/control.json`,
 * `.swarm/claw/supervisor.json`, `.swarm/claw/sessions/<uuid>.json` and similar.
 * Nothing in git ignores them in a user's checkout, and gitignoring them is the
 * wrong answer — the state is machine-local (session cursors, run logs, control
 * flags), it is not shareable, and `.swarm/` also holds user-authored inputs such
 * as `.swarm/AGENTS.md` and project skills that DO belong in the repository.
 *
 * So: user inputs stay in the workspace, runtime state lives here, keyed by
 * workspace. Existing in-repo state is adopted once, never merged blindly.
 */
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

export type Adoption = "none" | "adopted" | "conflict";

/** `$PI_SWARM_STATE_DIR`, else `$XDG_STATE_HOME/pi-swarm`, else `~/.local/state/pi-swarm`. */
export function stateRoot(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const explicit = env.PI_SWARM_STATE_DIR?.trim();
  if (explicit) return resolve(explicit);
  const xdg = env.XDG_STATE_HOME?.trim();
  return join(xdg && isAbsolute(xdg) ? xdg : join(home, ".local", "state"), "pi-swarm");
}

/** Readable label plus a path hash: two checkouts with the same name never share state. */
export function workspaceKey(workspace: string): string {
  const absolute = resolve(workspace);
  const label = basename(absolute).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "workspace";
  return `${label}-${createHash("sha256").update(absolute).digest("hex").slice(0, 12)}`;
}

/** One folder per workspace: `…/pi-swarm/workspaces/<key>[/...rest]`. */
export function workspaceStateDir(workspace: string, ...rest: string[]): string {
  return join(stateRoot(), "workspaces", workspaceKey(workspace), ...rest);
}

/**
 * Adopt a legacy in-repo directory once. Returns `conflict` when a state folder already
 * exists next to a legacy one: two live stores are never merged silently, and the legacy
 * copy is left untouched for inspection.
 */
export function adoptLegacyDir(legacy: string, next: string): Adoption {
  if (existsSync(next)) return existsSync(legacy) ? "conflict" : "none";
  if (!existsSync(legacy)) return "none";
  try { mkdirSync(dirname(next), { recursive: true, mode: 0o700 }); } catch { return "none"; }
  try { renameSync(legacy, next); return "adopted"; } catch { /* cross-device or a live holder */ }
  // Stage a copy, promote it atomically, and only then drop the original. A failed copy
  // leaves the legacy directory intact instead of a half-populated state folder.
  const staged = `${next}.migrating-${process.pid}`;
  try {
    cpSync(legacy, staged, { recursive: true });
    renameSync(staged, next);
    rmSync(legacy, { recursive: true, force: true });
    return "adopted";
  } catch {
    rmSync(staged, { recursive: true, force: true });
    return "conflict";
  }
}

/** Single-file variant of `adoptLegacyDir` (e.g. a legacy `.swarm/scheduled_tasks.json`). */
export function adoptLegacyFile(legacy: string, next: string): Adoption {
  if (existsSync(next)) return existsSync(legacy) ? "conflict" : "none";
  if (!existsSync(legacy)) return "none";
  try { mkdirSync(dirname(next), { recursive: true, mode: 0o700 }); } catch { return "none"; }
  try { renameSync(legacy, next); return "adopted"; } catch { return "conflict"; }
}
