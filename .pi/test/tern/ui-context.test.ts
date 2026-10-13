import { describe, expect, it } from "vitest";
import { sanitizeUiLines, uiTextOf, UI_LINE_LIMIT } from "../../lib/tern/ui-context.ts";

describe("sanitizeUiLines", () => {
	it("strips ANSI and control bytes and bounds width", () => {
		const out = sanitizeUiLines(["\x1b[31mred\x1b[0m text", "a\x07b\x00c"], 5);
		expect(out).toEqual(["red …", "abc"]);
	});

	it("returns no lines for no data", () => {
		expect(sanitizeUiLines([], 40)).toEqual([]);
	});

	it("caps the number of lines", () => {
		const many = Array.from({ length: UI_LINE_LIMIT + 5 }, (_, i) => `line ${i}`);
		expect(sanitizeUiLines(many, 40)).toHaveLength(UI_LINE_LIMIT);
	});

	it("flattens embedded newlines into one line", () => {
		expect(sanitizeUiLines(["one\ntwo\r\nthree"], 40)).toEqual(["one two three"]);
	});

	it("handles width below one without throwing", () => {
		expect(sanitizeUiLines(["abc"], 0)).toEqual(["…"]);
	});

	it("keeps multi-codepoint characters intact when truncating", () => {
		expect(sanitizeUiLines(["😀😀😀"], 2)).toEqual(["😀…"]);
	});
});

describe("uiTextOf", () => {
	it("drops non-string and empty values", () => {
		expect(uiTextOf(undefined)).toBeUndefined();
		expect(uiTextOf(42)).toBeUndefined();
		expect(uiTextOf("")).toBeUndefined();
		expect(uiTextOf("ok")).toBe("ok");
	});
});
