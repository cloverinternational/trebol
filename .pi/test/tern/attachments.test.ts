// Composer attachments: images and other files pasted or dropped together, drawn as chips with image
// previews, removable, and sent with the next submit (images as Pi image content, files as paths).
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { attachmentChips, attachmentFromNodeId, CHIP_NAME_MAX, shortName, attachmentPayload, imageSize, loadAttachment, parseDroppedPaths, sniffImageMime, type PathProbe } from "../../lib/tern/attachments.ts";
import { PiTernBridge, type PiEventLike, type PiSessionLike } from "../../lib/tern/bridge.ts";
import { ESC, parseTspMessages } from "../../lib/tern/tsp.ts";

function crc32(buf: Buffer): number {
	let c = ~0;
	for (const b of buf) {
		c ^= b;
		for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
	}
	return ~c >>> 0;
}
function png(w: number, h: number): Buffer {
	const chunk = (type: string, data: Buffer) => {
		const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
		const td = Buffer.concat([Buffer.from(type), data]);
		const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
		return Buffer.concat([len, td, crc]);
	};
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
	const raw = Buffer.alloc((w * 3 + 1) * h);
	return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

function workspace() {
	const dir = mkdtempSync(join(tmpdir(), "pi-tern-attach-"));
	const shot = join(dir, "red shot.png");
	const blue = join(dir, "blue.png");
	const notes = join(dir, "notes.txt");
	const odd = join(dir, "we'ird(dir)");
	mkdirSync(odd);
	writeFileSync(shot, png(64, 40));
	writeFileSync(blue, png(32, 32));
	writeFileSync(notes, "hello");
	writeFileSync(join(odd, "n.txt"), "n");
	return { dir, shot, blue, notes, odd };
}

describe("parseDroppedPaths", () => {
	const w = workspace();
	it("reads Tern's drop exactly as observed: shell-escaped, space separated, trailing space", () => {
		const escaped = (p: string) => p.replace(/([ '()\\])/g, "\\$1");
		expect(parseDroppedPaths(`${escaped(w.shot)} ${w.notes} ${escaped(join(w.odd, "n.txt"))} `)).toEqual([w.shot, w.notes, join(w.odd, "n.txt")]);
	});
	it("a dragged macOS screenshot: escaped spaces and an unescaped U+202F before PM stay one path", () => {
		const shot = join(w.dir, "Screenshot 2026-10-27 at 3.39.39\u202fPM.png");
		writeFileSync(shot, png(4, 4));
		expect(parseDroppedPaths(`${shot.replace(/ /g, "\\ ")} `)).toEqual([shot]);
		expect(loadAttachment(shot, 1)).toMatchObject({ kind: "image", name: "Screenshot 2026-10-27 at 3.39.39\u202fPM.png" });
	});
	it("takes quoted paths, file:// URIs and one path per line", () => {
		expect(parseDroppedPaths(`'${w.shot}'\n"${w.blue}"\nfile://${encodeURI(w.notes)}`)).toEqual([w.shot, w.blue, w.notes]);
	});
	it("leaves ordinary text alone: prose, a relative path, a missing file, an unclosed quote", () => {
		expect(parseDroppedPaths("please look at this")).toBeNull();
		expect(parseDroppedPaths("notes.txt")).toBeNull();
		expect(parseDroppedPaths(`${w.notes} /no/such/file`)).toBeNull();
		expect(parseDroppedPaths(`'${w.notes}`)).toBeNull();
		expect(parseDroppedPaths("   ")).toBeNull();
	});
	it("Windows: backslashes are separators, quotes group a path with spaces", () => {
		const seen: string[] = [];
		const probe: PathProbe = { stat: (p) => { seen.push(p); return { isFile: () => true, isDirectory: () => false, size: 1 }; }, read: () => new Uint8Array() };
		expect(parseDroppedPaths(`"C:\\Users\\me\\My Pics\\a.png" C:\\b.txt \\\\srv\\share\\c.pdf`, probe, "win32")).toEqual(["C:\\Users\\me\\My Pics\\a.png", "C:\\b.txt", "\\\\srv\\share\\c.pdf"]);
	});
});

describe("image sniffing and sizes", () => {
	it("trusts the signature, not the extension, and reads PNG/GIF/JPEG/WebP sizes", () => {
		expect(sniffImageMime(png(3, 2))).toBe("image/png");
		expect(imageSize(png(64, 40), "image/png")).toEqual({ width: 64, height: 40 });
		const gif = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 10, 0, 7, 0]);
		expect(sniffImageMime(gif)).toBe("image/gif");
		expect(imageSize(gif, "image/gif")).toEqual({ width: 10, height: 7 });
		// SOI, APP0 (len 4), SOF0 with height 300, width 500.
		const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0x01, 0x2c, 0x01, 0xf4, 3, 0, 0, 0]);
		expect(sniffImageMime(jpeg)).toBe("image/jpeg");
		expect(imageSize(jpeg, "image/jpeg")).toEqual({ width: 500, height: 300 });
		const webp = Buffer.alloc(30);
		webp.write("RIFF", 0); webp.write("WEBPVP8X", 8);
		webp[24] = 99; webp[27] = 49; // 100 × 50
		expect(sniffImageMime(webp)).toBe("image/webp");
		expect(imageSize(webp, "image/webp")).toEqual({ width: 100, height: 50 });
		expect(sniffImageMime(Buffer.from("not an image"))).toBeUndefined();
	});
	it("a .png that is not a PNG, a folder and a missing path load as file / folder / null", () => {
		const w = workspace();
		const fake = join(w.dir, "fake.png");
		writeFileSync(fake, "text");
		expect(loadAttachment(fake, 1)).toMatchObject({ kind: "file", name: "fake.png" });
		expect(loadAttachment(w.odd, 2)).toMatchObject({ kind: "file", dir: true, name: "we'ird(dir)" });
		expect(loadAttachment(join(w.dir, "gone"), 3)).toBeNull();
		expect(loadAttachment(w.shot, 4)).toMatchObject({ kind: "image", width: 64, height: 40, blob: { mime: "image/png" } });
	});
});

describe("chips and payload", () => {
	const w = workspace();
	const list = [loadAttachment(w.shot, 1)!, loadAttachment(w.notes, 2)!, loadAttachment(w.blue, 3)!];
	it("an image chip draws its blob with its pixel size inside OMP's 12ch × 4lines thumbnail; a file chip an icon", () => {
		const row = attachmentChips(list);
		expect(row.p).toMatchObject({ role: "omp.composer.chips", wrap: true, hidden: false });
		const [shot, notes] = row.c!;
		expect(shot!.p).toMatchObject({ role: "omp.composer.chip", head: [{ t: "#1 red shot.png", s: "strong" }], actions: { menu: ["remove-attachment"] } });
		expect(shot!.c![0]).toMatchObject({ k: "image", p: { blob: list[0]!.blob!.id, w: 64, h: 40, max: { w: "12ch", h: "4lines" } } });
		expect(notes!.c![0]).toMatchObject({ k: "icon", p: { name: "file" } });
		expect(shot!.c!.at(-1)!.c!.at(-1)).toMatchObject({ id: "chip-1.remove", k: "icon", p: { name: "x", actions: { click: "remove-attachment" } } });
		expect(attachmentFromNodeId("chip-12.remove")).toBe(12);
		expect(attachmentFromNodeId("chip-3")).toBe(3);
		expect(attachmentFromNodeId("composer")).toBeUndefined();
	});
	it("a long name is cut in the middle so the chip head fits; the tooltip keeps the full path", () => {
		const name = "Screenshot 2026-10-27 at 3.44.53\u202fPM.png";
		expect(shortName(name)).toBe("Screenshot…44.53\u202fPM.png");
		expect([...shortName(name)].length).toBeLessThanOrEqual(CHIP_NAME_MAX);
		expect(shortName("red shot.png")).toBe("red shot.png");
		const chip = attachmentChips([{ n: 1, kind: "file", path: `/tmp/${name}`, name }]).c![0]!;
		expect(chip.p).toMatchObject({ head: [{ t: `#1 ${shortName(name)}` }], title: `/tmp/${name}` });
	});
	it("vision model: images as image content, files as paths; text-only model: everything as paths", () => {
		const vision = attachmentPayload("look", list, true);
		expect(vision.images.map((i) => i.mimeType)).toEqual(["image/png", "image/png"]);
		expect(vision.images[0]!.data).toBe(list[0]!.blob!.base64);
		expect(vision.text).toBe(`look\n\nAttached files:\n- ${w.notes}`);
		const blind = attachmentPayload("", list, false);
		expect(blind.images).toEqual([]);
		expect(blind.text).toBe(`Attached files:\n- ${w.shot}\n- ${w.notes}\n- ${w.blue}`);
	});
});

function fakeSession(input: string[] = ["text", "image"]) {
	const calls: Array<{ text: string; options?: { images?: Array<{ mimeType: string }>; streamingBehavior?: string } }> = [];
	const listeners = new Set<(e: PiEventLike) => void>();
	const session = {
		calls,
		emit: (e: PiEventLike) => { for (const l of listeners) l(e); },
		subscribe(l: (e: PiEventLike) => void) { listeners.add(l); return () => listeners.delete(l); },
		prompt: async (text: string, options?: { images?: Array<{ mimeType: string }> }) => { calls.push({ text, ...(options ? { options } : {}) }); },
		abort: async () => {},
		dispose() {},
		model: { provider: "p", id: "m", input },
		sessionManager: { getSessionId: () => "s1", getEntries: () => [] },
		getContextUsage: () => undefined,
	};
	return session as typeof session & PiSessionLike;
}

type Node = { id: string; k: string; p?: Record<string, unknown>; c?: Node[]; parent?: string };
function tree(writes: string[]): Map<string, Node> {
	const nodes = new Map<string, Node>();
	const add = (n: Node, parent: string): void => { nodes.set(n.id, { ...n, c: undefined, parent }); for (const c of n.c ?? []) add(c, n.id); };
	const del = (id: string): void => { for (const [cid, n] of [...nodes]) if (n.parent === id) del(cid); nodes.delete(id); };
	for (const w of writes) {
		if (!w.startsWith(`${ESC}_tsp;f;`)) continue;
		for (const op of (parseTspMessages(w)[0]?.body as { ops: unknown[][] }).ops) {
			if (op[0] === "add") add(op[4] as Node, String(op[2]));
			else if (op[0] === "del") del(String(op[1]));
			else if (op[0] === "set") { const n = nodes.get(String(op[1])); if (n) n.p = { ...n.p, ...(op[2] as Record<string, unknown>) }; }
		}
	}
	return nodes;
}
const blobIds = (writes: string[]) => writes.filter((w) => w.startsWith(`${ESC}_tsp;b;`)).map((w) => /"id":"([0-9a-f]{64})"/.exec(w)?.[1] ?? w.slice(0, 120));

describe("PiTernBridge composer attachments", () => {
	function make(input?: string[]) {
		const writes: string[] = [];
		const session = fakeSession(input);
		const bridge = new PiTernBridge(session, { write: (d) => writes.push(d), surfaceId: "pi", credits: 1000 });
		bridge.start("pi");
		return { bridge, writes, session };
	}

	it("a drop of two images and a file at once: three chips above the editor, image blobs sent before the frame", () => {
		const { bridge, writes } = make();
		const w = workspace();
		const before = writes.length;
		bridge.pasteText(`${w.shot.replace(/ /g, "\\ ")} ${w.notes} ${w.blue} `);
		expect(bridge.draft).toBe("");
		expect(bridge.attachments.map((a) => a.kind)).toEqual(["image", "file", "image"]);
		const fresh = writes.slice(before);
		const firstFrame = fresh.findIndex((x) => x.startsWith(`${ESC}_tsp;f;`));
		const blobs = fresh.map((x, i) => [x, i] as const).filter(([x]) => x.startsWith(`${ESC}_tsp;b;`));
		expect(blobs.length).toBeGreaterThanOrEqual(2);
		expect(blobs.every(([, i]) => i < firstFrame)).toBe(true);
		const nodes = tree(writes);
		expect(nodes.get("composer-chips")?.parent).toBe("composer-col");
		expect(["chip-1", "chip-2", "chip-3"].map((id) => nodes.get(id)?.k)).toEqual(["card", "card", "card"]);
		expect(nodes.get("chip-1.img")?.p).toMatchObject({ blob: bridge.attachments[0]!.blob!.id, w: 64, h: 40 });
		expect(blobIds(writes).length).toBeGreaterThan(0);
	});

	it("Ctrl+V adds to the same row; a duplicate path is not added twice", async () => {
		const w = workspace();
		const writes: string[] = [];
		const bridge = new PiTernBridge(fakeSession(), {
			write: (d) => writes.push(d), surfaceId: "pi", credits: 1000,
			clipboard: { filePaths: async () => [w.notes, w.blue], image: async () => null, text: async () => null },
		});
		bridge.start("pi");
		bridge.pasteText(w.shot);
		await bridge.pasteClipboard();
		await bridge.pasteClipboard();
		expect(bridge.attachments.map((a) => a.name)).toEqual(["red shot.png", "notes.txt", "blue.png"]);
	});

	it("the × (or the chip's menu) removes one chip; ⌫ in an empty composer removes the last; Ctrl+C clears all", () => {
		const { bridge, writes } = make();
		const w = workspace();
		bridge.pasteText(`${w.notes} ${w.blue} ${w.odd.replace(/([ '()])/g, "\\$1")}`);
		bridge.handle({ verb: "e", body: { sf: "pi", ev: "action", id: "chip-1.remove", act: "remove-attachment" } } as never);
		expect(bridge.attachments.map((a) => a.n)).toEqual([2, 3]);
		bridge.handle({ verb: "e", body: { sf: "pi", ev: "action", id: "chip-3", act: "remove-attachment" } } as never);
		expect(bridge.attachments.map((a) => a.n)).toEqual([2]);
		bridge.appendDraft("x");
		bridge.backspaceDraft();
		expect(bridge.attachments).toHaveLength(1); // that ⌫ deleted the typed "x"
		bridge.backspaceDraft();
		expect(bridge.attachments).toHaveLength(0);
		expect(tree(writes).has("composer-chips")).toBe(false);
		bridge.pasteText(w.notes);
		bridge.appendDraft("y");
		bridge.clearDraft();
		expect([bridge.draft, bridge.attachments.length]).toEqual(["", 0]);
	});

	it("Enter sends text, images as Pi image content and files as paths, then empties the row", async () => {
		const { bridge, session, writes } = make();
		const w = workspace();
		bridge.pasteText(`${w.shot.replace(/ /g, "\\ ")} ${w.notes} ${w.blue}`);
		for (const ch of "compare these") bridge.appendDraft(ch);
		await bridge.submitDraft();
		expect(session.calls).toHaveLength(1);
		expect(session.calls[0]!.text).toBe(`compare these\n\nAttached files:\n- ${w.notes}`);
		expect(session.calls[0]!.options?.images?.map((i) => i.mimeType)).toEqual(["image/png", "image/png"]);
		expect(bridge.attachments).toHaveLength(0);
		const user = [...tree(writes).values()].find((n) => n.k === "md" && String(n.p?.text).startsWith("compare these"));
		expect(String(user?.p?.text)).toContain("🖼 red shot.png  📄 notes.txt  🖼 blue.png");
	});

	it("attachments alone send; a text-only model gets every attachment as a path and no images", async () => {
		const { bridge, session } = make(["text"]);
		const w = workspace();
		bridge.pasteText(w.shot);
		await bridge.submitDraft();
		expect(session.calls).toEqual([{ text: `Attached files:\n- ${w.shot}` }]);
	});

	it("a plain prompt without attachments still reaches Pi with one argument", async () => {
		const { bridge, session } = make();
		for (const ch of "hi") bridge.appendDraft(ch);
		await bridge.submitDraft();
		expect(session.calls).toEqual([{ text: "hi" }]);
	});

	it("during a turn, the queued follow-up carries the images", async () => {
		const { bridge, session } = make();
		const w = workspace();
		for (const ch of "first") bridge.appendDraft(ch);
		await bridge.submitDraft();
		bridge.pasteText(w.blue);
		for (const ch of "second") bridge.appendDraft(ch);
		await bridge.submitFollowUp(bridge.expandedDraft);
		expect(session.calls[1]).toMatchObject({ text: "second", options: { streamingBehavior: "followUp" } });
		expect(session.calls[1]!.options?.images).toHaveLength(1);
	});

	it("pasted paths inside an open extension prompt stay text there", () => {
		const { bridge } = make();
		const w = workspace();
		void (bridge.uiContext() as { input(title: string): Promise<unknown> }).input("Path?");
		bridge.pasteText(w.notes);
		expect(bridge.attachments).toHaveLength(0);
	});
});
