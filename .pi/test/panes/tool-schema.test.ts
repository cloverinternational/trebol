
import { describe, expect, it } from "vitest";
import { BROWSER_OPS, OPS, PANE_OPS, TERN_TOOL, offersOp, ternToolFor } from "../../lib/tern/browser.ts";

const opsOf = (tool: { parameters: { properties: { op: { enum: readonly string[] } } } }) => [...tool.parameters.properties.op.enum];

describe("OPS partition", () => {
	it("splits the contract into disjoint pane and browser halves", () => {
		expect([...PANE_OPS, ...BROWSER_OPS].sort()).toEqual([...OPS].sort());
		expect(PANE_OPS.filter((op) => (BROWSER_OPS as readonly string[]).includes(op))).toEqual([]);
		expect(PANE_OPS).toHaveLength(8);
		expect(BROWSER_OPS).toHaveLength(6);
	});
});

describe("ternToolFor", () => {
	it("defaults to the complete historical tool", () => {
		const tool = ternToolFor();
		expect(opsOf(tool)).toEqual([...OPS]);
		expect(tool.name).toBe(TERN_TOOL.name);
		expect(tool.description).toBe(TERN_TOOL.description);
	});

	it("drops every browser op when restricted to panes", () => {
		const tool = ternToolFor(PANE_OPS);
		expect(opsOf(tool)).toEqual([...PANE_OPS]);
		for (const op of BROWSER_OPS) expect(opsOf(tool)).not.toContain(op);
	});

	it("does not advertise a browser surface in the degraded description", () => {
		const tool = ternToolFor(PANE_OPS);
		expect(tool.description).toContain("no browser surface");
		expect(tool.description).not.toContain("snapshot (block; tree with element refs)");
	});

	it("keeps every pane parameter that the surviving ops need", () => {
		const tool = ternToolFor(PANE_OPS);
		for (const key of ["block", "cwd", "name", "direction", "text", "keys", "enter", "lines", "until", "timeout"]) {
			expect(tool.parameters.properties).toHaveProperty(key);
		}
	});

	it("does not mutate the shared tool literal", () => {
		ternToolFor(PANE_OPS);
		expect(opsOf(TERN_TOOL)).toEqual([...OPS]);
	});
});

describe("offersOp", () => {
	it("rejects an op a backend cannot serve", () => {
		expect(offersOp(PANE_OPS, "send")).toBe(true);
		expect(offersOp(PANE_OPS, "snapshot")).toBe(false);
	});
});
