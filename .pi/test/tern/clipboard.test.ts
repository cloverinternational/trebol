// Ctrl+V reads on every platform: pi-tui's native helper first, the platform's tools when it is unavailable.
import { describe, expect, it } from "vitest";
import { createClipboard, filePathsFromUriList, imageExtension, type CommandRunner, type NativeClipboardLike } from "../../lib/tern/clipboard.ts";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2]);

// A fake shell: `${command} ${args}` → stdout; anything else is a missing tool or a failed command.
function shell(outputs: Record<string, string | Buffer>): { run: CommandRunner; calls: string[] } {
	const calls: string[] = [];
	return {
		calls,
		run: (command, args) => {
			const key = [command, ...args].join(" ");
			calls.push(key);
			const out = outputs[key];
			return out === undefined ? null : Buffer.isBuffer(out) ? out : Buffer.from(out);
		},
	};
}

const noWsl = () => "Linux version 6.8.0-generic";

describe("createClipboard", () => {
	it("uses the native helper's answer, including 'nothing there', without running tools (macOS, Windows, X11)", async () => {
		const native: NativeClipboardLike = { getText: async () => null, getImage: async () => null, getFilePaths: async () => ["/a b.txt"] };
		const { run, calls } = shell({});
		for (const platform of ["darwin", "win32", "linux"] as const) {
			const c = createClipboard({ platform, env: { DISPLAY: ":0" }, native: () => native, run, procVersion: noWsl });
			expect(await c.text()).toBeNull();
			expect(await c.image()).toBeNull();
			expect(await c.filePaths()).toEqual(["/a b.txt"]);
		}
		expect(calls).toEqual([]);
	});

	it("Wayland without the native helper: text, image and files through wl-paste", async () => {
		const { run } = shell({
			"wl-paste --no-newline": "héllo",
			"wl-paste --list-types": "text/plain\nimage/png\ntext/uri-list\n",
			"wl-paste --no-newline --type image/png": PNG,
			"wl-paste --no-newline --type text/uri-list": "file:///tmp/a%20b.txt\r\nhttps://x\n",
		});
		const c = createClipboard({ platform: "linux", env: { WAYLAND_DISPLAY: "wayland-0" }, native: () => undefined, run, procVersion: noWsl });
		expect(await c.text()).toBe("héllo");
		expect(Buffer.from((await c.image())!)).toEqual(PNG);
		expect(await c.filePaths()).toEqual(["/tmp/a b.txt"]);
	});

	it("X11 without the native helper: xclip, then xsel for text", async () => {
		const { run } = shell({
			"xsel --clipboard --output": "from xsel",
			"xclip -selection clipboard -t TARGETS -o": "TARGETS\nimage/jpeg\n",
			"xclip -selection clipboard -t image/jpeg -o": Buffer.from([0xff, 0xd8, 0xff]),
		});
		const c = createClipboard({ platform: "linux", env: { DISPLAY: ":0" }, native: () => undefined, run, procVersion: noWsl });
		expect(await c.text()).toBe("from xsel");
		expect(imageExtension((await c.image())!)).toBe("jpg");
		expect(await c.filePaths()).toBeNull();
	});

	it("a native helper that rejects counts as unavailable, so the tools still answer", async () => {
		const native: NativeClipboardLike = { getText: async () => { throw new Error("display gone"); }, getImage: async () => undefined };
		const { run } = shell({ "wl-paste --no-newline": "fallback" });
		const c = createClipboard({ platform: "linux", env: { WAYLAND_DISPLAY: "w" }, native: () => native, run, procVersion: noWsl });
		expect(await c.text()).toBe("fallback");
	});

	it("WSL with no display: Windows' clipboard through powershell.exe, CRLF normalised", async () => {
		const { run } = shell({ "powershell.exe -NoProfile -NonInteractive -Command Get-Clipboard -Raw": "a\r\nb" });
		const c = createClipboard({ platform: "linux", env: {}, native: () => undefined, run, procVersion: () => "Linux version 5.15.0-microsoft-standard-WSL2" });
		expect(await c.text()).toBe("a\nb");
	});

	it("Windows without the native helper reads text through PowerShell; macOS through pbpaste", async () => {
		const { run } = shell({ "powershell -NoProfile -NonInteractive -Command Get-Clipboard -Raw": "w\r\n", "pbpaste": "m" });
		expect(await createClipboard({ platform: "win32", env: {}, native: () => undefined, run }).text()).toBe("w\n");
		expect(await createClipboard({ platform: "darwin", env: {}, native: () => undefined, run }).text()).toBe("m");
	});

	it("no tools installed (headless Linux): every read is null, never a throw", async () => {
		const { run } = shell({});
		const c = createClipboard({ platform: "linux", env: { WAYLAND_DISPLAY: "w", DISPLAY: ":0" }, native: () => undefined, run, procVersion: noWsl });
		expect(await c.text()).toBeNull();
		expect(await c.image()).toBeNull();
		expect(await c.filePaths()).toBeNull();
	});
});

describe("helpers", () => {
	it("reads GNOME's copied-files list and skips non-file URIs", () => {
		expect(filePathsFromUriList("copy\nfile:///home/u/x.png\nfile:///home/u/%C3%A9.txt\nsmb://h/s")).toEqual(["/home/u/x.png", "/home/u/é.txt"]);
	});

	it("names saved images by their signature", () => {
		expect(imageExtension(PNG)).toBe("png");
		expect(imageExtension(new Uint8Array([0x47, 0x49, 0x46, 0x38]))).toBe("gif");
		expect(imageExtension(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]))).toBe("webp");
	});
});
