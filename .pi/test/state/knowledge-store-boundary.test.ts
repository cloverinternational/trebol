import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openKnowledgeStore } from "../../lib/state/knowledge-store.ts";

// The store refuses a symlink between the configured root and its own directory:
// a redirected "knowledge" directory would let a checkpointed workspace write
// events somewhere the user never pointed at. Ancestors above the configured
// root belong to the host (macOS's /var and /tmp are symlinks), so they are not
// inspected — see the temporary-store tests that used to fail on macOS.
describe("knowledge store directory boundary", () => {
  it("refuses a symlinked directory inside the configured root", () => {
    const root = mkdtempSync(join(tmpdir(), "knowledge-boundary-"));
    const outside = mkdtempSync(join(tmpdir(), "knowledge-outside-"));
    try {
      mkdirSync(root, { recursive: true });
      symlinkSync(outside, join(root, "knowledge"));
      expect(() => openKnowledgeStore({ cwd: root, root })).toThrow(/Unsafe knowledge directory/);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
  it("accepts a store whose root sits under a symlinked system temporary directory", () => {
    const root = mkdtempSync(join(tmpdir(), "knowledge-ok-"));
    try {
      const store = openKnowledgeStore({ cwd: root, root });
      expect(store.directory.startsWith(root)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
