// True differential driver: the same case runs through the pinned upstream oracle
// (artifacts/patch-parity/codex, built --locked) and through Trebol's implementation.
// Compared: outcome class (applied | rejected-before-write | failed-during-write) and the
// complete final tree (bytes, modes, symlink targets). Upstream source: openai/codex
// @ 430a16799d90e296fb27b1e94f206023902b7e56 (Apache-2.0; see NOTICE in fixtures/).
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, lstatSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { applyPatch, applyPatchStandalone, ApplyPatchExecutionError } from "../../../.pi/lib/tools/swarm-apply-patch.ts";

export const UPSTREAM_SHA = "430a16799d90e296fb27b1e94f206023902b7e56";

/** Entry kinds: string = UTF-8 file, {bytes} = raw file, {text,mode} = mode-set file, {link} = symlink, {dir} = directory. */
export type Entry = string | { bytes: number[] } | { text: string; mode: number } | { link: string } | { dir: true };
export interface DiffCase { name: string; files: Record<string, Entry>; patch: string[] | string }

const BEGIN = "*** Begin Patch", END = "*** End Patch";
const p = (...lines: string[]) => [BEGIN, ...lines, END].join("\n");

/** Placeholders: __WS__ = basename of the working root, __ROOT__ = absolute working root. */
export const CASES: DiffCase[] = [
  { name: "self-move-same-path", files: { "a.txt": "one\n" }, patch: p("*** Update File: a.txt", "*** Move to: a.txt", "-one", "+two") },
  { name: "self-move-dot-spelling", files: { "dir/a.txt": "one\n" }, patch: p("*** Update File: dir/a.txt", "*** Move to: ./dir/a.txt", "-one", "+two") },
  { name: "path-heal-relative-prefix", files: { "file.txt": "x\n" }, patch: p("*** Update File: __WS__/file.txt", "-x", "+y") },
  { name: "path-heal-add-prefix", files: {}, patch: p("*** Add File: __WS__/new.txt", "+hi") },
  { name: "absolute-path-update", files: { "file.txt": "x\n" }, patch: p("*** Update File: __ROOT__/file.txt", "-x", "+y") },
  { name: "mixed-lf-crlf-context", files: { "m.txt": "a\r\nb\nc\r\n" }, patch: p("*** Update File: m.txt", "@@", " a", "-b", "+B", " c") },
  { name: "lone-cr-endings", files: { "c.txt": "a\rb\rc\r" }, patch: p("*** Update File: c.txt", "-b", "+B") },
  { name: "no-final-newline", files: { "n.txt": "a\nb" }, patch: p("*** Update File: n.txt", "-b", "+c") },
  { name: "bom-first-line-change", files: { "bom.txt": "\uFEFFa\nb\n" }, patch: p("*** Update File: bom.txt", "@@", "-\uFEFFa", "+z") },
  { name: "bom-plain-update", files: { "bom.txt": "\uFEFFa\nb\n" }, patch: p("*** Update File: bom.txt", "-b", "+c") },
  { name: "invalid-utf8-update", files: { "bad.txt": { bytes: [0x61, 0x0a, 0xff, 0x0a] } }, patch: p("*** Update File: bad.txt", "-a", "+b") },
  { name: "invalid-utf8-delete", files: { "bad.txt": { bytes: [0x61, 0xff] } }, patch: p("*** Delete File: bad.txt") },
  { name: "invalid-utf8-untouched-by-add", files: { "bad.txt": { bytes: [0xff] } }, patch: p("*** Add File: bad.txt", "+ok") },
  { name: "symlink-update-through-link", files: { "target.txt": "one\n", "link.txt": { link: "target.txt" } }, patch: p("*** Update File: link.txt", "-one", "+two") },
  { name: "symlink-delete-link", files: { "target.txt": "one\n", "link.txt": { link: "target.txt" } }, patch: p("*** Delete File: link.txt") },
  { name: "symlink-move-source", files: { "target.txt": "one\n", "link.txt": { link: "target.txt" } }, patch: p("*** Update File: link.txt", "*** Move to: moved.txt", "-one", "+two") },
  { name: "symlink-dir-ancestor-add", files: { "real": { dir: true }, "d": { link: "real" } }, patch: p("*** Add File: d/new.txt", "+x") },
  { name: "symlink-dangling-update", files: { "link.txt": { link: "missing.txt" } }, patch: p("*** Update File: link.txt", "+x") },
  { name: "mode-preserved-update", files: { "x.sh": { text: "one\n", mode: 0o755 } }, patch: p("*** Update File: x.sh", "-one", "+two") },
  { name: "mode-preserved-move", files: { "x.sh": { text: "one\n", mode: 0o755 } }, patch: p("*** Update File: x.sh", "*** Move to: y.sh", "-one", "+two") },
  { name: "add-over-executable", files: { "x.sh": { text: "one\n", mode: 0o755 } }, patch: p("*** Add File: x.sh", "+new") },
  { name: "exec-failure-keeps-earlier-write", files: { "a.txt": "one\n", "blocker": "file" }, patch: p("*** Update File: a.txt", "-one", "+two", "*** Add File: blocker/new.txt", "+x") },
  { name: "exec-failure-first-op", files: { "blocker": "file" }, patch: p("*** Add File: blocker/new.txt", "+x") },
  { name: "exec-add-over-directory", files: { "dir": { dir: true } }, patch: p("*** Add File: dir", "+x") },
  { name: "duplicate-dot-alias", files: { "a.txt": "one\n" }, patch: p("*** Update File: a.txt", "-one", "+two", "*** Update File: ./a.txt", "-two", "+three") },
  { name: "duplicate-symlink-alias", files: { "a.txt": "one\n", "link.txt": { link: "a.txt" } }, patch: p("*** Update File: a.txt", "-one", "+two", "*** Update File: link.txt", "-two", "+three") },
  { name: "delete-then-add-same-path", files: { "a.txt": "one\n" }, patch: p("*** Delete File: a.txt", "*** Add File: a.txt", "+x") },
  { name: "move-overwrites-existing-dest", files: { "a.txt": "one\n", "b.txt": "old\n" }, patch: p("*** Update File: a.txt", "*** Move to: b.txt", "-one", "+two") },
  { name: "move-creates-missing-dirs", files: { "a.txt": "one\n" }, patch: p("*** Update File: a.txt", "*** Move to: nested/new/b.txt", "-one", "+two") },
  { name: "move-into-file-dir-fails", files: { "a.txt": "one\n", "blocker": "file" }, patch: p("*** Update File: a.txt", "*** Move to: blocker/x.txt", "-one", "+two") },
  { name: "empty-patch", files: {}, patch: p() },
  { name: "pure-addition-empty-file", files: { "e.txt": "" }, patch: p("*** Update File: e.txt", "+x") },
  { name: "crlf-patch-text-lf-file", files: { "f.txt": "a\nb\n" }, patch: [BEGIN, "*** Update File: f.txt", "-b", "+B", END].join("\r\n") },
  { name: "unicode-punctuation-match", files: { "u.txt": "\u201cquoted\u201d\n" }, patch: p("*** Update File: u.txt", '-"quoted"', "+x") },
  { name: "missing-update-source", files: {}, patch: p("*** Update File: nope.txt", "-x", "+y") },
  { name: "context-mismatch-rejects", files: { "a.txt": "one\n" }, patch: p("*** Update File: a.txt", "-zzz", "+y") },
  { name: "delete-directory", files: { "dir": { dir: true }, "dir/f.txt": "x\n" }, patch: p("*** Delete File: dir") },
  { name: "delete-symlink-to-dir", files: { "real": { dir: true }, "real/f.txt": "x\n", "d": { link: "real" } }, patch: p("*** Delete File: d") },
  { name: "dotdot-normalised-update", files: { "a.txt": "one\n" }, patch: p("*** Update File: sub/../a.txt", "-one", "+two") },
  { name: "move-through-symlinked-dir", files: { "a.txt": "one\n", "real": { dir: true }, "d": { link: "real" } }, patch: p("*** Update File: a.txt", "*** Move to: d/moved.txt", "-one", "+two") },
  { name: "add-over-symlink-file", files: { "target.txt": "old\n", "link.txt": { link: "target.txt" } }, patch: p("*** Add File: link.txt", "+new") },
  { name: "add-through-dangling-symlink", files: { "dangle": { link: "made.txt" } }, patch: p("*** Add File: dangle", "+new") },
  { name: "self-move-through-symlink", files: { "target.txt": "one\n", "link.txt": { link: "target.txt" } }, patch: p("*** Update File: link.txt", "*** Move to: link.txt", "-one", "+two") },
  { name: "move-onto-executable-dest", files: { "a.txt": "one\n", "x.sh": { text: "old\n", mode: 0o755 } }, patch: p("*** Update File: a.txt", "*** Move to: x.sh", "-one", "+two") },
  { name: "move-dest-is-directory-exec-failure", files: { "a.txt": "one\n", "dir": { dir: true } }, patch: p("*** Update File: a.txt", "*** Move to: dir", "-one", "+two") },
  { name: "two-chunks-second-missing-rejects", files: { "a.txt": "one\ntwo\n" }, patch: p("*** Update File: a.txt", "-one", "+1", "@@", "-nine", "+9") },
  { name: "anchor-missing-rejects", files: { "a.txt": "one\n" }, patch: p("*** Update File: a.txt", "@@ nothere", "-one", "+two") },
  { name: "eof-marker-no-final-newline", files: { "t.txt": "x\ny" }, patch: p("*** Update File: t.txt", "-y", "+z", "*** End of File") },
  { name: "trailing-whitespace-tolerant-match", files: { "w.txt": "one   \n" }, patch: p("*** Update File: w.txt", "-one", "+two") },
  { name: "move-source-symlink-dest-existing", files: { "target.txt": "one\n", "link.txt": { link: "target.txt" }, "b.txt": "old\n" }, patch: p("*** Update File: link.txt", "*** Move to: b.txt", "-one", "+two") },
  { name: "exec-failure-after-move-source-kept", files: { "a.txt": "one\n", "dir": { dir: true } }, patch: p("*** Add File: z.txt", "+z", "*** Update File: a.txt", "*** Move to: dir", "-one", "+two") },
];

export interface Tree { [rel: string]: string }
/** Full observable state: bytes+mode for files, target for symlinks; excludes Trebol's own .swarm store. */
export function treeState(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (dir === root && name === ".swarm") continue;
      const abs = join(dir, name), rel = abs.slice(root.length + 1), st = lstatSync(abs);
      if (st.isSymbolicLink()) out.set(rel, `link:${readlinkSync(abs)}`);
      else if (st.isDirectory()) walk(abs);
      else out.set(rel, `file:${(st.mode & 0o777).toString(8)}:${readFileSync(abs).toString("base64")}`);
    }
  };
  walk(root);
  return out;
}

export function materialize(root: string, files: Record<string, Entry>) {
  for (const [rel, entry] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    if (typeof entry === "string") writeFileSync(abs, entry);
    else if ("bytes" in entry) writeFileSync(abs, Buffer.from(entry.bytes));
    else if ("text" in entry) { writeFileSync(abs, entry.text); chmodSync(abs, entry.mode); }
    else if ("link" in entry) symlinkSync(entry.link, abs);
    else mkdirSync(abs, { recursive: true });
  }
}

const sub = (text: string, root: string) => text.replaceAll("__ROOT__", root).replaceAll("__WS__", basename(root));
export const patchText = (c: DiffCase) => (Array.isArray(c.patch) ? c.patch.join("\n") : c.patch);

export type Outcome = "applied" | "rejected" | "failed";

/** Oracle agent path: exit 0 applied, 3 verification rejected (no writes), 1 execution failure. */
export function runAgentOracle(bin: string, root: string, patch: string): Outcome {
  const pf = join(dirname(root), "patch.txt");
  writeFileSync(pf, patch);
  const r = spawnSync(bin, [root, pf], { encoding: "utf8" });
  rmSync(pf, { force: true });
  if (r.status === 0) return "applied";
  if (r.status === 3) return "rejected";
  if (r.status === 1) return "failed";
  throw new Error(`oracle exited ${r.status}: ${r.stderr}`);
}

/** Oracle writer path: the upstream apply_patch executable (no up-front verification). */
export function runWriterOracle(bin: string, root: string, patch: string): Outcome {
  const r = spawnSync(bin, [patch], { cwd: root, encoding: "utf8" });
  if (r.status === 0) return "applied";
  if (r.status === 1) return "failed";
  throw new Error(`writer exited ${r.status}: ${r.stderr}`);
}

export async function runTrebol(mode: "agent" | "writer", root: string, patch: string): Promise<Outcome> {
  try {
    if (mode === "agent") await applyPatch(patch, { workspacePath: root });
    else await applyPatchStandalone(patch, { workspacePath: root });
    return "applied";
  } catch (e) {
    if (mode === "writer" || e instanceof ApplyPatchExecutionError) return "failed";
    return "rejected";
  }
}

export interface DiffResult { name: string; mode: "agent" | "writer"; match: boolean; oracle: Outcome; trebol: Outcome; treeDiff: string[] }

export async function compareCase(c: DiffCase, mode: "agent" | "writer", oracleBin: string): Promise<DiffResult> {
  const base = mkdtempSync(join(tmpdir(), "trebol-diff-"));
  // Both sides share the basename "ws" so __WS__ resolves identically.
  const ro = join(base, "oracle", "ws"), rt = join(base, "trebol", "ws");
  mkdirSync(ro, { recursive: true }); mkdirSync(rt, { recursive: true });
  try {
    materialize(ro, c.files); materialize(rt, c.files);
    const oPatch = sub(patchText(c), ro), tPatch = sub(patchText(c), rt);
    const oOutcome = mode === "agent" ? runAgentOracle(oracleBin, ro, oPatch) : runWriterOracle(process.env.CODEX_APPLY_PATCH_BIN!, ro, oPatch);
    const tOutcome = await runTrebol(mode, rt, tPatch);
    const oState = treeState(ro), tState = treeState(rt);
    const keys = [...new Set([...oState.keys(), ...tState.keys()])].sort();
    const treeDiff = keys.filter(k => oState.get(k) !== tState.get(k)).map(k =>
      oState.has(k) ? (tState.has(k) ? `differs ${k}: oracle=${oState.get(k)!.slice(0, 80)} trebol=${tState.get(k)!.slice(0, 80)}` : `trebol missing ${k}`) : `trebol extra ${k}`);
    return { name: c.name, mode, match: oOutcome === tOutcome && treeDiff.length === 0, oracle: oOutcome, trebol: tOutcome, treeDiff };
  } finally { rmSync(base, { recursive: true, force: true }); }
}

async function main() {
  const oracleBin = process.env.CODEX_TREBOL_ORACLE_BIN;
  const writerBin = process.env.CODEX_APPLY_PATCH_BIN;
  if (!oracleBin || !writerBin) {
    console.log(JSON.stringify({ upstream: UPSTREAM_SHA, oracle: "BLOCKED", reason: "set CODEX_TREBOL_ORACLE_BIN and CODEX_APPLY_PATCH_BIN" }));
    process.exitCode = 2; return;
  }
  const results: DiffResult[] = [];
  for (const c of CASES) {
    results.push(await compareCase(c, "agent", resolve(oracleBin)));
    results.push(await compareCase(c, "writer", resolve(oracleBin)));
  }
  const mismatches = results.filter(r => !r.match);
  console.log(JSON.stringify({ upstream: UPSTREAM_SHA, cases: CASES.length, comparisons: results.length, mismatches }, null, 2));
  process.exitCode = mismatches.length ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) await main();
