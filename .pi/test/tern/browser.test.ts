import { describe, expect, it } from "vitest";
import { TERN_TOOL, createOwnership, runTern, type Deps } from "../../lib/tern/browser.ts";

type Block = { block: number; url: string; owner: number | null };

// Pane 201 (the caller) lives in the Trebol tab with pane 200, browser block 9001 and pane 9003.
// Tab 1 holds 100 and browser block 9002, another tab entirely. 9004 is the Gmail-like pre-existing block.
function world(initial: Block[] = [{ block: 9001, url: "https://mine.test", owner: null }, { block: 9002, url: "https://other.test", owner: null }]) {
	const state = {
		tabs: [
			{ id: 1, name: null, blocks: [{ id: 100 }, { id: 9002 }] },
			{ id: 2, name: "Trebol", blocks: [{ id: 200 }, { id: 201 }, { id: 9001 }, { id: 9003 }] },
		],
		browser: [...initial],
		focused: 201,
		calls: [] as Record<string, unknown>[],
		terns: [] as string[][],
		ctlCalls: [] as string[][],
		/** Where a `ctl browser open` lands: the focused pane's tab, another tab, or nowhere. `twice` makes two blocks. */
		openLands: "tab" as "tab" | "elsewhere" | "none" | "twice",
		openAnswer: { ok: true } as unknown,
		nextId: 9100,
		nextTab: 500,
	};
	const addBlock = (tabId: number, id: number) => {
		state.tabs.find((t) => t.id === tabId)!.blocks.push({ id });
	};
	const tabOfBlock = (id: number) => state.tabs.find((t) => t.blocks.some((b) => b.id === id));
	const deps: Deps = {
		paneId: 201,
		owned: createOwnership(),
		inspect: async () => ({ sessions: [{ id: 4, tabs: state.tabs }] }),
		browser: async (op) => {
			state.calls.push(op);
			if (op.op === "blocks") return { blocks: state.browser };
			if (op.op === "capture") return { data: Buffer.from("PNGDATA").toString("base64") };
			return {};
		},
		tern: async (args) => {
			state.terns.push(args);
			if (args[0] === "focus") state.focused = Number(args[1]);
			if (args[0] === "split") {
				const id = state.nextId++;
				addBlock(tabOfBlock(Number(args[1]))!.id, id);
				return "";
			}
			if (args[0] === "new") {
				const tab = state.nextTab++;
				const block = state.nextId++;
				state.tabs.push({ id: tab, name: null, blocks: [{ id: block }] });
				return JSON.stringify({ session: 4, tab, block });
			}
			if (args[0] === "rename") return JSON.stringify({ block: Number(args[1]) });
			if (args[0] === "close") {
				const id = Number(args[1]);
				for (const t of state.tabs) t.blocks = t.blocks.filter((b) => b.id !== id);
				state.tabs = state.tabs.filter((t) => t.blocks.length > 0);
				state.browser = state.browser.filter((b) => b.block !== id);
				return JSON.stringify({ block: id });
			}
			return "";
		},
		ctl: async (args) => {
			state.ctlCalls.push(args);
			if (args[0] === "state") return { focused: { id: state.focused } };
			if (args[0] === "browser") {
				const tabId = tabOfBlock(state.focused)!.id;
				const make = (landTab: number) => {
					const id = state.nextId++;
					addBlock(landTab, id);
					state.browser.push({ block: id, url: args[2], owner: null });
				};
				if (state.openLands === "tab") make(tabId);
				if (state.openLands === "elsewhere") make(1);
				if (state.openLands === "twice") {
					make(tabId);
					make(1);
				}
				return state.openAnswer;
			}
			throw new Error(`unexpected ctl ${args.join(" ")}`);
		},
		isDirectory: async (path) => path === "/existing",
		saveCapture: async () => "/fake/capture.png",
		delay: async () => {},
	};
	return { state, deps };
}

const run = (p: Parameters<typeof runTern>[0], w: ReturnType<typeof world>) => runTern(p, w.deps);

describe("tern tool spec", () => {
	it("is named tern and exposes no eval, input, session, cookie or program ops", () => {
		expect(TERN_TOOL.name).toBe("tern");
		const ops = TERN_TOOL.parameters.properties.op.enum as readonly string[];
		expect(ops).toEqual(expect.arrayContaining(["list", "new_tab", "rename_tab", "open", "close", "split", "focus", "capture"]));
		for (const banned of ["eval", "input", "session", "cookie", "run"]) expect(ops).not.toContain(banned);
		expect(TERN_TOOL.parameters.properties).not.toHaveProperty("command");
	});

	it("rejects unknown ops", async () => {
		await expect(run({ op: "eval" } as any, world())).rejects.toThrow(/unknown op/);
	});
});

describe("tab membership scope", () => {
	it("reaches a browser block in this tab regardless of its owner", async () => {
		const w = world();
		expect(await run({ op: "blocks" }, w)).toEqual({ blocks: [{ block: 9001, url: "https://mine.test", owner: null }] });
		await run({ op: "goto", block: 9001, url: "https://mine.test/next" }, w);
		expect(w.state.calls).toContainEqual({ op: "goto", block: 9001, url: "https://mine.test/next" });
	});

	it("refuses a browser block from another tab and sends no block op", async () => {
		const w = world();
		await expect(run({ op: "goto", block: 9002, url: "https://x.test" }, w)).rejects.toThrow(/not in this pane's tab/);
		await expect(run({ op: "capture", block: 9002 }, w)).rejects.toThrow(/not in this pane's tab/);
		expect(w.state.calls.some((c) => c.op === "goto" || c.op === "capture")).toBe(false);
	});

	it("refuses a pane id as a browser block", async () => {
		await expect(run({ op: "snapshot", block: 9003 }, world())).rejects.toThrow(/not a browser block/);
	});

	it("fails outside any Tern tab", async () => {
		const w = world();
		w.deps.paneId = 999;
		await expect(run({ op: "blocks" }, w)).rejects.toThrow(/not in any Tern tab/);
	});
});

describe("open regular browser", () => {
	it("opens beside this pane by default and tracks the new block", async () => {
		const w = world();
		const out = await run({ op: "open", url: "https://mail.example.test/" }, w);
		expect(out).toMatchObject({ block: 9100, url: "https://mail.example.test/", tab: 2 });
		expect(w.state.ctlCalls).toContainEqual(["browser", "open", "https://mail.example.test/"]);
		expect(w.state.calls.some((c) => c.op === "open")).toBe(false);
		expect(w.deps.owned.blocks.has(9100)).toBe(true);
	});

	it("opens beside a target pane and focuses that pane first", async () => {
		const w = world();
		w.state.focused = 200;
		await run({ op: "open", url: "https://a.test/", block: 9003 }, w);
		expect(w.state.terns).toContainEqual(["focus", "9003"]);
		expect(w.state.focused).toBe(9003);
	});

	it("does not focus when the target already has focus", async () => {
		const w = world();
		await run({ op: "open", url: "https://a.test/" }, w);
		expect(w.state.terns.some((args) => args[0] === "focus")).toBe(false);
	});

	it("refuses a target pane outside this tab without opening", async () => {
		const w = world();
		await expect(run({ op: "open", url: "https://a.test/", block: 100 }, w)).rejects.toThrow(/not in this pane's tab/);
		expect(w.state.ctlCalls).toEqual([]);
	});

	it("reports a block that landed outside the target tab, leaves it open and does not track it", async () => {
		const w = world();
		w.state.openLands = "elsewhere";
		await expect(run({ op: "open", url: "https://a.test/" }, w)).rejects.toThrow(/landed outside the target tab; left open, not tracked/);
		expect(w.deps.owned.blocks.size).toBe(0);
	});

	it("rejects ambiguous simultaneous creation instead of picking one", async () => {
		const w = world();
		w.state.openLands = "twice";
		await expect(run({ op: "open", url: "https://a.test/" }, w)).rejects.toThrow(/2 browser blocks appeared at once/);
		expect(w.deps.owned.blocks.size).toBe(0);
		expect(w.state.calls.some((c) => c.op === "close")).toBe(false);
	});

	it("fails when ctl answers ok:false", async () => {
		const w = world();
		w.state.openAnswer = { ok: false, error: "no window" };
		await expect(run({ op: "open", url: "https://a.test/" }, w)).rejects.toThrow(/ctl browser open failed/);
	});

	it("fails when ctl says ok but no browser block appears", async () => {
		const w = world();
		w.state.openLands = "none";
		await expect(run({ op: "open", url: "https://a.test/" }, w)).rejects.toThrow(/no browser block appeared/);
	});

	it("stops polling when cancelled", async () => {
		const w = world();
		w.state.openLands = "none";
		const controller = new AbortController();
		w.deps.delay = async () => controller.abort();
		w.deps.signal = controller.signal;
		await expect(run({ op: "open", url: "https://a.test/" }, w)).rejects.toThrow(/cancelled/);
	});

	it("rejects non-web addresses before calling anything", async () => {
		const w = world();
		await expect(run({ op: "open", url: "file:///etc/passwd" }, w)).rejects.toThrow(/http or https/);
		await expect(run({ op: "open", url: "--help" }, w)).rejects.toThrow(/http or https/);
		expect(w.state.ctlCalls).toEqual([]);
	});
});

describe("split and focus", () => {
	it("splits beside this pane by default, tracks the one new block", async () => {
		const w = world();
		const out = await run({ op: "split", direction: "right" }, w);
		expect(out).toEqual({ block: 9100, beside: 201, direction: "right" });
		expect(w.state.terns).toContainEqual(["split", "201", "right"]);
		expect(w.deps.owned.blocks.has(9100)).toBe(true);
	});

	it("refuses to split beside a block outside this tab or an unknown direction", async () => {
		const w = world();
		await expect(run({ op: "split", block: 9002, direction: "right" }, w)).rejects.toThrow(/not in this pane's tab/);
		await expect(run({ op: "split", direction: "left" } as any, w)).rejects.toThrow(/unknown direction/);
		expect(w.state.terns.some((args) => args[0] === "split")).toBe(false);
	});

	it("fails when the split adds no block to the tab", async () => {
		const w = world();
		w.deps.tern = async () => "";
		await expect(run({ op: "split", direction: "right" }, w)).rejects.toThrow(/expected 1/);
	});

	it("focuses a block in this tab and verifies the focus", async () => {
		const w = world();
		await expect(run({ op: "focus", block: 9001 }, w)).resolves.toEqual({ focused: 9001 });
		expect(w.state.focused).toBe(9001);
	});

	it("refuses to focus a block in another tab", async () => {
		await expect(run({ op: "focus", block: 9002 }, world())).rejects.toThrow(/not in this pane's tab/);
	});
});

describe("tabs and closing", () => {
	it("creates a tab in the caller's session, tracks it, and makes its block reachable", async () => {
		const w = world();
		const out = await run({ op: "new_tab" }, w);
		expect(out).toMatchObject({ tab: 500, session: 4 });
		expect(w.state.terns).toContainEqual(["new", "tab", "4", "--json"]);
		expect(w.deps.owned.tabs.has(500)).toBe(true);
		const listed = (await run({ op: "list" }, w)) as { tabs: { tab: number; agentCreated: boolean }[] };
		expect(listed.tabs.map((t) => [t.tab, t.agentCreated])).toEqual([[2, false], [500, true]]);
	});

	it("passes an existing absolute cwd and refuses anything else", async () => {
		const w = world();
		await run({ op: "new_tab", cwd: "/existing" }, w);
		expect(w.state.terns).toContainEqual(["new", "tab", "4", "--cwd", "/existing", "--json"]);
		await expect(run({ op: "new_tab", cwd: "relative" }, w)).rejects.toThrow(/existing absolute directory/);
		await expect(run({ op: "new_tab", cwd: "/missing" }, w)).rejects.toThrow(/existing absolute directory/);
	});

	it("renames only a tab this agent created", async () => {
		const w = world();
		await expect(run({ op: "rename_tab", block: 9001, name: "mine" }, w)).rejects.toThrow(/was not created by this agent/);
		const made = (await run({ op: "new_tab" }, w)) as { block: number };
		await expect(run({ op: "rename_tab", block: made.block, name: "--bad" }, w)).rejects.toThrow(/name must be/);
		await expect(run({ op: "rename_tab", block: made.block, name: "Research" }, w)).resolves.toEqual({ tab: 500, name: "Research" });
		expect(w.state.terns).toContainEqual(["rename", String(made.block), "Research", "--json"]);
	});

	it("closes only blocks this agent created, never this pane or pre-existing blocks", async () => {
		const w = world();
		await expect(run({ op: "close", block: 201 }, w)).rejects.toThrow(/own pane/);
		await expect(run({ op: "close", block: 9001 }, w)).rejects.toThrow(/was not created by this agent/);
		await expect(run({ op: "close", block: 9002 }, w)).rejects.toThrow(/was not created by this agent/);
		expect(w.state.terns.some((args) => args[0] === "close")).toBe(false);
	});

	it("closes a created split pane and forgets it", async () => {
		const w = world();
		const made = (await run({ op: "split", direction: "down" }, w)) as { block: number };
		await expect(run({ op: "close", block: made.block }, w)).resolves.toEqual({ closed: made.block });
		expect(w.state.terns).toContainEqual(["close", String(made.block), "--json"]);
		expect(w.deps.owned.blocks.has(made.block)).toBe(false);
	});

	it("drops ownership of a block the user closed by hand", async () => {
		const w = world();
		const made = (await run({ op: "split", direction: "down" }, w)) as { block: number };
		for (const t of w.state.tabs) t.blocks = t.blocks.filter((b) => b.id !== made.block);
		await run({ op: "list" }, w);
		expect(w.deps.owned.blocks.has(made.block)).toBe(false);
	});
});

describe("send to agent-created terminals", () => {
	it("types one-line text then presses Enter in a block this agent created", async () => {
		const w = world();
		const made = (await run({ op: "new_tab" }, w)) as { block: number };
		await expect(run({ op: "send", block: made.block, text: "pi" }, w)).resolves.toEqual({ sent: made.block, chars: 2, mode: "text", enter: true });
		expect(w.state.terns.slice(-2)).toEqual([
			["send", String(made.block), "text", "pi"],
			["send", String(made.block), "keys", "Enter"],
		]);
	});

	it("pastes multi-line text as one unit and can skip Enter", async () => {
		const w = world();
		const made = (await run({ op: "new_tab" }, w)) as { block: number };
		await run({ op: "send", block: made.block, text: "line one\nline two", enter: false }, w);
		expect(w.state.terns.at(-1)).toEqual(["send", String(made.block), "paste", "line one\nline two"]);
		expect(w.state.terns.some((a) => a[0] === "send" && a[2] === "keys")).toBe(false);
	});

	it("refuses the caller's pane, the user's blocks and blocks outside this tab", async () => {
		const w = world();
		await expect(run({ op: "send", block: 201, text: "ls" }, w)).rejects.toThrow(/was not created by this agent/);
		await expect(run({ op: "send", block: 200, text: "ls" }, w)).rejects.toThrow(/was not created by this agent/);
		await expect(run({ op: "send", block: 100, text: "ls" }, w)).rejects.toThrow(/not in this pane's tab/);
		expect(w.state.terns.some((args) => args[0] === "send")).toBe(false);
	});

	it("refuses escape/control characters, oversize or empty text without typing anything", async () => {
		const w = world();
		const made = (await run({ op: "split", direction: "down" }, w)) as { block: number };
		await expect(run({ op: "send", block: made.block, text: "a\u0003" }, w)).rejects.toThrow(/control characters/);
		await expect(run({ op: "send", block: made.block, text: "\u001b[2J" }, w)).rejects.toThrow(/control characters/);
		await expect(run({ op: "send", block: made.block, text: "a\rb" }, w)).rejects.toThrow(/control characters/);
		await expect(run({ op: "send", block: made.block, text: "x".repeat(20_001) }, w)).rejects.toThrow(/control characters/);
		await expect(run({ op: "send", block: made.block }, w)).rejects.toThrow(/text is required/);
		expect(w.state.terns.some((args) => args[0] === "send")).toBe(false);
	});
});

describe("read terminal text", () => {
	const withScreen = (screens: string[]) => {
		const w = world();
		const base = w.deps.tern;
		let i = 0;
		w.deps.tern = async (args) => {
			if (args[0] === "capture") {
				w.state.terns.push(args);
				return screens[Math.min(i++, screens.length - 1)];
			}
			return base(args);
		};
		return w;
	};

	it("answers the last N lines of a reachable block", async () => {
		const w = withScreen(["a\nb\nc\nd\n\n"]);
		await expect(run({ op: "read", block: 200, lines: 2 }, w)).resolves.toEqual({ block: 200, text: "c\nd" });
		expect(w.state.terns).toContainEqual(["capture", "200"]);
	});

	it("polls until the literal text appears", async () => {
		const w = withScreen(["$ pi", "$ pi\nloading", "$ pi\nready >"]);
		await expect(run({ op: "read", block: 200, until: "ready >" }, w)).resolves.toMatchObject({ matched: true, text: "$ pi\nready >" });
	});

	it("gives up after timeout with matched false", async () => {
		const w = withScreen(["still loading"]);
		const out = (await run({ op: "read", block: 200, until: "never", timeout: 3 }, w)) as { matched: boolean };
		expect(out.matched).toBe(false);
		expect(w.state.terns.filter((a) => a[0] === "capture").length).toBe(4);
	});

	it("refuses a block outside this tab", async () => {
		await expect(run({ op: "read", block: 100 }, withScreen(["x"]))).rejects.toThrow(/not in this pane's tab/);
	});
});
