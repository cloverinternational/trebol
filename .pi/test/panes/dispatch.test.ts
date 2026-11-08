
import { describe, expect, it } from "vitest";
import { BROWSER_OPS, OPS, PANE_OPS, createOwnership, type Inspect, type Params } from "../../lib/tern/browser.ts";
import { opsFor, paneTabName, runPaneOp, type PaneBackend } from "../../lib/panes/dispatch.ts";

/** A tiny in-memory multiplexer: one tab, one pane, enough to exercise routing. */
function fakeBackend(): PaneBackend & { calls: string[] } {
	const calls: string[] = [];
	let nextBlock = 100;
	let nextTab = 10;
	const state: Inspect = { sessions: [{ id: 1, tabs: [{ id: 5, name: null, blocks: [{ id: 50, title: "shell", cwd: "/tmp", program: "bash" }] }] }] };
	const tab = () => state.sessions[0].tabs[0];
	return {
		calls,
		async inspect() {
			calls.push("inspect");
			return state;
		},
		async newTab({ cwd, label }) {
			calls.push(`newTab:${cwd ?? ""}:${label ?? ""}`);
			const id = nextTab++;
			tab().id = tab().id || id;
			const block = nextBlock++;
			state.sessions[0].tabs.push({ id, name: label ?? null, blocks: [{ id: block, cwd }] });
			return { tab: id, block };
		},
		async renameTab(id, name) {
			calls.push(`renameTab:${id}:${name}`);
			const found = state.sessions[0].tabs.find((t) => t.id === id);
			if (found) found.name = name;
		},
		async split({ pane, direction }) {
			calls.push(`split:${pane}:${direction}`);
			const block = nextBlock++;
			tab().blocks.push({ id: block });
			return { block };
		},
		async focus(block) {
			calls.push(`focus:${block}`);
		},
		async close(block) {
			calls.push(`close:${block}`);
			tab().blocks = tab().blocks.filter((b) => b.id !== block);
		},
		async send(block, text, { enter }) {
			calls.push(`send:${block}:${text}:${enter}`);
		},
		async read(block, { lines, until }) {
			calls.push(`read:${block}:${lines ?? ""}:${until ?? ""}`);
			const text = "prompt$ hello";
			return until === undefined ? { text } : { text, matched: text.includes(until) };
		},
	};
}

const op = (patch: Partial<Params> & { op: Params["op"] }): Params => patch as Params;

describe("opsFor", () => {
	it("offers every op with a browser, and only the pane half without one", () => {
		expect(opsFor(true)).toEqual([...OPS]);
		expect(opsFor(false)).toEqual([...PANE_OPS]);
	});

	it("keeps the canonical order", () => {
		const filtered = opsFor(false);
		expect(filtered).toEqual(OPS.filter((o) => (filtered as readonly string[]).includes(o)));
	});
});

describe("runPaneOp", () => {
	it("refuses a browser op with an actionable message", async () => {
		const backend = fakeBackend();
		for (const browserOp of BROWSER_OPS) {
			await expect(runPaneOp(op({ op: browserOp, block: 50 }), backend)).rejects.toThrow(/needs the native Tern runtime/);
		}
		expect(backend.calls).toEqual([]);
	});

	it("lists tabs and panes without claiming a caller", async () => {
		const result = (await runPaneOp(op({ op: "list" }), fakeBackend())) as any;
		expect(result.tabs).toHaveLength(1);
		expect(result.tabs[0]).toMatchObject({ tab: 5, caller: false });
		expect(result.tabs[0].blocks[0]).toMatchObject({ block: 50, title: "shell", caller: false, url: null });
	});

	it("creates a tab and remembers ownership", async () => {
		const owned = createOwnership();
		const result = (await runPaneOp(op({ op: "new_tab", cwd: "/tmp" }), fakeBackend(), owned)) as any;
		expect(result).toMatchObject({ tab: 10, block: 100, session: null });
		expect(owned.tabs.has(10)).toBe(true);
		expect(owned.blocks.has(100)).toBe(true);
	});

	it("rejects a cwd that is not an existing absolute directory", async () => {
		await expect(runPaneOp(op({ op: "new_tab", cwd: "relative/dir" }), fakeBackend())).rejects.toThrow(/absolute/);
		await expect(runPaneOp(op({ op: "new_tab", cwd: "/definitely/not/here" }), fakeBackend())).rejects.toThrow(/existing absolute directory/);
	});

	it("splits beside an explicit pane and records the new block", async () => {
		const owned = createOwnership();
		const result = (await runPaneOp(op({ op: "split", block: 50, direction: "down" }), fakeBackend(), owned)) as any;
		expect(result).toMatchObject({ beside: 50, direction: "down" });
		expect(owned.blocks.has(result.block)).toBe(true);
	});

	it("refuses to close or send to a block it did not create", async () => {
		const backend = fakeBackend();
		await expect(runPaneOp(op({ op: "close", block: 50 }), backend)).rejects.toThrow(/only blocks it created can be closed/);
		await expect(runPaneOp(op({ op: "send", block: 50, text: "hi" }), backend)).rejects.toThrow(/only blocks it created can receive input/);
	});

	it("closes a block it created", async () => {
		const backend = fakeBackend();
		const owned = createOwnership();
		owned.blocks.add(77);
		expect(await runPaneOp(op({ op: "close", block: 77 }), backend, owned)).toEqual({ closed: 77 });
		expect(owned.blocks.has(77)).toBe(false);
	});

	it("rejects control characters and reports paste mode for multi-line text", async () => {
		const owned = createOwnership();
		owned.blocks.add(77);
		await expect(runPaneOp(op({ op: "send", block: 77, text: "bad\u001b[2J" }), fakeBackend(), owned)).rejects.toThrow(/control characters/);
		const result = (await runPaneOp(op({ op: "send", block: 77, text: "line1\nline2", enter: false }), fakeBackend(), owned)) as any;
		expect(result).toMatchObject({ sent: 77, mode: "paste", enter: false, chars: 11 });
	});

	it("reads the tail, and polls with until for a match", async () => {
		const backend = fakeBackend();
		expect(await runPaneOp(op({ op: "read", block: 50, lines: 5 }), backend)).toEqual({ block: 50, text: "prompt$ hello" });
		expect(await runPaneOp(op({ op: "read", block: 50, until: "hello" }), backend)).toMatchObject({ block: 50, matched: true });
		expect(backend.calls.some((c) => c.startsWith("read:50:60:hello"))).toBe(true);
	});

	it("renames only an agent-created tab", async () => {
		const owned = createOwnership();
		const backend = fakeBackend();
		await expect(runPaneOp(op({ op: "rename_tab", block: 50, name: "x" }), backend, owned)).rejects.toThrow(/only agent-created tabs/);
		owned.tabs.add(5);
		expect(await runPaneOp(op({ op: "rename_tab", block: 50, name: " work " }), backend, owned)).toEqual({ tab: 5, name: "work" });
	});

	it("rejects an unknown op instead of doing nothing", async () => {
		await expect(runPaneOp(op({ op: "nope" as Params["op"] }), fakeBackend())).rejects.toThrow(/unknown op/);
	});
});

describe("paneTabName", () => {
	it("trims, and refuses empty, multi-line or oversized names", () => {
		expect(paneTabName("  work  ")).toBe("work");
		expect(() => paneTabName("   ")).toThrow(/must not be empty/);
		expect(() => paneTabName("a\nb")).toThrow(/single line/);
		expect(() => paneTabName("x".repeat(201))).toThrow(/at most 200/);
	});
});
