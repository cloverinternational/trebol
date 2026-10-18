import { describe, expect, it } from "vitest";
import { DraftEditor, isLargePaste } from "../../lib/tern/draft-edit.ts";

describe("DraftEditor large paste", () => {
	it("shows a line-count marker for a large paste and expands it on submit", () => {
		const editor = new DraftEditor();
		const body = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
		editor.insert("see ");
		editor.insertPaste(body);
		editor.insert(" please");
		expect(editor.text).toBe("see [paste #1 +20 lines] please");
		expect(editor.expandedText).toBe(`see ${body} please`);
	});

	it("uses a char-count marker for a long single-line paste", () => {
		const editor = new DraftEditor();
		const body = "x".repeat(1500);
		editor.insertPaste(body);
		expect(editor.text).toBe("[paste #1 1500 chars]");
		expect(editor.expandedText).toBe(body);
	});

	it("backspace removes a whole marker", () => {
		const editor = new DraftEditor();
		editor.insertPaste("y".repeat(1200));
		editor.backspace();
		expect(editor.text).toBe("");
	});

	it("undo restores a marker after its paste was submitted and cleared", () => {
		const editor = new DraftEditor();
		editor.insertPaste("z".repeat(1200));
		const marker = editor.text;
		editor.setText("");
		editor.undo();
		expect(editor.text).toBe(marker);
		expect(editor.expandedText).toBe("z".repeat(1200));
	});

	it("keeps small pastes inline and leaves literal text without a stored paste alone", () => {
		expect(isLargePaste("short text")).toBe(false);
		expect(isLargePaste("a\n".repeat(9) + "a")).toBe(false);
		expect(isLargePaste("a\n".repeat(10) + "a")).toBe(true);
		const editor = new DraftEditor();
		editor.insert("[paste #9 +3 lines]");
		expect(editor.expandedText).toBe("[paste #9 +3 lines]");
	});
});
