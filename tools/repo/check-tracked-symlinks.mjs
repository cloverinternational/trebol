#!/usr/bin/env node
/**
 * Fail when a tracked symlink points outside its own checkout.
 *
 * Why: commit 3746215 (PR #338) tracked `node_modules` as a symlink to the
 * absolute path `/Users/swarm/Work/Clover/trebol/node_modules`. Git stores a
 * symlink as its target string, so every clone and every `git worktree add`
 * materialized a link into ONE machine's directory: in a fresh clone it
 * dangles, and in the checkout that owned the target it replaced the real
 * dependency directory with a self-referential link. The Claw daemon then died
 * with `Cannot find package 'croner'`, and the restored directory read as
 * `D node_modules`, which the launch gate reports as a modified source
 * checkout.
 *
 * `.gitignore` can only hide what is not already tracked, so this check is the
 * actual guard: it reads the index, not the working tree, and needs no
 * installed dependencies.
 *
 * Usage:
 *   node tools/repo/check-tracked-symlinks.mjs [--root <path>]
 *
 * Fails (exit 1) for a tracked symlink whose stored target is:
 *   - absolute (`/…`, `~…`, or a Windows drive/UNC path) -- it names one
 *     machine's filesystem, so it is wrong everywhere else; or
 *   - relative but resolving above the repository root -- the same breakage
 *     with extra steps.
 * A target inside the checkout is reported as ok.
 */
import { spawnSync } from "node:child_process";
import { isAbsolute, resolve, relative, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(name);
  return i === -1 || i === argv.length - 1 ? fallback : argv[i + 1];
};
const ROOT = resolve(opt("--root", resolve(dirname(fileURLToPath(import.meta.url)), "..", "..")));

/** Windows paths are absolute to git even when git itself is not sure of the drive. */
const ABSOLUTE_TARGET = [/^\//, /^[A-Za-z]:[\\/]/, /^\\\\/, /^~/];

function git(args, encoding = "utf8") {
  const result = spawnSync("git", args, { cwd: ROOT, encoding, maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw new Error(`git ${args.join(" ")} failed: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${(result.stderr ?? "").trim()}`);
  return result.stdout;
}

/** `git ls-files -s -z` -> [{ mode, sha, path }] for mode 120000 entries only. */
function trackedSymlinks() {
  return git(["ls-files", "-s", "-z"])
    .split("\0")
    .filter(Boolean)
    .map((record) => {
      const tab = record.indexOf("\t");
      const [mode, sha] = record.slice(0, tab).split(" ");
      return { mode, sha, path: record.slice(tab + 1) };
    })
    .filter((entry) => entry.mode === "120000");
}

/** The blob content of a symlink is its target string, verbatim, with no trailing newline. */
function targetOf(sha) {
  return git(["cat-file", "blob", sha]);
}

const failures = [];
const checked = [];
for (const entry of trackedSymlinks()) {
  const target = targetOf(entry.sha);
  const absolute = ABSOLUTE_TARGET.some((pattern) => pattern.test(target)) || isAbsolute(target);
  if (absolute) {
    failures.push({ path: entry.path, target, reason: "absolute target" });
    continue;
  }
  // A relative target is fine only while it stays inside this checkout.
  const resolved = resolve(dirname(join(ROOT, entry.path)), target);
  const inside = !relative(ROOT, resolved).startsWith("..") && !isAbsolute(relative(ROOT, resolved));
  if (!inside) {
    failures.push({ path: entry.path, target, reason: `escapes the checkout (resolves to ${resolved})` });
    continue;
  }
  checked.push({ path: entry.path, target });
}

for (const link of checked) console.log(`ok   ${link.path} -> ${link.target} (inside the checkout)`);
for (const failure of failures) {
  console.error(`FAIL ${failure.path} -> ${failure.target}`);
  console.error(`     ${failure.reason}. A tracked symlink must stay relative to its own checkout.`);
  console.error(`     fix: git rm --cached ${failure.path}   # then ignore it, or commit a script instead`);
}
if (failures.length) {
  console.error(
    `${failures.length} tracked symlink(s) point outside this checkout.\n` +
      "Share dependencies with `node tools/repo/link-node-modules.mjs <source-checkout>`, never with a committed link.",
  );
  process.exit(1);
}
console.log(`ok   no tracked symlink points outside this checkout (${checked.length} internal, 0 offending)`);
