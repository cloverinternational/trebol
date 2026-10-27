// Composer attachments for the Tern runner: images and other files pasted (Ctrl+V), dropped on the pane, or
// pasted as a path list. They show as OMP-style chips above the composer (an `image` thumbnail from a blob, or a
// file card) and go with the next submit: images as Pi image content, everything else as a list of paths.
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import type { TspNode } from "./tsp.ts";

export interface ImageContentLike {
	type: "image";
	data: string;
	mimeType: string;
}

export interface Attachment {
	/** Stable per composer: chip ids and the "#n" label. */
	n: number;
	kind: "image" | "file";
	path: string;
	name: string;
	/** Images only: the blob Tern draws (id = SHA-256 of the bytes, as transport.md#blobs keys them). */
	blob?: { id: string; mime: string; base64: string };
	width?: number;
	height?: number;
	dir?: boolean;
}

export const ATTACHMENT_LIMITS = { maxAttachments: 20, maxImageBytes: 20 * 1024 * 1024 } as const;
// The chip's remove action (its × and its context menu, which Tern labels "Remove attachment"); the event's node
// id names the chip.
export const ATTACHMENT_REMOVE = "remove-attachment";

export function attachmentFromNodeId(id: unknown): number | undefined {
	const match = typeof id === "string" ? /^chip-(\d+)(?:\.|$)/.exec(id) : null;
	return match ? Number(match[1]) : undefined;
}

// A chip head is not a truncating `text` node, so a long name (macOS "Screenshot 2026-10-27 at 3.44.53 PM.png")
// would run past the card. Cut the middle, keeping the start and the extension; the tooltip has the full path.
export const CHIP_NAME_MAX = 24;
export function shortName(name: string, max: number = CHIP_NAME_MAX): string {
	const chars = [...name];
	if (chars.length <= max) return name;
	const tail = Math.min(Math.ceil((max - 1) / 2), chars.length);
	const head = max - 1 - tail;
	return `${chars.slice(0, head).join("").trimEnd()}…${chars.slice(chars.length - tail).join("").trimStart()}`;
}

const IMAGE_MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };

// The image MIME type from the file's signature; the extension alone is not trusted.
export function sniffImageMime(bytes: Uint8Array): string | undefined {
	if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
	if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
	if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "image/gif";
	if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp";
	return undefined;
}

// Pixel size from the header, so the chip reserves the right box before Tern decodes the blob.
export function imageSize(bytes: Uint8Array, mime: string): { width: number; height: number } | undefined {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	try {
		if (mime === "image/png" && bytes.length >= 24) return { width: view.getUint32(16), height: view.getUint32(20) };
		if (mime === "image/gif" && bytes.length >= 10) return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
		if (mime === "image/webp" && bytes.length >= 30) {
			const chunk = String.fromCharCode(bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!);
			if (chunk === "VP8 ") return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
			if (chunk === "VP8L") {
				const b = view.getUint32(21, true);
				return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
			}
			if (chunk === "VP8X") {
				const w = bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16);
				const h = bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16);
				return { width: w + 1, height: h + 1 };
			}
		}
		if (mime === "image/jpeg") {
			let i = 2;
			while (i + 9 < bytes.length) {
				if (bytes[i] !== 0xff) { i++; continue; }
				const marker = bytes[i + 1]!;
				// SOF0..SOF15, except DHT (C4), JPG (C8) and DAC (CC), carry the frame size.
				if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
					return { width: view.getUint16(i + 7), height: view.getUint16(i + 5) };
				}
				if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
				i += 2 + view.getUint16(i + 2);
			}
		}
	} catch {
		// A truncated header has no size; Tern completes it from the decoded image.
	}
	return undefined;
}

export interface PathProbe {
	stat(path: string): { isFile(): boolean; isDirectory(): boolean; size: number } | undefined;
	read(path: string): Uint8Array;
}

export const FS_PROBE: PathProbe = {
	stat: (path) => { try { return statSync(path); } catch { return undefined; } },
	read: (path) => readFileSync(path),
};

function isAbsoluteAny(path: string): boolean {
	return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");
}

// Splits a pasted or dropped path list the way a terminal writes it: shell-escaped (`a\ b`), single or double
// quoted, `file://` URIs, `~/` paths, separated by whitespace or newlines. On Windows a backslash is a path
// separator, not an escape. Returns null unless every token is an absolute path that exists, so ordinary
// pasted text is never taken for a drop.
export function parseDroppedPaths(text: string, probe: PathProbe = FS_PROBE, platform: NodeJS.Platform = process.platform): string[] | null {
	// One unquoted path with spaces in it, as Finder's "Copy as Pathname" or Explorer's "Copy as path" give it.
	const whole = text.trim().replace(/^"(.*)"$/, "$1");
	if (whole && !whole.includes("\n") && isAbsoluteAny(whole) && probe.stat(whole)) return [whole];
	const tokens: string[] = [];
	let current = "";
	let started = false;
	let quote: '"' | "'" | null = null;
	const chars = [...text.trim()];
	for (let i = 0; i < chars.length; i++) {
		const ch = chars[i]!;
		if (quote) {
			if (ch === quote) quote = null;
			else if (ch === "\\" && quote === '"' && platform !== "win32" && i + 1 < chars.length && /["\\$`]/.test(chars[i + 1]!)) current += chars[++i];
			else current += ch;
			continue;
		}
		if (ch === '"' || ch === "'") { quote = ch; started = true; continue; }
		if (ch === "\\" && platform !== "win32" && i + 1 < chars.length) { current += chars[++i]; started = true; continue; }
		// Only ASCII whitespace separates paths: a terminal escapes the space but not U+202F, which macOS puts
		// before AM/PM in screenshot names ("Screenshot … at 3.39.39 PM.png"); JS `\s` would split there.
		if (/[ \t\r\n]/.test(ch)) {
			if (started) tokens.push(current);
			current = "";
			started = false;
			continue;
		}
		current += ch;
		started = true;
	}
	if (quote) return null;
	if (started) tokens.push(current);
	if (tokens.length === 0) return null;
	const paths: string[] = [];
	for (const token of tokens) {
		let path = token;
		if (/^file:\/\//i.test(path)) {
			try { path = fileURLToPath(path); } catch { return null; }
		} else if (path === "~" || path.startsWith("~/")) path = homedir() + path.slice(1);
		if (!isAbsoluteAny(path) || !probe.stat(path)) return null;
		paths.push(path);
	}
	return paths;
}

// One attachment for a path: a decodable image within the size limit becomes an image chip with a blob; any
// other file or folder is a file chip. Null when the path is gone.
export function loadAttachment(path: string, n: number, probe: PathProbe = FS_PROBE): Attachment | null {
	const stat = probe.stat(path);
	if (!stat) return null;
	const name = basename(path.replace(/[\\/]+$/, "")) || path;
	if (stat.isDirectory()) return { n, kind: "file", path, name, dir: true };
	const ext = name.toLowerCase().split(".").pop() ?? "";
	if (stat.isFile() && IMAGE_MIME[ext] && stat.size <= ATTACHMENT_LIMITS.maxImageBytes) {
		try {
			const bytes = probe.read(path);
			const mime = sniffImageMime(bytes);
			if (mime) {
				const size = imageSize(bytes, mime);
				const id = createHash("sha256").update(bytes).digest("hex");
				return { n, kind: "image", path, name, blob: { id, mime, base64: Buffer.from(bytes).toString("base64") }, ...size };
			}
		} catch {
			// Unreadable: still attach it by path below.
		}
	}
	return { n, kind: "file", path, name };
}

// OMP's composer chips (`omp.composer.chips`): a wrapping row of accent cards, each headed "#n name" with a
// thumbnail or file icon, its size, and a remove control. Hidden when empty so the composer does not move.
export function attachmentChips(list: readonly Attachment[]): TspNode {
	return {
		id: "composer-chips",
		k: "row",
		p: { role: "omp.composer.chips", gap: "sm", wrap: true, hidden: list.length === 0 },
		c: list.map((a) => {
			const label = `#${a.n} ${shortName(a.name)}`;
			const body: TspNode[] = a.kind === "image" && a.blob
				? [{ id: `chip-${a.n}.img`, k: "image", p: { blob: a.blob.id, alt: a.name, title: a.path, ...(a.width && a.height ? { w: a.width, h: a.height } : {}), max: { w: "12ch", h: "4lines" } } }]
				: [{ id: `chip-${a.n}.icon`, k: "icon", p: { name: a.dir ? "folder" : "file" } }];
			const facts = a.kind === "image" ? (a.width && a.height ? `${a.width}×${a.height}` : "image") : a.dir ? "folder" : "file";
			// The × shares the facts line: OMP's chip style lays out a thumbnail beside a head and one line.
			body.push({
				id: `chip-${a.n}.line`,
				k: "row",
				p: { gap: "sm", align: "center" },
				c: [
					{ id: `chip-${a.n}.facts`, k: "text", p: { spans: [{ t: facts, s: "dim" }], wrap: "none" } },
					{ id: `chip-${a.n}.remove`, k: "icon", p: { name: "x", title: `Remove ${a.name}`, actions: { click: ATTACHMENT_REMOVE } } },
				],
			});
			return {
				id: `chip-${a.n}`,
				k: "card",
				p: {
					role: "omp.composer.chip",
					tone: "accent",
					title: a.path,
					head: [{ t: label, s: "strong" }],
					actions: { menu: [ATTACHMENT_REMOVE] },
				},
				c: body,
			};
		}),
	};
}

// What a submit sends. Images go as Pi image content when the model takes images; files (and images a
// text-only model cannot see) are listed by absolute path after the typed text, so the agent can read them.
export function attachmentPayload(text: string, list: readonly Attachment[], vision: boolean): { text: string; images: ImageContentLike[] } {
	const images: ImageContentLike[] = [];
	const paths: string[] = [];
	for (const a of list) {
		if (a.kind === "image" && a.blob && vision) images.push({ type: "image", data: a.blob.base64, mimeType: a.blob.mime });
		else paths.push(a.dir ? `${a.path.replace(/[\\/]+$/, "")}/` : a.path);
	}
	if (paths.length === 0) return { text, images };
	const block = `Attached files:\n${paths.map((p) => `- ${p}`).join("\n")}`;
	return { text: text ? `${text}\n\n${block}` : block, images };
}

// The transcript line for the sent message: what went with it, by name.
export function attachmentSummary(list: readonly Attachment[]): string {
	return list.map((a) => `${a.kind === "image" ? "🖼" : a.dir ? "📁" : "📄"} ${a.name}`).join("  ");
}
