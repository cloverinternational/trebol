import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ApplyPatchExecutionError, applyPatch, applyPatchStandalone } from "../../lib/tools/swarm-apply-patch.ts";
import { CASES, compareCase } from "../../../tools/experiments/patch-parity/differential.ts";

// Regression tests for divergences from pinned upstream codex 430a16799d90e296fb27b1e94f206023902b7e56.
// Each expectation was established by running the built upstream oracle (see differential.ts).
const roots: string[] = [];
const root = () => { const p = mkdtempSync(join(tmpdir(), "swarm-oracle-")); roots.push(p); return p; };
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });
const patchOf = (...body: string[]) => ["*** Begin Patch", ...body, "*** End Patch"].join("\n");

describe("apply_patch upstream-exact regressions", () => {
  it("a move onto its own source deletes the file (upstream write-then-remove)", async () => {
    const ws = root();
    writeFileSync(join(ws, "a.txt"), "one\n");
    await applyPatch(patchOf("*** Update File: a.txt", "*** Move to: a.txt", "-one", "+two"), { workspacePath: ws });
    expect(existsSync(join(ws, "a.txt"))).toBe(false);
  });

  it("does not heal a workspace-prefixed path; the agent path rejects with no writes", async () => {
    const ws = join(root(), "ws");
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(ws, "file.txt"), "x\n");
    await expect(applyPatch(patchOf("*** Update File: ws/file.txt", "-x", "+y"), { workspacePath: ws })).rejects.toThrow();
    expect(readFileSync(join(ws, "file.txt"), "utf8")).toBe("x\n");
  });

  it("keeps a UTF-8 BOM through an update", async () => {
    const ws = root();
    writeFileSync(join(ws, "bom.txt"), "\uFEFFa\nb\n");
    await applyPatch(patchOf("*** Update File: bom.txt", "-b", "+c"), { workspacePath: ws });
    expect([...readFileSync(join(ws, "bom.txt")).subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  });

  it("agent verification rejects a non-UTF-8 delete target, while the writer deletes it", async () => {
    const ws = root();
    writeFileSync(join(ws, "bad.txt"), Buffer.from([0x61, 0xff]));
    await expect(applyPatch(patchOf("*** Delete File: bad.txt"), { workspacePath: ws })).rejects.toThrow(/not valid UTF-8/);
    expect(existsSync(join(ws, "bad.txt"))).toBe(true);
    await applyPatchStandalone(patchOf("*** Delete File: bad.txt"), { workspacePath: ws });
    expect(existsSync(join(ws, "bad.txt"))).toBe(false);
  });

  it("an empty patch fails at execution (after verification) and writes nothing", async () => {
    const ws = root();
    writeFileSync(join(ws, "a.txt"), "one\n");
    const error = await applyPatch(patchOf(), { workspacePath: ws }).catch(e => e);
    expect(error).toBeInstanceOf(ApplyPatchExecutionError);
    expect((error as ApplyPatchExecutionError).committed).toEqual([]);
    expect(readFileSync(join(ws, "a.txt"), "utf8")).toBe("one\n");
  });
});

const oracle = process.env.CODEX_TREBOL_ORACLE_BIN, writer = process.env.CODEX_APPLY_PATCH_BIN;
describe.skipIf(!oracle || !writer)("differential against the built pinned upstream oracle (set CODEX_TREBOL_ORACLE_BIN and CODEX_APPLY_PATCH_BIN; skipped otherwise, so parity is NOT verified when skipped)", () => {
  it.each(CASES.flatMap(c => (["agent", "writer"] as const).map(m => [`${m}: ${c.name}`, c, m] as const)))("%s", async (_label, c, mode) => {
    const result = await compareCase(c, mode, oracle!);
    expect(result.treeDiff).toEqual([]);
    expect(result.trebol).toBe(result.oracle);
  });
});
