/** Windows clipboard image paste.
 *
 * Fixes two Windows-only gaps in Pi's built-in image paste:
 *
 * 1. `app.clipboard.pasteImage` defaults to `alt+v` on win32 because Windows
 *    Terminal binds `ctrl+v` to its own paste action. Users who never learn
 *    about `alt+v` see nothing happen. This registers `ctrl+v` as an
 *    extension shortcut — extension shortcuts are dispatched before built-in
 *    keybindings, and `ctrl+v` is not a reserved binding — while Pi's `alt+v`
 *    keeps working unchanged.
 * 2. Pi's reader only falls back to PowerShell under WSL, so a native-Windows
 *    clipboard bitmap the `@mariozechner/clipboard` addon cannot see (common
 *    with PowerShell 7 hosts and `Win+Shift+S`) yields no image at all.
 *
 * Non-Windows platforms are untouched: Pi's own `ctrl+v` handling is correct
 * there and this extension does not register.
 */

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readClipboardImageViaPowerShell, type WindowsClipboardDeps } from "../../lib/ui/windows-clipboard.ts";

interface PasteUI {
  pasteToEditor(text: string): void;
  notify(message: string, type?: "info" | "warning" | "error"): void;
}

interface PasteContext {
  ui: PasteUI;
}

interface PasteAPI {
  registerShortcut(
    shortcut: string,
    options: { description: string; handler: (ctx: PasteContext) => Promise<void> | void },
  ): void;
  registerCommand(
    name: string,
    options: { description: string; handler: (args: string, ctx: PasteContext) => Promise<void> | void },
  ): void;
}

const nodeDeps: WindowsClipboardDeps = {
  run(command, args, timeoutMs) {
    const result = spawnSync(command, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024, windowsHide: true });
    if (result.error) return { status: null, stdout: "" };
    return { status: result.status, stdout: result.stdout?.toString("utf-8") ?? "" };
  },
  readFile: (path) => new Uint8Array(readFileSync(path)),
  removeFile: (path) => unlinkSync(path),
  tmpFile: () => join(tmpdir(), `pi-swarm-clip-${randomUUID()}.png`),
};

/** Reads the clipboard image and writes it to a temp PNG, returning its path.
 * Returns null when the clipboard holds no image. */
export function captureClipboardImage(
  deps: WindowsClipboardDeps,
  write: (path: string, bytes: Uint8Array) => void = (path, bytes) => writeFileSync(path, bytes),
): string | null {
  const image = readClipboardImageViaPowerShell(deps);
  if (!image) return null;
  const path = join(tmpdir(), `pi-clipboard-${randomUUID()}.png`);
  write(path, image.bytes);
  return path;
}

export async function handleImagePaste(ctx: PasteContext, deps: WindowsClipboardDeps = nodeDeps): Promise<void> {
  let path: string | null;
  try {
    path = captureClipboardImage(deps);
  } catch (error) {
    ctx.ui.notify(`Clipboard image paste failed: ${error instanceof Error ? error.message : String(error)}`, "error");
    return;
  }
  if (!path) {
    // Pi's built-in handler returns silently here, which reads as a dead
    // keybinding. Say what happened instead.
    ctx.ui.notify("No image on the clipboard. Copy an image, then paste again.", "info");
    return;
  }
  ctx.ui.pasteToEditor(path);
}

export default function swarmImagePaste(pi: PasteAPI, platform: NodeJS.Platform = process.platform): void {
  if (platform !== "win32") return;
  pi.registerShortcut("ctrl+v", {
    description: "Paste image from clipboard (Windows)",
    handler: (ctx) => handleImagePaste(ctx),
  });
  // Reachable when a terminal consumes both ctrl+v and alt+v.
  pi.registerCommand("paste-image", {
    description: "Paste an image from the Windows clipboard",
    handler: (_args, ctx) => handleImagePaste(ctx),
  });
}
