#!/usr/bin/env node
/**
 * Opt in to sharing one installed `node_modules` across local worktrees.
 *
 * This replaces what commit 3746215 (PR #338) tried to do by COMMITTING
 * `node_modules` as a symlink to an absolute path. That cannot work: git stores
 * a symlink as its target string, so the link names one machine's directory,
 * dangles in every other clone, and in its own checkout replaces the real
 * dependency tree with a self-referential link (the Claw daemon then died with
 * `Cannot find package 'croner'`).
 *
 * Sharing stays possible, but it is local, explicit, per worktree, and
 * RELATIVE, so it is stable on this machine and is never part of the repository.
 *
 * Usage:
 *   node tools/repo/link-node-modules.mjs <source-checkout> [--cwd <worktree>] [--force]
 *
 *   <source-checkout>  a checkout with an installed node_modules (usually the
 *                      primary clone). Its realpath is used.
 *   --cwd              the worktree to link (default: this repository).
 *   --force            replace an existing symlink. A real directory is never
 *                      removed -- run `npm ci` there instead.
 *
 * What it does: computes `path.relative(<cwd>, <source>/node_modules)` and
 * creates one symlink at `<cwd>/node_modules`. `npm ci` still writes into the
 * shared directory, so a dedicated `npm ci` per worktree remains the safe
 * default when package versions differ.
 */
import { existsSync, realpathSync, lstatSync, symlinkSync, unlinkSync, readlinkSync } from "node:fs";
import { resolve, relative, dirname, join, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const VALUE_FLAGS = new Set(["--cwd"]);
const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(name);
  return i === -1 || i === argv.length - 1 ? fallback : argv[i + 1];
};
const has = (name) => argv.includes(name);
/** Positional arguments: everything that is not a flag or a flag's value. */
const positional = argv.filter((arg, i) => !arg.startsWith("--") && !(i > 0 && VALUE_FLAGS.has(argv[i - 1])));

const HERE = dirname(fileURLToPath(import.meta.url));
const CWD = resolve(opt("--cwd", join(HERE, "..", "..")));
const source = positional[0];
const force = has("--force");

const die = (message) => {
  console.error(`link-node-modules: ${message}`);
  process.exit(1);
};

if (!source) {
  die("missing <source-checkout>. Example: node tools/repo/link-node-modules.mjs ../trebol");
}
if (!existsSync(source)) {
  die(`${source} does not exist.`);
}

const sourceModules = join(realpathSync(source), "node_modules");
if (!existsSync(sourceModules)) {
  die(`${sourceModules} does not exist. Run \`npm ci\` in ${resolve(source)} first.`);
}
if (!lstatSync(sourceModules).isDirectory()) {
  die(`${sourceModules} is not a directory (it may itself be a link); point at a checkout that installed dependencies normally.`);
}

const linkPath = join(CWD, "node_modules");
if (existsSync(linkPath) || isSymlink(linkPath)) {
  if (!isSymlink(linkPath)) {
    die(`${linkPath} is already a real directory. Nothing to do -- a per-worktree install is the safer default.`);
  }
  if (!force) {
    die(`${linkPath} is already a symlink to ${readlinkSync(linkPath)}. Pass --force to replace it.`);
  }
  unlinkSync(linkPath); // a symlink: removes the link, never its target
}

const target = relative(CWD, sourceModules);
if (isAbsolute(target)) die(`refusing to create an absolute link (${target}); that is the defect this helper replaces.`);
symlinkSync(target, linkPath, "dir");

console.log(`linked ${linkPath}`);
console.log(`  -> ${target}   (relative, ${sourceModules})`);
console.log("This link is per worktree and untracked. `node tools/repo/check-tracked-symlinks.mjs` proves it is not committed.");

function isSymlink(path) {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}
