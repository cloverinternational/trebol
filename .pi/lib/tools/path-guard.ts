import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

export function resolvePathForCheck(path: string): string {
  const cleaned = resolve(path);
  try { return realpathSync(cleaned); } catch (e: any) { if (e?.code !== "ENOENT") throw e; }
  let current = cleaned;
  for (;;) {
    try {
      statSync(current);
      const root = realpathSync(current);
      return current === cleaned ? root : resolve(root, relative(current, cleaned));
    } catch (e: any) { if (e?.code !== "ENOENT") throw e; }
    const parent = dirname(current);
    if (parent === current) return cleaned;
    current = parent;
  }
}

export function pathWithinRoot(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${"/"}`) && !isAbsolute(rel));
}

export function checkAllowedPath(path: string, allowedPaths: readonly string[]): string | undefined {
  if (allowedPaths.length === 0) return undefined;
  let target: string;
  try { target = resolvePathForCheck(path); } catch (e) { return `failed to resolve path: ${String((e as Error).message ?? e)}`; }
  for (const allowed of allowedPaths) {
    if (!allowed) continue;
    try { if (pathWithinRoot(resolvePathForCheck(resolve(allowed)), target)) return undefined; } catch { /* skip invalid roots */ }
  }
  return `Path not allowed (not_allowed): ${path}`;
}

export function defaultAllowedPaths(workspaceRoot: string, home: string): string[] {
  return [resolve(workspaceRoot), "/tmp", resolve(home, ".swarmos")];
}

export function isExistingDirectory(path: string): boolean {
  try { return existsSync(path) && lstatSync(path).isDirectory(); } catch { return false; }
}
