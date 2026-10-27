import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ApplyPatchExecutionError, applyPatch, applyPatchStandalone, parsePatch } from "../../lib/tools/swarm-apply-patch.ts";
import { readArtifact } from "../../lib/tools/swarm-read-image.ts";
import extension from "../../../extensions/swarm-fs-tools/extension.ts";
import { PERMISSIVE_PARAMETERS, loadSwarmToolSurface, overlaySwarmToolSchemas } from "../../lib/runtime/swarm-tool-surface.ts";

const roots: string[] = [];
const root = () => { const p = mkdtempSync(join(tmpdir(), "swarm-patch-")); roots.push(p); return p; };
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });
const patchOf = (...body: string[]) => ["*** Begin Patch", ...body, "*** End Patch"].join("\n");

describe("Swarm apply_patch (upstream codex 430a16799d90e296fb27b1e94f206023902b7e56 semantics)", () => {
  it("parses and applies add, update, delete, and move", async () => {
    const ws = root();
    writeFileSync(join(ws, "update.txt"), "one\ntwo\n");
    writeFileSync(join(ws, "delete.txt"), "bye\n");
    writeFileSync(join(ws, "move.txt"), "old\n");
    const patch = patchOf("*** Add File: add.txt", "+added",
      "*** Update File: update.txt", " one", "-two", "+changed",
      "*** Delete File: delete.txt",
      "*** Update File: move.txt", "*** Move to: moved.txt", "-old", "+new");
    expect(parsePatch(patch)).toHaveLength(4);
    await expect(applyPatch(patch, { workspacePath: ws })).resolves.toBe("Success. Updated the following files:\nA add.txt\nM update.txt\nM moved.txt\nD delete.txt\n");
    expect(readFileSync(join(ws, "add.txt"), "utf8")).toBe("added\n");
    expect(readFileSync(join(ws, "update.txt"), "utf8")).toBe("one\nchanged\n");
    expect(existsSync(join(ws, "delete.txt"))).toBe(false);
    expect(existsSync(join(ws, "move.txt"))).toBe(false);
    expect(readFileSync(join(ws, "moved.txt"), "utf8")).toBe("new\n");
  });

  it("uses the first match when context repeats, with no ambiguity rejection", async () => {
    const ws = root(), file = join(ws, "a.txt");
    writeFileSync(file, "same\nx\nsame\n");
    await applyPatch(patchOf("*** Update File: a.txt", "-same", "+new"), { workspacePath: ws });
    expect(readFileSync(file, "utf8")).toBe("new\nx\nsame\n");
  });

  it("uses an @@ anchor line to start the search after the anchor", async () => {
    const ws = root(), file = join(ws, "a.txt");
    writeFileSync(file, "function one() {\n  same();\n}\nfunction two() {\n  same();\n}\n");
    await applyPatch(patchOf("*** Update File: a.txt", "@@ function two() {", "-  same();", "+  changed();"), { workspacePath: ws });
    expect(readFileSync(file, "utf8")).toBe("function one() {\n  same();\n}\nfunction two() {\n  changed();\n}\n");
  });

  it("matches *** End of File only at the end of the file", async () => {
    const ws = root(), file = join(ws, "a.txt");
    writeFileSync(file, "a\nx\n");
    await expect(applyPatch(patchOf("*** Update File: a.txt", "@@", "-a", "+b", "*** End of File"), { workspacePath: ws }))
      .rejects.toThrow("Failed to find expected lines");
    expect(readFileSync(file, "utf8")).toBe("a\nx\n");
    writeFileSync(file, "x\na\n");
    await applyPatch(patchOf("*** Update File: a.txt", "@@", "-a", "+b", "*** End of File"), { workspacePath: ws });
    expect(readFileSync(file, "utf8")).toBe("x\nb\n");
  });

  it("rejects an unmatched context before writing any file", async () => {
    const ws = root();
    writeFileSync(join(ws, "a.txt"), "old\n");
    writeFileSync(join(ws, "b.txt"), "keep\n");
    await expect(applyPatch(patchOf("*** Update File: a.txt", "-old", "+new", "*** Update File: b.txt", "-missing", "+x"), { workspacePath: ws }))
      .rejects.toThrow("Failed to find expected lines in b.txt");
    expect(readFileSync(join(ws, "a.txt"), "utf8")).toBe("old\n");
    expect(readFileSync(join(ws, "b.txt"), "utf8")).toBe("keep\n");
  });

  it("rejects a missing update/delete source before writing any file", async () => {
    const ws = root(); writeFileSync(join(ws, "a.txt"), "old\n");
    await expect(applyPatch(patchOf("*** Update File: a.txt", "-old", "+new", "*** Delete File: absent.txt"), { workspacePath: ws }))
      .rejects.toThrow("absent.txt: file not found");
    expect(readFileSync(join(ws, "a.txt"), "utf8")).toBe("old\n");
  });

  it("rejects two operations on the same resolved source path before writing", async () => {
    const ws = root(); writeFileSync(join(ws, "a.txt"), "old\n");
    await expect(applyPatch(patchOf("*** Update File: a.txt", "-old", "+one", "*** Update File: ./a.txt", "-old", "+two"), { workspacePath: ws }))
      .rejects.toThrow("multiple operations target");
    expect(readFileSync(join(ws, "a.txt"), "utf8")).toBe("old\n");
  });

  it("lets a move overwrite an existing destination (upstream behavior)", async () => {
    const ws = root();
    writeFileSync(join(ws, "src.txt"), "src\n"); writeFileSync(join(ws, "dst.txt"), "dst\n");
    await applyPatch(patchOf("*** Update File: src.txt", "*** Move to: dst.txt", "-src", "+moved"), { workspacePath: ws });
    expect(readFileSync(join(ws, "dst.txt"), "utf8")).toBe("moved\n");
    expect(existsSync(join(ws, "src.txt"))).toBe(false);
  });

  it("keeps earlier writes and reports them when an execution-time write fails", async () => {
    const ws = root();
    writeFileSync(join(ws, "blocker"), "a regular file, so blocker/child.txt cannot be created");
    const patch = patchOf("*** Add File: first.txt", "+one", "*** Add File: blocker/child.txt", "+two");
    const error = await applyPatch(patch, { workspacePath: ws }).catch(e => e);
    expect(error).toBeInstanceOf(ApplyPatchExecutionError);
    expect(error.message).toContain("NOT rolled back");
    expect(error.committed).toEqual([{ tag: "A", path: "first.txt" }]);
    expect(readFileSync(join(ws, "first.txt"), "utf8")).toBe("one\n");
  });

  it("preserves each line's own ending and uses the first-seen ending for inserted lines", async () => {
    const ws = root(), file = join(ws, "a.txt");
    writeFileSync(file, "a\r\nb\nc\r\n");
    await applyPatch(patchOf("*** Update File: a.txt", " a", "-b", "+B", "+B2", " c"), { workspacePath: ws });
    expect(readFileSync(file, "utf8")).toBe("a\r\nB\r\nB2\r\nc\r\n");
  });

  it("splits on lone CR and terminates an unterminated final line", async () => {
    const ws = root(), cr = join(ws, "cr.txt"), noEol = join(ws, "noeol.txt");
    writeFileSync(cr, "a\rb\r");
    writeFileSync(noEol, "a\nb");
    await applyPatch(patchOf("*** Update File: cr.txt", "-b", "+B", "*** Update File: noeol.txt", "-a", "+A"), { workspacePath: ws });
    expect(readFileSync(cr, "utf8")).toBe("a\rB\r");
    expect(readFileSync(noEol, "utf8")).toBe("A\nb\n");
  });

  it("appends a pure addition chunk at end of file", async () => {
    const ws = root(), file = join(ws, "a.txt");
    writeFileSync(file, "one\ntwo\n");
    await applyPatch(patchOf("*** Update File: a.txt", "@@", "+three"), { workspacePath: ws });
    expect(readFileSync(file, "utf8")).toBe("one\ntwo\nthree\n");
  });

  it("rejects stacked @@ lines and an empty update hunk", async () => {
    expect(() => parsePatch(patchOf("*** Update File: a.txt", "@@ x", "@@ y", "-a", "+b"))).toThrow("Unexpected line found in update hunk");
    expect(() => parsePatch(patchOf("*** Update File: a.txt"))).toThrow("Update file hunk for path 'a.txt' is empty");
  });

  it("rejects environment_id, which is outside the local tool", () => {
    expect(() => parsePatch("*** Begin Patch\n*** Environment ID: remote\n*** Add File: a\n+x\n*** End Patch"))
      .toThrow("environment_id is not supported");
  });

  it("does not verify move destinations: a later Add to the moved path overwrites it (upstream)", async () => {
    const ws = root();
    writeFileSync(join(ws, "a.txt"), "ONE\n");
    const out = await applyPatch(patchOf("*** Update File: a.txt", "*** Move to: b.txt", "-ONE", "+new", "*** Add File: b.txt", "+added"), { workspacePath: ws });
    expect(out).toBe("Success. Updated the following files:\nA b.txt\nM b.txt\n");
    expect(existsSync(join(ws, "a.txt"))).toBe(false);
    expect(readFileSync(join(ws, "b.txt"), "utf8")).toBe("added\n");
  });

  it("standalone writer keeps earlier writes that the agent path would have rejected", async () => {
    const ws = root();
    await expect(applyPatchStandalone(patchOf("*** Add File: created.txt", "+hello", "*** Update File: missing.txt", "-old", "+new"), { workspacePath: ws }))
      .rejects.toThrow("missing.txt");
    expect(readFileSync(join(ws, "created.txt"), "utf8")).toBe("hello\n");
  });

  it("Read rejects text with Swarm's exact result message", async () => {
    const ws = root(), file = join(ws, "a.txt"); writeFileSync(file, "text");
    expect(await readArtifact(file, ws)).toEqual([{ type: "text", text: `ERROR: Read handles images, SVG and PDF files only (.gif, .jpeg, .jpg, .png, .webp, .svg, .pdf). For other files use the shell, e.g. \`sed -n '1,200p' ${file}\` to view a slice or \`rg PATTERN ${file}\` to search it.` }]);
  });

  it("lets apply_patch write outside the workspace", async () => {
    const ws = root(), outside = root(), file = join(outside, "outside.txt");
    writeFileSync(file, "old\n");
    await applyPatch(patchOf(`*** Update File: ${file}`, "-old", "+new"), { workspacePath: ws });
    expect(readFileSync(file, "utf8")).toBe("new\n");
  });

  it("registers the contract it owns, enforcing every schema except Read's", () => {
    const tools: any[] = []; extension({ registerTool: (tool: any) => tools.push(tool), getCwd: () => process.cwd() });
    for (const name of ["apply_patch", "Read"]) {
      const actual = tools.find(t => t.name === name), expected = loadSwarmToolSurface().get(name)!;
      expect(actual.description).toBe(expected.description);
      if (name === "Read") expect(actual.parameters).toEqual(PERMISSIVE_PARAMETERS);
      else expect(actual.parameters).toEqual(expected.parameters);
      const payload = { tools: [{ type: "function", function: { name, description: actual.description, parameters: actual.parameters } }] };
      const overlaid = overlaySwarmToolSchemas(payload) ?? payload;
      expect(JSON.stringify(overlaid.tools[0].function.parameters)).toBe(JSON.stringify(expected.parameters));
    }
    expect(loadSwarmToolSurface().get("apply_patch")!.description).not.toMatch(/atomic/i);
  });
});
