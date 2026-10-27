import { afterEach, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boundToolTextWithRecovery, persistToolOutput, SPILL_DIR } from "../../lib/runtime/swarm-toolout.ts";
import { boundTextBlocks } from "../../lib/runtime/swarm-toolout-boundary.ts";

const roots: string[] = [];
const root = () => { const p = mkdtempSync(join(tmpdir(), "spill-review-")); roots.push(p); return p; };
afterEach(() => { for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }); });

it("uses the full head budget and reports all omitted bytes", () => {
  const result = boundToolTextWithRecovery("x".repeat(10000), { root: root(), maxTokens: 1000, keep: "head" });
  const kept = result.text.match(/^x+/)![0].length;
  expect(kept).toBeGreaterThan(2500);
  expect(result.elidedBytes).toBe(10000 - kept);
  expect(result.text).toContain("from the end");
  expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(4000);
});

it("includes multi-block separators in the line budget", () => {
  const result = boundTextBlocks(Array.from({ length: 20 }, () => "line\n".repeat(200)), { root: root() });
  expect(result.texts.reduce((n, text) => n + (text ? text.split("\n").length : 0), 0)).toBeLessThanOrEqual(1000);
});

it("tightens a legacy owned directory and rejects a symlink", () => {
  const r = root(); const dir = join(r, SPILL_DIR);
  mkdirSync(dir); chmodSync(dir, 0o755);
  expect(persistToolOutput("data", { root: r, prefix: "test-" }).ok).toBe(true);
  expect(statSync(dir).mode & 0o777).toBe(0o700);
  const other = root(); symlinkSync(dir, join(other, SPILL_DIR));
  expect(persistToolOutput("data", { root: other, prefix: "test-" }).ok).toBe(false);
});
