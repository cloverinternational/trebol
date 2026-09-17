import { describe, expect, it, vi } from "vitest";
import swarmImagePaste, { captureClipboardImage, handleImagePaste } from "../../extensions/50-ui/swarm-image-paste.ts";
import { buildProbeScript, readClipboardImageViaPowerShell, type WindowsClipboardDeps } from "../../lib/ui/windows-clipboard.ts";

function deps(overrides: Partial<WindowsClipboardDeps> = {}): WindowsClipboardDeps {
  return {
    run: () => ({ status: 0, stdout: "ok\r\n" }),
    readFile: () => new Uint8Array([137, 80, 78, 71]),
    removeFile: () => {},
    tmpFile: () => "C:\\Temp\\probe.png",
    ...overrides,
  };
}

describe("windows clipboard probe", () => {
  it("runs PowerShell with -Sta so WinForms clipboard access works", () => {
    const run = vi.fn(() => ({ status: 0, stdout: "ok" }));
    readClipboardImageViaPowerShell(deps({ run }));
    const [command, args] = run.mock.calls[0];
    expect(command).toBe("powershell.exe");
    expect(args).toContain("-Sta");
    expect(args).toContain("-NoProfile");
  });

  it("returns PNG bytes when the clipboard holds an image", () => {
    expect(readClipboardImageViaPowerShell(deps())).toEqual({
      bytes: new Uint8Array([137, 80, 78, 71]),
      mimeType: "image/png",
    });
  });

  it("returns null on an empty clipboard, a failed probe, or empty output", () => {
    expect(readClipboardImageViaPowerShell(deps({ run: () => ({ status: 0, stdout: "empty" }) }))).toBeNull();
    expect(readClipboardImageViaPowerShell(deps({ run: () => ({ status: 1, stdout: "" }) }))).toBeNull();
    expect(readClipboardImageViaPowerShell(deps({ readFile: () => new Uint8Array() }))).toBeNull();
  });

  it("always removes the temp probe file, including when the read throws", () => {
    const removeFile = vi.fn();
    readClipboardImageViaPowerShell(deps({ removeFile }));
    expect(removeFile).toHaveBeenCalledWith("C:\\Temp\\probe.png");
    removeFile.mockClear();
    const thrown = deps({
      removeFile,
      readFile: () => {
        throw new Error("locked");
      },
    });
    expect(readClipboardImageViaPowerShell(thrown)).toBeNull();
    expect(removeFile).toHaveBeenCalledTimes(1);
  });

  it("escapes single quotes so a quoted temp path cannot break out of the script", () => {
    const script = buildProbeScript("C:\\Temp\\o'brien.png");
    expect(script).toContain("$path = 'C:\\Temp\\o''brien.png'");
  });
});

describe("image paste handler", () => {
  it("pastes the captured image path into the editor", async () => {
    const write = vi.fn();
    expect(captureClipboardImage(deps(), write)).toMatch(/pi-clipboard-.*\.png$/);
    expect(write).toHaveBeenCalledOnce();

    const ui = { pasteToEditor: vi.fn(), notify: vi.fn() };
    await handleImagePaste({ ui }, deps({ readFile: () => new Uint8Array([1]) }));
    expect(ui.pasteToEditor).toHaveBeenCalledOnce();
    expect(ui.notify).not.toHaveBeenCalled();
  });

  it("tells the user when the clipboard has no image instead of failing silently", async () => {
    const ui = { pasteToEditor: vi.fn(), notify: vi.fn() };
    await handleImagePaste({ ui }, deps({ run: () => ({ status: 0, stdout: "empty" }) }));
    expect(ui.pasteToEditor).not.toHaveBeenCalled();
    expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("No image on the clipboard"), "info");
  });
});

describe("registration", () => {
  it("registers ctrl+v and a command on Windows", () => {
    const pi = { registerShortcut: vi.fn(), registerCommand: vi.fn() };
    swarmImagePaste(pi, "win32");
    expect(pi.registerShortcut).toHaveBeenCalledWith("ctrl+v", expect.objectContaining({ description: expect.any(String) }));
    expect(pi.registerCommand).toHaveBeenCalledWith("paste-image", expect.anything());
  });

  it("does not register on platforms where Pi's own ctrl+v already works", () => {
    const pi = { registerShortcut: vi.fn(), registerCommand: vi.fn() };
    swarmImagePaste(pi, "linux");
    swarmImagePaste(pi, "darwin");
    expect(pi.registerShortcut).not.toHaveBeenCalled();
    expect(pi.registerCommand).not.toHaveBeenCalled();
  });
});
