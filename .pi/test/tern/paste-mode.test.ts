import { describe, expect, it } from "vitest";
import { StringDecoder } from "node:string_decoder";
import { StdinBuffer } from "@earendil-works/pi-tui";
import { PasteMode } from "../../lib/tern/paste-mode.ts";
import { PiTernBridge } from "../../lib/tern/bridge.ts";

describe("Tern paste input", () => {
	it("enables bracketed paste once and restores it once; fallback never changes modes", () => {
		const writes: string[] = [];
		const mode = new PasteMode(s => writes.push(s));
		mode.close(); expect(writes).toEqual([]);
		mode.start(); mode.start(); mode.close(); mode.close();
		expect(writes).toEqual(["\x1b[?2004h", "\x1b[?2004l"]);
	});
	it.each(["hello", "x".repeat(10000), "first\nsecond", "á漢🙂\nend"])("preserves a chunked paste (%#. fixture) without sending", (text) => {
		let sends = 0, renders = 0;
		const bridge = new PiTernBridge({ subscribe: () => () => {}, prompt: async () => { sends++; }, abort: async () => {}, dispose() {} }, { write() {}, surfaceId: "test", credits: 1000, onRender: () => renders++ });
		bridge.start(); bridge.setDraft("before "); renders = 0;
		const input = new StdinBuffer();
		const decoder = new StringDecoder("utf8");
		input.on("paste", s => bridge.pasteText(s));
		const keys: string[] = [];
		input.on("data", s => keys.push(s));
		const bytes = Buffer.from(`\x1b[200~${text}\x1b[201~`);
		for (const byte of bytes) input.process(decoder.write(Buffer.from([byte])));
		expect(bridge.expandedDraft).toBe("before " + text);
		expect(keys.filter(Boolean)).toEqual([]);
		expect(sends).toBe(0); expect(renders).toBe(1);
		bridge.pasteText(" after");
		expect(bridge.expandedDraft).toBe("before " + text + " after");
		input.destroy(); bridge.close();
	});
});
