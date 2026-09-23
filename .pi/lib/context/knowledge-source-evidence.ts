import { realpathSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { redactKnowledge } from "../state/knowledge-store.ts";

const MAX_BYTES = 1_000_000, MAX_LINES = 35, MAX_SOURCES = 4;
/** Open only already-cited workspace line ranges. This is source material for
 * the read-only agent, not a claim that a TaskManage answer was verified. */
export function readCitedImplementation(cwd: string, evidence: readonly { ref: string }[]) {
  const workspace = realpathSync(cwd);
  const excerpts: Array<{ ref: string; excerpt: string; state: "current" }> = [];
  for (const item of evidence.slice(0, 16)) {
    if (excerpts.length >= MAX_SOURCES) break;
    const match = /^([^#;\n]+)#L([1-9]\d*)(?:-L?([1-9]\d*))?$/.exec(item.ref.trim());
    if (!match) continue;
    const [, relativePath, startText, endText] = match;
    if (isAbsolute(relativePath)) continue;
    const start = Number(startText), end = Number(endText ?? startText);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start || end - start + 1 > MAX_LINES) continue;
    try {
      const path = realpathSync(resolve(workspace, relativePath));
      const within = relative(workspace, path);
      if (!within || within === ".." || within.startsWith("../") || isAbsolute(within) ||
        /^(?:\.git|\.swarm|\.swarmpi|\.pi\/agent-sessions)(?:\/|$)/.test(within) ||
        !/\.(?:ts|tsx|js|mjs|cjs|md|py|go)$/.test(within)) continue;
      const stat = statSync(path);
      if (!stat.isFile() || stat.size > MAX_BYTES) continue;
      const lines = readFileSync(path, "utf8").split(/\r?\n/);
      if (end > lines.length) continue;
      excerpts.push({ ref: item.ref, state: "current", excerpt: redactKnowledge(lines.slice(start - 1, end).map((line, index) => `L${start + index}: ${line}`).join("\n")).slice(0, 4000) });
    } catch { /* missing or changed citations are not read as current proof */ }
  }
  return excerpts;
}
