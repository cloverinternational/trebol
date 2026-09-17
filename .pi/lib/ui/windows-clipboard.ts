/** Windows clipboard image reader for the image-paste extension.
 *
 * Pi's own reader (`packages/coding-agent/src/utils/clipboard-image.ts`)
 * routes native win32 straight to the `@mariozechner/clipboard` addon and only
 * falls back to PowerShell when the platform is Linux under WSL. When the
 * addon misses a host bitmap — PowerShell 7 hosts and `Win+Shift+S`
 * screenshots are the common cases — paste silently yields nothing.
 *
 * This module adds the missing native-Windows fallback. WinForms clipboard
 * access requires a single-threaded apartment, so the probe runs `-Sta`.
 * Subprocess and filesystem access are injected so the behavior is testable
 * off-Windows.
 */

export interface ClipboardImage {
  bytes: Uint8Array;
  mimeType: string;
}

export interface ProbeResult {
  status: number | null;
  stdout: string;
}

export interface WindowsClipboardDeps {
  /** Runs a command and returns its exit status and stdout. */
  run(command: string, args: string[], timeoutMs: number): ProbeResult;
  readFile(path: string): Uint8Array;
  removeFile(path: string): void;
  tmpFile(): string;
}

const PROBE_TIMEOUT_MS = 5000;

/** PowerShell that saves the clipboard bitmap to `path` as PNG. */
export function buildProbeScript(path: string): string {
  const quoted = path.replaceAll("'", "''");
  return [
    "Add-Type -AssemblyName System.Windows.Forms",
    "Add-Type -AssemblyName System.Drawing",
    `$path = '${quoted}'`,
    "$img = [System.Windows.Forms.Clipboard]::GetImage()",
    "if ($img) { $img.Save($path, [System.Drawing.Imaging.ImageFormat]::Png); Write-Output 'ok' } else { Write-Output 'empty' }",
  ].join("; ");
}

/** Reads a clipboard image through PowerShell. Returns null when the
 * clipboard holds no image or the probe fails for any reason. */
export function readClipboardImageViaPowerShell(deps: WindowsClipboardDeps): ClipboardImage | null {
  const path = deps.tmpFile();
  try {
    // -Sta is required: WinForms Clipboard.GetImage() throws in an MTA.
    const result = deps.run(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Sta", "-Command", buildProbeScript(path)],
      PROBE_TIMEOUT_MS,
    );
    if (result.status !== 0 || result.stdout.trim() !== "ok") return null;
    const bytes = deps.readFile(path);
    return bytes.length > 0 ? { bytes, mimeType: "image/png" } : null;
  } catch {
    return null;
  } finally {
    try {
      deps.removeFile(path);
    } catch {
      // Best-effort cleanup; a leftover temp file must not fail a paste.
    }
  }
}
