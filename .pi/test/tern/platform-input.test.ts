// Linux and Windows input: the OSC 877 framing Tern uses through a Windows ConPTY (protocol/transport.md#windows)
// and the PC-keyboard chords (Ctrl for ⌘, and the keys Tern leaves to the program) the composer must handle.
import { describe, expect, it } from "vitest";
import { DraftEditor } from "../../lib/tern/draft-edit.ts";
import { keyEffect } from "../../lib/tern/keys.ts";
import { detectTern, splitInput } from "../../lib/tern/tsp.ts";

const ESC = "\x1b";
const ST = `${ESC}\\`;
const BEL = "\x07";
const apc = (verb: string, body: object) => `${ESC}_tsp;${verb};${JSON.stringify(body)}${ST}`;
const osc = (verb: string, body: object, end = ST, params = "") => `${ESC}]877;tsp;${verb};${params}${JSON.stringify(body)}${end}`;

describe("terminal → program framings", () => {
	const edit = { ev: "edit", sf: "pi", id: "composer", from: 0, to: 0, text: "", cursor: 0, len: 0 };

	it("reads OSC 877 ended by ST or BEL exactly like APC, between keys", () => {
		const r = splitInput(`a${osc("e", edit)}b${osc("e", edit, BEL)}c${apc("e", edit)}d`);
		expect(r.messages).toHaveLength(3);
		for (const m of r.messages) expect(m).toEqual({ verb: "e", body: edit });
		expect(r.keys).toBe("abcd");
		expect(r.rest).toBe("");
	});

	it("skips key=value parameters before the body", () => {
		expect(splitInput(osc("e", edit, ST, "c=k1;")).messages[0]?.body).toEqual(edit);
	});

	it("decodes C1 code points that ConPTY makes Tern send as JSON escapes", () => {
		const raw = `${ESC}]877;tsp;e;{"ev":"send","id":"composer","text":"a\\u009cb"}${ST}`;
		expect(splitInput(raw).messages[0]?.body.text).toBe("a\u009cb");
	});

	it("holds an unterminated or partial OSC 877 message until the rest arrives", () => {
		const whole = osc("e", edit);
		for (const cut of [2, 6, 9, 20]) {
			const first = splitInput(`x${whole.slice(0, cut)}`);
			expect(first.keys).toBe("x");
			expect(first.messages).toEqual([]);
			const second = splitInput(first.rest + whole.slice(cut));
			expect(second.messages).toHaveLength(1);
			expect(second.keys).toBe("");
		}
	});

	it("does not mistake an OSC that is not 877;tsp for a message", () => {
		const r = splitInput(`${ESC}]11;rgb:0000/0000/0000${BEL}`);
		expect(r.messages).toEqual([]);
		expect(r.keys).toBe(`${ESC}]11;rgb:0000/0000/0000${BEL}`);
	});

	it("detects Tern from a hello reply framed as OSC 877 (Windows), so the runner does not fall back to native Pi", () => {
		const reply = osc("r", { r: "hello", v: 1, term: "tern", ver: "1", kinds: ["editor"], features: ["edit"], apc: 4096, credits: 64 });
		expect(detectTern(`${reply}${ESC}[?62;22c`)).toMatchObject({ term: "tern", credits: 64, apc: 4096 });
	});
});

describe("PC keyboard (Linux, Windows) and macOS chords", () => {
	const cases: Array<[string, string, unknown]> = [
		["ctrl+left (xterm)", `${ESC}[1;5D`, { kind: "cursor", direction: -1, word: true, extend: false }],
		["ctrl+right", `${ESC}[1;5C`, { kind: "cursor", direction: 1, word: true, extend: false }],
		["ctrl+shift+left", `${ESC}[1;6D`, { kind: "cursor", direction: -1, word: true, extend: true }],
		["alt+left (macOS)", `${ESC}[1;3D`, { kind: "cursor", direction: -1, word: true, extend: false }],
		["home (xterm)", `${ESC}[H`, { kind: "cursor", direction: -1, word: false, extend: false, line: true }],
		["home (VT220, Linux console/tmux)", `${ESC}[1~`, { kind: "cursor", direction: -1, word: false, extend: false, line: true }],
		["end (VT220)", `${ESC}[4~`, { kind: "cursor", direction: 1, word: false, extend: false, line: true }],
		["end (SS3)", `${ESC}OF`, { kind: "cursor", direction: 1, word: false, extend: false, line: true }],
		["ctrl+home", `${ESC}[1;5H`, { kind: "cursor", direction: -1, word: false, extend: false, line: true }],
		["ctrl+end", `${ESC}[1;5F`, { kind: "cursor", direction: 1, word: false, extend: false, line: true }],
		["shift+end", `${ESC}[1;2F`, { kind: "cursor", direction: 1, word: false, extend: true, line: true }],
		["cmd+left (kitty)", `${ESC}[1;9D`, { kind: "cursor", direction: -1, word: false, extend: false, line: true }],
		["delete", `${ESC}[3~`, { kind: "deleteForward", word: false }],
		["ctrl+delete", `${ESC}[3;5~`, { kind: "deleteForward", word: true }],
		["ctrl+backspace (kitty)", `${ESC}[127;5u`, { kind: "deleteWord" }],
		["ctrl+backspace (legacy BS, Tern / Windows Terminal / VTE)", "\x08", { kind: "deleteWord" }],
		["ctrl+w", "\x17", { kind: "deleteWord" }],
		["ctrl+u", "\x15", { kind: "deleteToEdge", direction: -1 }],
		["ctrl+k", "\x0b", { kind: "deleteToEdge", direction: 1 }],
		["cmd+backspace (kitty)", `${ESC}[127;9u`, { kind: "deleteToEdge", direction: -1 }],
		["ctrl+a (PC select all)", "\x01", { kind: "selectAll" }],
		["ctrl+z (kitty)", `${ESC}[122;5u`, { kind: "undo" }],
		["cmd+z (kitty)", `${ESC}[122;9u`, { kind: "undo" }],
	];
	it.each(cases)("%s", (_name, sequence, effect) => {
		expect(keyEffect(sequence)).toEqual(effect);
	});

	it("keeps plain arrows on the ask-dialog tab path and plain backspace on its own", () => {
		expect(keyEffect(`${ESC}[D`)).toEqual({ kind: "tabMove", delta: -1 });
		expect(keyEffect("\x7f")).toEqual({ kind: "backspace" });
	});

	it("ignores kitty key releases, so one Ctrl+C is not a double press and letters are not doubled", () => {
		expect(keyEffect(`${ESC}[99;5:3u`)).toBeNull();
		expect(keyEffect(`${ESC}[104;1:3u`)).toBeNull();
		expect(keyEffect(`${ESC}[99;5u`)).toEqual({ kind: "interrupt" });
		expect(keyEffect(`${ESC}[104;1:2u`)).toEqual({ kind: "text", text: "h" }); // a repeat still types
	});
});

describe("DraftEditor line and forward edits", () => {
	const at = (text: string, cursor: number) => {
		const e = new DraftEditor({ text });
		e.applyHostEdit({ from: cursor, to: cursor, text: "", cursor, len: text.length });
		return e;
	};

	it("Home/End jump to the edges, collapsing or extending a selection", () => {
		const e = at("hello world", 5);
		e.move(-1, { line: true });
		expect(e.cursor).toBe(0);
		e.move(1, { line: true, extend: true });
		expect(e.selection).toEqual({ start: 0, end: 11 });
		e.move(-1, { line: true });
		expect([e.cursor, e.anchor]).toEqual([0, null]);
	});

	it("Delete removes the next character, Ctrl+Delete the next word, and each is one undo step", () => {
		const e = at("one two", 3);
		e.deleteForward();
		expect(e.text).toBe("onetwo");
		e.deleteForward({ word: true });
		expect(e.text).toBe("one");
		e.undo();
		expect(e.text).toBe("onetwo");
		e.move(1, { line: true });
		e.deleteForward();
		expect(e.text).toBe("onetwo");
	});

	it("Delete before a paste marker removes the whole marker", () => {
		const e = new DraftEditor();
		e.insertPaste(Array.from({ length: 12 }, (_, i) => String(i)).join("\n"));
		e.move(-1, { line: true });
		e.deleteForward();
		expect(e.text).toBe("");
	});

	it("Ctrl+U and Ctrl+K delete to the start and end; a selection is deleted instead", () => {
		const e = at("abc def", 3);
		e.deleteToEdge(1);
		expect([e.text, e.cursor]).toEqual(["abc", 3]);
		e.deleteToEdge(-1);
		expect([e.text, e.cursor]).toEqual(["", 0]);
		const s = new DraftEditor({ text: "xyz" });
		s.move(-1, { extend: true });
		s.deleteToEdge(-1);
		expect(s.text).toBe("xy");
	});

	it("a prefill is not an undo step", () => {
		const e = new DraftEditor({ text: "pre" });
		e.undo();
		expect(e.text).toBe("pre");
	});

	// Live regression (headless Tern, PI_TERN_INPUT_LOG): Shift+Home on an empty composer, then "hello" arrived
	// as "h" + "ello" and rendered "ello" — the collapsed anchor made "h" the selection.
	it.each([
		["Shift+Home on empty", (e: DraftEditor) => e.move(-1, { line: true, extend: true })],
		["Shift+Left on empty", (e: DraftEditor) => e.move(-1, { extend: true })],
		["Shift+Left then Shift+Right", (e: DraftEditor) => { e.insert("ab"); e.move(-1, { extend: true }); e.move(1, { extend: true }); }],
	])("a collapsed Shift-selection does not swallow the next typed character (%s)", (_name, prep) => {
		const e = new DraftEditor();
		prep(e);
		const before = e.text;
		e.insert("h");
		e.insert("ello");
		expect(e.text).toBe(`${before}hello`);
		expect(e.anchor).toBeNull();
	});
});
