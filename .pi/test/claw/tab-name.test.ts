import { describe, expect, it } from "vitest";
import { tabNameFor } from "../../lib/claw/spawn.ts";

describe("claw worker tab name", () => {
	it("prefixes the Hoja identifier once the issue exists", () => {
		expect(tabNameFor({ label: "Fix login bug", hoja: { identifier: "TREBOL-282" } as any })).toBe("TREBOL-282 Fix login bug");
	});

	it("keeps the identifier when the label is long", () => {
		const name = tabNameFor({ label: "a very long label that goes on and on past the limit", hoja: { identifier: "TREBOL-292" } as any });
		expect(name.startsWith("TREBOL-292 ")).toBe(true);
		expect(name.length).toBeLessThanOrEqual(40);
	});

	it("falls back to the bare label when no issue exists", () => {
		expect(tabNameFor({ label: "Fix login bug" })).toBe("Fix login bug");
	});
});
