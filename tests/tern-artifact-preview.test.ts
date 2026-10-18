import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PiTernBridge, type PiEventLike, type PiSessionLike } from "../.pi/lib/tern/bridge.ts";

// 1x1 transparent PNG; real bytes so the blob id is the SHA-256 Tern verifies.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
const ESC = "\x1b";

function session(cwd: string) {
  const listeners = new Set<(e: PiEventLike) => void>();
  const fake = {
    subscribe(l: (e: PiEventLike) => void) { listeners.add(l); return () => listeners.delete(l); },
    prompt: async () => {},
    abort: async () => {},
    dispose() {},
    sessionManager: { getCwd: () => cwd, getBranch: () => [] },
  } as unknown as PiSessionLike;
  return { session: fake, emit: (e: PiEventLike) => { for (const l of listeners) l(e); } };
}

async function runRead(filePath: string, cwd: string, expectPicture: boolean): Promise<string[]> {
  const writes: string[] = [];
  const fake = session(cwd);
  const bridge = new PiTernBridge(fake.session, { write: (d) => writes.push(d), surfaceId: "pi", credits: 1000 });
  bridge.start("pi");
  fake.emit({ type: "tool_execution_start", toolCallId: "c1", toolName: "Read", args: { file_path: filePath } });
  fake.emit({ type: "tool_execution_end", toolCallId: "c1", toolName: "Read", result: { content: [{ type: "text", text: "Image file: x.png (image/png, 0.07 KB)\nCite as: x.png" }] }, isError: false });
  if (expectPicture) await vi.waitFor(() => expect(writes.some((w) => w.includes(";f;") && w.includes('"image"'))).toBe(true));
  // Preview work is async; give a text file's (absent) preview time to appear if it were wrong.
  else await new Promise((r) => setTimeout(r, 100));
  return writes;
}

describe("Tern artifact preview (end to end through PiTernBridge)", () => {
  it("sends the picture as a blob whose id is its SHA-256 and draws it under the Read row", async () => {
    const ws = mkdtempSync(join(tmpdir(), "tern-art-"));
    const file = join(ws, "shot.png");
    writeFileSync(file, PNG);
    const writes = await runRead(file, ws, true);
    const sha = createHash("sha256").update(PNG).digest("hex");
    const blobIndex = writes.findIndex((w) => w.startsWith(`${ESC}_tsp;b;id=${sha};mime=image/png;`));
    const frameIndex = writes.findIndex((w) => w.includes(`"blob":"${sha}"`));
    expect(blobIndex).toBeGreaterThanOrEqual(0);
    expect(frameIndex).toBeGreaterThan(blobIndex);
    expect(writes[frameIndex]).toContain("Cite: shot.png");
  });

  it("near miss: a text file read sends no picture blob and no image node", async () => {
    const ws = mkdtempSync(join(tmpdir(), "tern-art-"));
    const file = join(ws, "notes.txt");
    writeFileSync(file, "plain text\n");
    const writes = await runRead(file, ws, false);
    expect(writes.some((w) => w.includes(";f;"))).toBe(true);
    expect(writes.some((w) => w.includes(";b;"))).toBe(false);
    expect(writes.some((w) => w.includes('"image"'))).toBe(false);
  });
});
