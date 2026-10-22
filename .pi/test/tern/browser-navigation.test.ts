import { describe, expect, it } from "vitest";
import { createOwnership, runTern, ternFailure, DEAD_PANE_HINT, type Deps } from "../../lib/tern/browser.ts";

type Page = { url: string; title?: string; loading: boolean };

/** A block whose page state advances through `script` one read at a time; the last state repeats. */
function fakeWorld(script: Page[], opts: { paneAlive?: boolean; actAnswer?: unknown } = {}) {
	let reads = 0;
	const calls: Record<string, unknown>[] = [];
	const deps: Deps = {
		paneId: 201,
		owned: createOwnership(),
		inspect: async () => ({
			sessions: [{ id: 4, tabs: [{ id: 2, name: "Trebol", blocks: opts.paneAlive === false ? [{ id: 9001 }] : [{ id: 201 }, { id: 9001 }] }] }],
		}),
		browser: async (op) => {
			calls.push(op);
			if (op.op === "blocks") return { blocks: [{ block: 9001, url: script[0].url, owner: 201 }] };
			if (op.op === "state") return script[Math.min(reads++, script.length - 1)];
			if (op.op === "act") return opts.actAnswer ?? { done: true };
			if (op.op === "goto") return { done: true };
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

const SEMRUSH = "https://www.semrush.com/";
const LOGIN = "https://login.semrush.com/";

describe("tern browser act click waits for the navigation it causes", () => {
	it("reports the new page after a click that navigates", async () => {
		const { deps } = fakeWorld([
			{ url: SEMRUSH, loading: false },
			{ url: SEMRUSH, loading: false },
			{ url: SEMRUSH, loading: true },
			{ url: LOGIN, loading: true },
			{ url: LOGIN, title: "Log in", loading: false },
		]);
		const out = (await runTern({ op: "act", block: 9001, action: "click", ref: "e4" }, deps)) as any;
		expect(out).toMatchObject({ done: true, navigated: true, loaded: true, url: LOGIN, title: "Log in" });
	});

	it("says it did not navigate when the page stays put", async () => {
		const { deps } = fakeWorld([{ url: SEMRUSH, loading: false }]);
		const out = (await runTern({ op: "act", block: 9001, action: "click", ref: "e4" }, deps)) as any;
		expect(out).toMatchObject({ done: true, navigated: false, loaded: true, url: SEMRUSH });
	});

	it("returns loaded=false when the navigation outlives its budget instead of hanging", async () => {
		const { deps } = fakeWorld([{ url: SEMRUSH, loading: false }, { url: LOGIN, loading: true }]);
		const out = (await runTern({ op: "act", block: 9001, action: "click", ref: "e4" }, deps)) as any;
		expect(out).toMatchObject({ navigated: true, loaded: false, url: LOGIN });
	});
});

describe("tern browser goto waits for load", () => {
	it("does not answer until the page finishes loading", async () => {
		const { deps } = fakeWorld([
			{ url: SEMRUSH, loading: true },
			{ url: LOGIN, loading: true },
			{ url: LOGIN, title: "Log in – Semrush", loading: false },
		]);
		const out = (await runTern({ op: "goto", block: 9001, url: LOGIN }, deps)) as any;
		expect(out).toMatchObject({ loaded: true, url: LOGIN, title: "Log in – Semrush" });
	});
});

describe("tern browser dead pane", () => {
	it("refuses with the actionable hint when this pane is no longer in any tab", async () => {
		const { deps } = fakeWorld([{ url: SEMRUSH, loading: false }], { paneAlive: false });
		await expect(runTern({ op: "list" }, deps)).rejects.toThrow(DEAD_PANE_HINT);
	});

	it("maps the daemon's 'no such pane' error to the actionable hint", () => {
		expect(ternFailure("send", "error: no such pane in this session daemon").message).toBe(`tern send: ${DEAD_PANE_HINT}`);
	});

	it("keeps other tern failures bounded and unchanged", () => {
		expect(ternFailure("capture", "boom").message).toBe("tern capture failed: boom");
	});
});
