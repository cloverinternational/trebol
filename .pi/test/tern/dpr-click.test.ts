import { describe, expect, it } from "vitest";
import { createOwnership, dprScaledPoint, refName, runTern, type Deps } from "../../lib/tern/browser.ts";

// TEMPORARY WORKAROUND regression tests, see dprScaledPoint in lib/tern/browser.ts (stencil-hq/tern-sdk#133).

const LINK = { x: 651.9036865234375, y: 743.3190307617188, width: 82.8593978881836, height: 18.416667938232422 };

function world(opts: { snapshot?: unknown; evalValue?: unknown }) {
	const calls: Record<string, any>[] = [];
	const deps: Deps = {
		paneId: 201,
		owned: createOwnership(),
		inspect: async () => ({ sessions: [{ id: 4, tabs: [{ id: 2, name: "Trebol", blocks: [{ id: 201 }, { id: 9001 }] }] }] }),
		browser: async (op: Record<string, any>) => {
			calls.push(op);
			if (op.op === "blocks") return { blocks: [{ block: 9001, url: "https://example.com/", owner: 201 }] };
			if (op.op === "state") return { url: calls.some((c) => c.op === "input") ? "https://www.iana.org/help/example-domains" : "https://example.com/", loading: false };
			if (op.op === "snapshot") return opts.snapshot ?? {};
			if (op.op === "eval") return { value: opts.evalValue ?? null };
			return {};
		},
		tern: async () => "",
		ctl: async () => ({}),
		isDirectory: async () => true,
		saveCapture: async () => "",
		delay: async () => {},
	};
	return { deps, calls };
}

const TREE = { tree: { role: "document", children: [{ role: "link", name: "Learn more", ref: "e1" }] } };

describe("dprScaledPoint", () => {
	it("scales the element's CSS center by devicePixelRatio into input space", () => {
		const p = dprScaledPoint(LINK, 0.9230769276618958);
		expect(p.x).toBeCloseTo(640.0, 0);
		expect(p.y).toBeCloseTo(694.6, 0);
	});

	it("is the identity at dpr 1", () => {
		expect(dprScaledPoint({ x: 10, y: 20, width: 40, height: 60 }, 1)).toEqual({ x: 30, y: 50 });
	});
});

describe("refName", () => {
	it("finds the accessible name of a ref in a nested snapshot tree", () => {
		expect(refName(TREE.tree, "e1")).toBe("Learn more");
		expect(refName(TREE.tree, "e9")).toBeNull();
	});
});

describe("tern act click on a dpr-scaled page", () => {
	it("clicks the scaled center through input and reports the navigation", async () => {
		const { deps, calls } = world({ snapshot: TREE, evalValue: { ...LINK, dpr: 0.9230769276618958 } });
		const out = (await runTern({ op: "act", block: 9001, action: "click", ref: "e1" }, deps)) as any;
		const input = calls.find((c) => c.op === "input");
		expect(input.events[0]).toMatchObject({ type: "mouse", action: "down", button: "left" });
		expect(input.events[0].x).toBeCloseTo(640.0, 0);
		expect(input.events[0].y).toBeCloseTo(694.6, 0);
		expect(calls.some((c) => c.op === "act")).toBe(false);
		expect(out).toMatchObject({ done: true, navigated: true, url: "https://www.iana.org/help/example-domains" });
	});

	it("falls back to the native act click when the element cannot be resolved", async () => {
		const { deps, calls } = world({ snapshot: TREE, evalValue: null });
		await runTern({ op: "act", block: 9001, action: "click", ref: "e1" }, deps);
		expect(calls.some((c) => c.op === "input")).toBe(false);
		expect(calls.some((c) => c.op === "act")).toBe(true);
	});
});
