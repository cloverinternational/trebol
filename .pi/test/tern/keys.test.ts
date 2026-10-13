import { describe, expect, it } from "vitest";
import { StdinBuffer } from "@earendil-works/pi-tui";
import { keyEffect } from "../../lib/tern/keys.ts";

function sequencesOf(chunks: string[]): string[] {
	const buffer = new StdinBuffer({ timeout: 0, escapeTimeout: 0 });
	const out: string[] = [];
	buffer.on("data", (s: string) => out.push(s));
	for (const chunk of chunks) buffer.process(chunk);
	buffer.flush();
	return out;
}

describe("Tern key decoding", () => {
	it("does not treat the ESC of a kitty CSI u sequence as Escape", () => {
		const seqs = sequencesOf(["\x1b[114u"]);
		expect(seqs).toEqual(["\x1b[114u"]);
		expect(keyEffect(seqs[0])).toEqual({ kind: "text", text: "r" });
	});

	it("decodes shifted kitty text and enter, backspace, ctrl-c, escape", () => {
		expect(keyEffect("\x1b[114:82;2u")).toEqual({ kind: "text", text: "R" });
		expect(keyEffect("\x1b[13u")).toEqual({ kind: "submit" });
		expect(keyEffect("\r")).toEqual({ kind: "submit" });
		expect(keyEffect("\x1b[127u")).toEqual({ kind: "backspace" });
		expect(keyEffect("\x03")).toEqual({ kind: "interrupt" });
		expect(keyEffect("\x16")).toEqual({ kind: "paste" });
		expect(keyEffect("\x1b")).toEqual({ kind: "escape" });
	});

	it("maps arrows to picker movement and keeps plain legacy text", () => {
		expect(keyEffect("\x1b[A")).toEqual({ kind: "up" });
		expect(keyEffect("\x1b[B")).toEqual({ kind: "down" });
		expect(keyEffect("a")).toEqual({ kind: "text", text: "a" });
	});

	it("ignores unrecognised escape sequences", () => {
		expect(keyEffect("\x1b[?25h")).toBeNull();
	});

	it("maps left/right to question-tab moves and tab to completion", () => {
		expect(keyEffect("\x1b[C")).toEqual({ kind: "tabMove", delta: 1 });
		expect(keyEffect("\x1b[D")).toEqual({ kind: "tabMove", delta: -1 });
		expect(keyEffect("\t")).toEqual({ kind: "tab" });
		expect(keyEffect("\x1b[Z")).toEqual({ kind: "tabMove", delta: -1 });
	});
});
