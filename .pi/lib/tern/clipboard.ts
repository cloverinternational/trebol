// Clipboard reads for the Tern composer's Ctrl+V (files, then an image, then text), on every platform.
// pi-tui's native helper covers macOS, Windows and Linux X11; it reports `undefined` (unavailable) on a
// Wayland-only session, under WSL without an X server, and wherever its prebuilt module did not load. Then the
// platform's own tools are used, as Pi's clipboard-image utility does: wl-paste (Wayland), xclip or xsel (X11),
// PowerShell (Windows, WSL), pbpaste (macOS). A missing tool or an empty clipboard reads as null.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

export interface NativeClipboardLike {
	getText(): Promise<string | null | undefined>;
	getImage(): Promise<Uint8Array | null | undefined>;
	getFilePaths?(): Promise<string[] | null | undefined>;
}

export interface ClipboardReader {
	filePaths(): Promise<string[] | null | undefined>;
	image(): Promise<Uint8Array | null | undefined>;
	text(): Promise<string | null | undefined>;
}

/** Runs a command and returns its stdout, or null when it is missing, fails or times out. */
export type CommandRunner = (command: string, args: string[]) => Buffer | null;

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const TIMEOUT_MS = 3000;
const MAX_BYTES = 50 * 1024 * 1024;

export const runCommand: CommandRunner = (command, args) => {
	const r = spawnSync(command, args, { timeout: TIMEOUT_MS, maxBuffer: MAX_BYTES, stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
	return r.error || r.status !== 0 || !r.stdout ? null : r.stdout;
};

export interface ClipboardEnv {
	platform: NodeJS.Platform;
	env: Record<string, string | undefined>;
	native: () => NativeClipboardLike | undefined;
	run?: CommandRunner;
	/** /proc/version, read to recognise WSL; injectable for tests. */
	procVersion?: () => string;
}

function isWsl(env: Record<string, string | undefined>, procVersion: () => string): boolean {
	if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) return true;
	try {
		return /microsoft/i.test(procVersion());
	} catch {
		return false;
	}
}

// file:// lines of a text/uri-list (or GNOME's x-special/gnome-copied-files, whose first line is the verb), as
// POSIX paths: these lists only come from Linux tools, whatever the host running the tests.
export function filePathsFromUriList(list: string): string[] {
	const out: string[] = [];
	for (const line of list.split(/\r?\n/)) {
		const uri = line.trim();
		if (!uri.startsWith("file://")) continue;
		try {
			const url = new URL(uri);
			if (url.host && url.host !== "localhost") continue;
			out.push(decodeURIComponent(url.pathname));
		} catch {
			// Not a local file URI.
		}
	}
	return out;
}

export function createClipboard({ platform, env, native, run = runCommand, procVersion = () => readFileSync("/proc/version", "utf8") }: ClipboardEnv): ClipboardReader {
	const linux = platform === "linux";
	const wayland = linux && (Boolean(env.WAYLAND_DISPLAY) || env.XDG_SESSION_TYPE === "wayland");
	const x11 = linux && Boolean(env.DISPLAY);
	const wsl = linux && isWsl(env, procVersion);
	const powershell = platform === "win32" ? "powershell" : "powershell.exe";
	const utf8 = (b: Buffer | null) => (b === null ? null : b.toString("utf8"));

	// MIME types the clipboard offers, from wl-paste or xclip.
	const types = (): string[] => {
		const listed = wayland ? utf8(run("wl-paste", ["--list-types"])) : null;
		const x = listed === null && x11 ? utf8(run("xclip", ["-selection", "clipboard", "-t", "TARGETS", "-o"])) : null;
		return (listed ?? x ?? "").split(/\r?\n/).map((t) => t.trim()).filter(Boolean);
	};
	const readType = (type: string): Buffer | null =>
		(wayland ? run("wl-paste", ["--no-newline", "--type", type]) : null) ?? (x11 ? run("xclip", ["-selection", "clipboard", "-t", type, "-o"]) : null);

	const fallbackText = (): string | null => {
		if (linux) {
			const t = (wayland ? utf8(run("wl-paste", ["--no-newline"])) : null)
				?? (x11 ? utf8(run("xclip", ["-selection", "clipboard", "-o"])) ?? utf8(run("xsel", ["--clipboard", "--output"])) : null)
				?? (wsl ? utf8(run(powershell, ["-NoProfile", "-NonInteractive", "-Command", "Get-Clipboard -Raw"])) : null);
			return t === null ? null : wsl && !wayland && !x11 ? t.replace(/\r\n/g, "\n") : t;
		}
		if (platform === "win32") return utf8(run(powershell, ["-NoProfile", "-NonInteractive", "-Command", "Get-Clipboard -Raw"]))?.replace(/\r\n/g, "\n") ?? null;
		if (platform === "darwin") return utf8(run("pbpaste", []));
		return null;
	};

	const fallbackImage = (): Uint8Array | null => {
		if (!linux) return null;
		const offered = types();
		const type = IMAGE_TYPES.find((t) => offered.includes(t));
		const bytes = type ? readType(type) : null;
		return bytes && bytes.length ? new Uint8Array(bytes) : null;
	};

	const fallbackFiles = (): string[] | null => {
		if (!linux) return null;
		const offered = types();
		const type = ["text/uri-list", "x-special/gnome-copied-files"].find((t) => offered.includes(t));
		const list = type ? utf8(readType(type)) : null;
		const paths = list ? filePathsFromUriList(list) : [];
		return paths.length ? paths : null;
	};

	// The native answer when it has one (null = nothing of that kind); the tools only when it is unavailable.
	const either = async <T>(read: (() => Promise<T | null | undefined>) | undefined, fallback: () => T | null): Promise<T | null> => {
		if (read) {
			const value = await read().catch(() => undefined);
			if (value !== undefined) return value;
		}
		return fallback();
	};

	return {
		filePaths: () => { const n = native(); return either(n?.getFilePaths?.bind(n), fallbackFiles); },
		image: () => { const n = native(); return either(n ? () => n.getImage() : undefined, fallbackImage); },
		text: () => { const n = native(); return either(n ? () => n.getText() : undefined, fallbackText); },
	};
}

// File extension for saved clipboard image bytes, from their signature (fallback reads may be JPEG/WebP/GIF).
export function imageExtension(bytes: Uint8Array): string {
	if (bytes[0] === 0xff && bytes[1] === 0xd8) return "jpg";
	if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "gif";
	if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45) return "webp";
	return "png";
}
