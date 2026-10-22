// Runs upstream apply-patch scenario fixtures against Trebol's apply_patch.
// Fixtures: tests/fixtures/scenarios in openai/codex @ 430a16799d90e296fb27b1e94f206023902b7e56.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { applyPatch, applyPatchStandalone } from "../../../.pi/lib/tools/swarm-apply-patch.ts";

export const SCENARIOS_DIR = resolve(import.meta.dirname, "fixtures/scenarios");
export const UPSTREAM_SHA = "430a16799d90e296fb27b1e94f206023902b7e56";

/** Scenario outcomes that intentionally differ between upstream and the Trebol agent path. */
export const AGENT_ALLOWLIST: Record<string, string> = {
  "015_failure_after_partial_success_leaves_changes":
    "Agent verification rejects the missing update before any write; upstream standalone writer keeps created.txt.",
};

export type Mode = "standalone" | "agent";

/** Map relative path -> file bytes (base64), excluding Trebol's .swarm snapshot store. */
export function snapshotTree(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      if (name === ".swarm") continue;
      const abs = join(dir, name);
      if (statSync(abs).isDirectory()) walk(abs);
      else out.set(relative(root, abs), readFileSync(abs).toString("base64"));
    }
  };
  walk(root);
  return out;
}

export interface ScenarioResult { name: string; mode: Mode | "oracle"; pass: boolean; error?: string; diff?: string[] }

export async function runScenario(dir: string, mode: Mode): Promise<ScenarioResult> {
  const name = dir.split("/").at(-1)!;
  const tmp = mkdtempSync(join(tmpdir(), "patch-parity-"));
  try {
    if (existsSync(join(dir, "input"))) cpSync(join(dir, "input"), tmp, { recursive: true });
    const patch = readFileSync(join(dir, "patch.txt"), "utf8");
    let error: string | undefined;
    try {
      const run = mode === "standalone" ? applyPatchStandalone : applyPatch;
      await run(patch, { workspacePath: tmp });
    } catch (e) { error = (e as Error).message.split("\n")[0]; }
    const expected = snapshotTree(join(dir, "expected")), actual = snapshotTree(tmp);
    const diff = [...new Set([...expected.keys(), ...actual.keys()])].sort()
      .filter(k => expected.get(k) !== actual.get(k))
      .map(k => (expected.has(k) ? (actual.has(k) ? `changed ${k}` : `missing ${k}`) : `unexpected ${k}`));
    return { name, mode, pass: diff.length === 0, error, diff };
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

/** Runs the pinned upstream binary when provided; reports BLOCKED otherwise. */
export function runOracle(dir: string, binary: string): ScenarioResult {
  const name = dir.split("/").at(-1)!;
  const tmp = mkdtempSync(join(tmpdir(), "patch-oracle-"));
  try {
    if (existsSync(join(dir, "input"))) cpSync(join(dir, "input"), tmp, { recursive: true });
    spawnSync(binary, [readFileSync(join(dir, "patch.txt"), "utf8")], { cwd: tmp });
    const expected = snapshotTree(join(dir, "expected")), actual = snapshotTree(tmp);
    const diff = [...new Set([...expected.keys(), ...actual.keys()])].sort().filter(k => expected.get(k) !== actual.get(k));
    return { name, mode: "oracle", pass: diff.length === 0, diff };
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

async function main() {
  const mode = (process.argv[2] ?? "standalone") as Mode | "oracle";
  const dirs = readdirSync(SCENARIOS_DIR).map(n => join(SCENARIOS_DIR, n)).filter(p => statSync(p).isDirectory()).sort();
  const oracleBin = process.env.CODEX_APPLY_PATCH_BIN;
  if (mode === "oracle" && !oracleBin) {
    console.log(JSON.stringify({ upstream: UPSTREAM_SHA, oracle: "BLOCKED", reason: "CODEX_APPLY_PATCH_BIN not set; no cargo toolchain on host" }));
    return;
  }
  const results: ScenarioResult[] = [];
  for (const dir of dirs) results.push(mode === "oracle" ? runOracle(dir, oracleBin!) : await runScenario(dir, mode));
  const failed = results.filter(r => !r.pass && !(mode === "agent" && AGENT_ALLOWLIST[r.name]));
  console.log(JSON.stringify({ upstream: UPSTREAM_SHA, mode, total: results.length, failed: failed.map(r => ({ name: r.name, diff: r.diff, error: r.error })), allowlisted: results.filter(r => !r.pass && AGENT_ALLOWLIST[r.name]).map(r => r.name) }, null, 2));
  process.exitCode = failed.length ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) await main();
