/** Temporary, best-effort local diagnostics. Never pass raw prompts or credentials. */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, readdirSync, statSync, unlinkSync, lstatSync } from "node:fs";
import { join, resolve } from "node:path";
export function executionLog(cwd: string, area: "execution" | "jev", event: string, data: Record<string, unknown>): string | undefined {
  try {
    let root=resolve(cwd);
    try { root=execFileSync("git",["-C",root,"rev-parse","--show-toplevel"],{encoding:"utf8",stdio:["ignore","pipe","ignore"]}).trim(); } catch {}
    const base=join(root,".swarmpi"), dir=join(base,area);
    for(const path of [base,dir]) { mkdirSync(path,{recursive:true,mode:0o700}); if(lstatSync(path).isSymbolicLink()) return; }
    // Seven days, at most 500 records per category. Small metadata only.
    const files=readdirSync(dir).filter(n=>/^\d+-[a-f0-9-]+\.json$/.test(n)).sort();
    for(const [i,name] of files.entries()) if(i<files.length-499 || Date.now()-statSync(join(dir,name)).mtimeMs>7*86400000) unlinkSync(join(dir,name));
    const path=join(dir,`${Date.now()}-${randomUUID()}.json`);
    const body=JSON.stringify({version:1,at:new Date().toISOString(),event,...data},null,2);
    if(Buffer.byteLength(body)>32768) return;
    writeFileSync(path,body+"\n",{mode:0o600,flag:"wx"}); return path;
  } catch { return undefined; } // Diagnostics cannot break execution.
}
