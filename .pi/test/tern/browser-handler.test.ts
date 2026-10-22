import { afterEach, beforeEach, describe, expect, it } from "vitest";
import ternExtension from "../../../extensions/tern-browser/extension.ts";

// Captures the tool the real extension registers, so the test drives the registered execute handler.
function registeredTool() {
	let tool: any;
	ternExtension({ registerTool: (t: any) => (tool = t) } as any);
	return tool;
}

describe("registered tern tool handler", () => {
	const saved = process.env.TERN_PANE;
	beforeEach(() => {
		delete process.env.TERN_PANE;
	});
	afterEach(() => {
		if (saved === undefined) delete process.env.TERN_PANE;
		else process.env.TERN_PANE = saved;
	});

	it("registers as tern with the full op surface", () => {
		const tool = registeredTool();
		expect(tool.name).toBe("tern");
		expect(tool.parameters.properties.op.enum).toContain("new_tab");
	});

	it("returns an error result outside a Tern pane without running tern", async () => {
		const result = await registeredTool().execute("id", { op: "list" }, undefined, undefined, undefined);
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toMatch(/TERN_PANE is not set/);
	});

	it("returns a cancelled error result when the signal is already aborted", async () => {
		process.env.TERN_PANE = "96589519519948";
		const controller = new AbortController();
		controller.abort();
		const result = await registeredTool().execute("id", { op: "list" }, controller.signal, undefined, undefined);
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toMatch(/cancelled/);
	});
});
