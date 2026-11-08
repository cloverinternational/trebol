/** Temporary, best-effort local diagnostics. Never pass raw prompts or credentials. */
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, readdirSync, statSync, unlinkSync, lstatSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";

// These records serve harness support, not the project being worked on, so they are
// opt-in and never written into a working tree. The previous location was
// `<git toplevel>/.swarmpi/<area>/`, which created one untracked file per captured
// memory candidate inside whatever repository Pi happened to run in: invisible here
// (this repo's `.gitignore` lists `.swarmpi/`) and plain spam in everyone else's
// `git status`. Set PI_SWARM_DIAGNOSTICS=1 to collect them.
const TRUTHY = /^(1|on|true|yes)$/i;

export type ExecutionLogArea = "execution" | "jev";

export function diagnosticsEnabled(): boolean {
  return TRUTHY.test(process.env.PI_SWARM_DIAGNOSTICS?.trim() ?? "");
}

/**
 * `$PI_SWARM_DIAGNOSTICS_DIR`, else `$XDG_STATE_HOME/pi-swarm/diagnostics`, else
 * `~/.local/state/pi-swarm/diagnostics`. The per-user state directory is the documented
 * owner of machine-local runtime state (`docs/reference/install-layout.md`).
 */
export function diagnosticsRoot(): string {
  const override = process.env.PI_SWARM_DIAGNOSTICS_DIR?.trim();
  if (override) return resolve(override);
  const state = process.env.XDG_STATE_HOME?.trim();
  return join(state && isAbsolute(state) ? state : join(homedir(), ".local", "state"), "pi-swarm", "diagnostics");
}

/** Readable workspace label plus a path hash, so same-named checkouts never share one folder. */
function workspaceKey(root: string): string {
  const label = basename(root).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "workspace";
  return `${label}-${createHash("sha256").update(root).digest("hex").slice(0, 12)}`;
}

export function executionLog(cwd: string, area: ExecutionLogArea, event: string, data: Record<string, unknown>): string | undefined {
  if (!diagnosticsEnabled()) return undefined;
  try {
    let root=resolve(cwd);
    try { root=execFileSync("git",["-C",root,"rev-parse","--show-toplevel"],{encoding:"utf8",stdio:["ignore","pipe","ignore"]}).trim() || root; } catch {}
    const base=join(diagnosticsRoot(),workspaceKey(root)), dir=join(base,area);
    for(const path of [base,dir]) { mkdirSync(path,{recursive:true,mode:0o700}); if(lstatSync(path).isSymbolicLink()) return; }
    // Seven days, at most 500 records per category. Small metadata only.
    const files=readdirSync(dir).filter(n=>/^\d+-[a-f0-9-]+\.json$/.test(n)).sort();
    for(const [i,name] of files.entries()) if(i<files.length-499 || Date.now()-statSync(join(dir,name)).mtimeMs>7*86400000) unlinkSync(join(dir,name));
    const path=join(dir,`${Date.now()}-${randomUUID()}.json`);
    const body=JSON.stringify({version:1,at:new Date().toISOString(),event,workspace:root,...data},null,2);
    if(Buffer.byteLength(body)>32768) return;
    writeFileSync(path,body+"\n",{mode:0o600,flag:"wx"}); return path;
  } catch { return undefined; } // Diagnostics cannot break execution.
}
