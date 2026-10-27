import { expect, it } from "vitest";
import { PasteInput } from "../../lib/tern/paste-input.ts";
import { PiTernBridge } from "../../lib/tern/bridge.ts";
import { splitInput } from "../../lib/tern/tsp.ts";

it("preserves exact content, ordering and controls at every small chunk size without TSP or submit", () => {
	const payload = "a\r\nb\rc\t e\u0301漢🙂\x00\x1b_tsp;e;{\"ev\":\"gone\"}\x1b\\";
	for (let size = 1; size < 16; size++) {
		let renders = 0, sends = 0;
		const bridge = new PiTernBridge({ subscribe: () => () => {}, prompt: async () => { sends++; }, abort: async () => {}, dispose() {} }, { write() {}, surfaceId: "test", onRender: () => renders++ });
		bridge.start(); renders = 0;
		const keys: string[] = []; const messages: unknown[] = [];
		const input = new PasteInput(s => { const p = splitInput(s); messages.push(...p.messages); keys.push(p.keys); }, s => bridge.pasteText(s));
		const wire = `before\x1b[200~${payload}\x1b[201~after`;
		for (let at = 0; at < wire.length; at += size) input.process(wire.slice(at, at + size));
		expect(bridge.expandedDraft).toBe(payload);
		expect(keys.join("")).toBe("beforeafter"); expect(messages).toEqual([]);
		expect(renders).toBe(1); expect(sends).toBe(0);
		bridge.close();
	}
});

it("keeps incomplete paste inert across idle flushes and preserves adjacent pastes", () => {
	const events: string[] = [];
	const input = new PasteInput(s => events.push("key:" + s), s => events.push("paste:" + s));
	input.process("\x1b[200~one\r"); input.flushEscape(); expect(events).toEqual([]);
	input.process("\x1b[201~\x1b[200~two\x1b[201~");
	input.process("\x1b"); input.flushEscape();
	 expect(events).toEqual(["paste:one\r", "paste:two", "key:\x1b"]);
});

it("keeps protocol frames separate even when their JSON contains a paste opening delimiter", () => {
	const keys: string[] = [], pastes: string[] = [];
	const input = new PasteInput(s => keys.push(s), s => pastes.push(s));
	const frame = '\x1b_tsp;e;{"text":"\\u001b[200~"}\x1b\\';
	for (const ch of frame) input.process(ch);
	expect(keys.join("")).toBe(frame); expect(pastes).toEqual([]);
});
