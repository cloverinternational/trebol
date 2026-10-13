import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PiTernBridge, type PiEventLike, type PiSessionLike } from "../../lib/tern/bridge.ts";
import { ESC, parseTspMessages } from "../../lib/tern/tsp.ts";
import { PI_COMPOSER_CSS } from "../../lib/tern/composer-style.ts";

interface FakeOptions {
	sessionId?: unknown;
	entries?: unknown;
	usage?: unknown;
	model?: unknown;
	throwUsage?: boolean;
}

function fakeSession(opts: FakeOptions = {}) {
	const listeners = new Set<(e: PiEventLike) => void>();
	const state = {
		sessionId: opts.sessionId ?? "s1",
		entries: opts.entries ?? [],
		usage: opts.usage,
		model: opts.model,
	};
	const session = {
		disposed: false,
		state,
		subscribe(l: (e: PiEventLike) => void) {
			listeners.add(l);
			return () => listeners.delete(l);
		},
		prompt: () => new Promise<void>(() => {}),
		abort: async () => {},
		dispose() {
			this.disposed = true;
		},
		get model() {
			return state.model;
		},
		sessionManager: {
			getSessionId: () => state.sessionId,
			getEntries: () => state.entries,
		},
		getContextUsage: () => {
			if (opts.throwUsage) throw new Error("stale ctx");
			return state.usage;
		},
		emit(e: PiEventLike) {
			for (const l of listeners) l(e);
		},
		listenerCount: () => listeners.size,
	};
	return session as typeof session & PiSessionLike;
}

type Writes = string[];
interface TreeNode {
	id: string;
	k: string;
	p?: Record<string, unknown>;
	c?: TreeNode[];
}

// Replays the frame ops into a node tree, as Tern does. Frames carry only changed nodes, so
// assertions read the accumulated state rather than the last raw frame.
function replay(writes: Writes): Map<string, TreeNode & { parent: string }> {
	const nodes = new Map<string, TreeNode & { parent: string }>();
	const add = (node: TreeNode, parent: string) => {
		nodes.set(node.id, { ...node, c: undefined, parent });
		for (const child of node.c ?? []) add(child, node.id);
	};
	const remove = (id: string) => {
		for (const [childId, n] of [...nodes]) if (n.parent === id) remove(childId);
		nodes.delete(id);
	};
	for (const w of writes) {
		if (!w.startsWith(`${ESC}_tsp;f;`)) continue;
		const body = parseTspMessages(w)[0]?.body as { ops: unknown[][] };
		for (const op of body.ops) {
			if (op[0] === "add") add(op[4] as TreeNode, String(op[2]));
			else if (op[0] === "del") remove(String(op[1]));
			else if (op[0] === "set") {
				const n = nodes.get(String(op[1]));
				if (n) n.p = { ...n.p, ...(op[2] as Record<string, unknown>) };
			} else if (op[0] === "text") {
				const n = nodes.get(String(op[1]));
				if (n) n.p = { ...n.p, text: `${String(n.p?.text ?? "")}${String(op[3])}` };
			}
		}
	}
	return nodes;
}

// Ordered ids of the dock's direct children, as currently applied.
function dockOrder(writes: Writes): string[] {
	return [...replay(writes).values()].filter((n) => n.parent === "dock").map((n) => n.id);
}

// Every text string currently applied under the given node id.
function textsUnder(writes: Writes, rootId: string): string[] {
	const nodes = replay(writes);
	const out: string[] = [];
	const visit = (id: string) => {
		for (const n of nodes.values()) {
			if (n.parent !== id) continue;
			if (typeof n.p?.text === "string" && n.p.text) out.push(n.p.text);
			visit(n.id);
		}
	};
	visit(rootId);
	return out;
}

const dockTexts = (writes: Writes) => textsUnder(writes, "dock");
const modelText = (writes: Writes) => {
	const spans = replay(writes).get("model-name")?.p?.spans as { t: string }[] | undefined;
	return spans?.map((s) => s.t).join("");
};

function make(session: ReturnType<typeof fakeSession>, extra: { workspace?: string; onClose?: () => void } = {}) {
	const writes: Writes = [];
	const bridge = new PiTernBridge(session, { write: (d) => writes.push(d), surfaceId: "pi", credits: 1000, ...extra });
	bridge.start("pi");
	return { bridge, writes };
}

describe("dock header", () => {
	beforeEach(() => vi.useFakeTimers({ now: 1_000_000 }));
	afterEach(() => vi.useRealTimers());

	it("shows only the model in the bar, with no status chip", () => {
		const { writes } = make(fakeSession({ model: { provider: "anthropic", id: "claude-x" } }));
		const texts = dockTexts(writes);
		expect(modelText(writes)).toBe("claude-x");
		expect(texts.join(" ")).not.toMatch(/↓ .*out| active|autogen|skill|auto:on|branch/i);
		expect(texts).not.toContain("Context —");
	});

	it("omits every optional value when Pi provides none (missing data)", () => {
		const { writes } = make(fakeSession());
		expect(dockTexts(writes)).toEqual([]);
	});

	it("omits context when usage is unknown (null after compaction) or malformed", () => {
		const cases = [
			{ tokens: null, contextWindow: 100, percent: null },
			{ percent: "80" },
			{ percent: Number.NaN },
			null,
		];
		for (const usage of cases) {
			const { writes } = make(fakeSession({ usage }));
			expect(dockTexts(writes).join(" ")).not.toContain("context");
		}
	});

	it("shows context percent when Pi reports a valid value", () => {
		const { writes } = make(fakeSession({ usage: { tokens: 420, contextWindow: 1000, percent: 42 } }));
		const ctx = replay(writes).get("ctx");
		expect(ctx?.k).toBe("meter");
		expect(ctx?.parent).toBe("composer-col");
		expect(ctx?.p?.role).toBe("omp.composer.context");
		expect(ctx?.p?.label).toBe("42%");
		expect(ctx?.p?.total).toBe("1K");
		expect(ctx?.p?.value).toBeCloseTo(0.42);
	});








	it("treats a throwing getContextUsage (stale ctx) as unknown instead of crashing", () => {
		const fake = fakeSession({ throwUsage: true });
		const { writes } = make(fake);
		expect(dockTexts(writes).join(" ")).not.toContain("context");
	});

	it("shows the current model after a model change without a model_select event", () => {
		const fake = fakeSession({ model: { provider: "openai", id: "a" } });
		const { writes } = make(fake);
		fake.state.model = { provider: "anthropic", id: "b" };
		fake.emit({ type: "agent_end" });
		expect(modelText(writes)).toBe("b");
	});

	it("stops the ticker and unsubscribes on close (teardown)", () => {
		const fake = fakeSession();
		const { bridge, writes } = make(fake);
		fake.emit({ type: "agent_start" });
		bridge.close();
		expect(fake.listenerCount()).toBe(0);
		expect(fake.disposed).toBe(true);
		const after = writes.length;
		vi.advanceTimersByTime(10_000);
		expect(writes.length).toBe(after);
	});

});

// Direct children of a node, in applied order.
function childrenOf(writes: Writes, parentId: string): string[] {
	return [...replay(writes).values()].filter((n) => n.parent === parentId).map((n) => n.id);
}

describe("Tern regions and dock structure", () => {
	it("renders focused task and acceptance questions above composer from session journal", () => {
		const entry = { type: "custom", customType: "pi-swarm-task-state", data: {
			schemaVersion: 2, revision: 1, savedAt: "2026-01-01T00:00:00Z", nextId: 2, keys: {}, tasks: [{
				id: "1", subject: "Inspect renderer", status: "in_progress", active: true, priority: "medium", dependsOn: [], notes: [],
				createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", questions: [{ id: "q1", text: "Full width?" }],
			}],
		} };
		const { writes } = make(fakeSession({ entries: [entry] }));
		expect(childrenOf(writes, "dock")).toEqual(["task-top", "composer-col"]);
		expect(replay(writes).get("task-top")?.k).toBe("col");
		expect(replay(writes).get("task-top")?.p?.role).toBe("pi.tasks");
		expect(replay(writes).get("task-question-0")?.p?.role).toBe("pi.tasks.question");
		expect(textsUnder(writes, "task-top").join(" ")).toContain("Full width?");
		expect(PI_COMPOSER_CSS).toContain("[data-role='pi.tasks.question'] { display: none; }");
		expect(PI_COMPOSER_CSS).toContain("[data-role='pi.tasks']:hover [data-role='pi.tasks.question']");
		expect(PI_COMPOSER_CSS).toContain("[data-role='pi.tasks']:focus-within [data-role='pi.tasks.question']");
	});

	it("keeps the task region absent for a fresh Pi session with no task journal", () => {
		const { writes } = make(fakeSession({ entries: [] }));
		expect(childrenOf(writes, "dock")).toEqual(["composer-col"]);
		expect(replay(writes).has("task-top")).toBe(false);
	});

	const taskEntry = () => {
		const base = { priority: "medium", dependsOn: [] as string[], notes: [], createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" };
		return { type: "custom", customType: "pi-swarm-task-state", data: {
			schemaVersion: 2, revision: 1, savedAt: "2026-01-01T00:00:00Z", nextId: 4, keys: {}, tasks: [
				{ ...base, id: "1", subject: "Inspect renderer", status: "in_progress", active: true,
					questions: [{ id: "q1", text: "Full width?" }, { id: "q2", text: "Hover works?" }],
					answers: [{ question: "q1", answer: "yes", evidence: "tool:Bash#1" }] },
				{ ...base, id: "2", subject: "Write tests", status: "pending", questions: [{ id: "q1", text: "Green?" }] },
				{ ...base, id: "3", subject: "Old work", status: "completed" },
			],
		} };
	};

	it("renders the task header like Pi's: one focused task, every question, the next task; no status chip", () => {
		const { writes } = make(fakeSession({ entries: [taskEntry()] }));
		const nodes = replay(writes);
		expect(nodes.get("task-top")?.k).toBe("col");
		expect(nodes.get("task-top")?.p?.status).toBeUndefined();
		expect(nodes.get("task-head")?.p?.text).toContain("Tasks  1/3 done");
		expect(nodes.get("task-focus")?.p?.text).toBe("● #1 Inspect renderer  Q 1/2");
		expect(nodes.get("task-focus")?.p?.title).toContain("1 of 2 acceptance questions answered");
		expect(nodes.get("task-question-0")?.p?.text).toBe("  ? q2: Hover works?");
		expect(nodes.get("task-question-0")?.p?.tone).toBe("warning");
		expect(nodes.get("task-question-1")?.p?.text).toBe("  ✓ q1: Full width?");
		expect(nodes.get("task-question-1")?.p?.tone).toBe("success");
		expect(nodes.get("task-next")?.p?.text).toBe("  ↳ Next #2 Write tests");
	});

	it("carries every task in a hover popover whose visibility is owned by the stylesheet, not program state", () => {
		const { writes } = make(fakeSession({ entries: [taskEntry()] }));
		expect(childrenOf(writes, "task-top")[0]).toBe("task-pop");
		expect(replay(writes).get("task-pop")?.p?.role).toBe("pi.tasks.pop");
		expect(childrenOf(writes, "task-pop")).toEqual(["task-pop-head", "task-pop-1", "task-pop-2", "task-pop-2-q0", "task-pop-3"]);
		const nodes = replay(writes);
		expect(nodes.get("task-pop-1")?.p?.tone).toBe("accent");
		expect(nodes.get("task-pop-2")?.p?.text).toBe("○ #2 Write tests  Q 0/1");
		expect(nodes.get("task-pop-3")?.p?.tone).toBe("success");
		expect(PI_COMPOSER_CSS).toMatch(/\[data-role='pi\.tasks\.pop'\] \{[^}]*display: none;/);
		expect(PI_COMPOSER_CSS).toContain("[data-role='pi.tasks']:hover [data-role='pi.tasks.pop'] { display: flex; }");
		expect(PI_COMPOSER_CSS).toMatch(/\[data-role='pi\.tasks\.pop'\] \{[^}]*background: var\(--card\);/);
	});

	it("clicking a task references it in the draft without sending a prompt", () => {
		const session = fakeSession({ entries: [taskEntry()] });
		let prompted = 0;
		session.prompt = () => { prompted++; return new Promise<void>(() => {}); };
		const { bridge, writes } = make(session);
		expect(replay(writes).get("task-pop-2")?.p?.actions).toMatchObject({ click: "tasks.reference=2" });
		bridge.handle({ verb: "e", body: { ev: "action", id: "task-pop-2", act: "tasks.reference", value: "2" } });
		expect(textsUnder(writes, "dock").join(" ")).toContain("task #2 ");
		expect(prompted).toBe(0);
	});

	it("folds and unfolds the questions from the header's context menu", () => {
		const { bridge, writes } = make(fakeSession({ entries: [taskEntry()] }));
		bridge.handle({ verb: "e", body: { ev: "action", id: "task-top", act: "tasks.collapse" } });
		expect(replay(writes).has("task-question-0")).toBe(false);
		expect(replay(writes).get("task-focus")?.p?.text).toContain("▸");
		bridge.handle({ verb: "e", body: { ev: "action", id: "task-top", act: "tasks.expand" } });
		expect(replay(writes).has("task-question-0")).toBe(true);
	});

	it("reloads the live named Tern stylesheet without sending a model prompt", async () => {
		const writes: Writes = [];
		let called = 0;
		const bridge = new PiTernBridge(fakeSession(), { write: d => writes.push(d), surfaceId: "pi", credits: 1000,
			reload: async () => { called++; return { css: ".sf-card[data-role='pi.tasks'] { color: red; }", pluginStatus: "Tern plugins reloaded." }; },
		});
		bridge.start();
		await bridge.submit("/reload");
		expect(called).toBe(1);
		expect(writes.filter(w => w.startsWith(`${ESC}_tsp;s;`))).toHaveLength(2);
		expect(textsUnder(writes, "main").join(" ")).toContain("Reloaded Pi resources");
		bridge.close();
	});

	it("refuses reload during a running turn and reports reload failure", async () => {
		const fake = fakeSession();
		const writes: Writes = [];
		let called = 0;
		const bridge = new PiTernBridge(fake, { write: d => writes.push(d), surfaceId: "pi", credits: 1000,
			reload: async () => { called++; throw new Error("invalid resource"); },
		});
		bridge.start();
		void bridge.submit("hello");
		await bridge.submit("/reload");
		expect(called).toBe(0);
		fake.emit({ type: "agent_end" });
		await bridge.submit("/reload");
		expect(called).toBe(1);
		expect(writes.filter(w => w.startsWith(`${ESC}_tsp;s;`))).toHaveLength(1);
		expect(textsUnder(writes, "main").join(" ")).toContain("reload failed: invalid resource");
		bridge.close();
	});

	it("shows and clears a real loading node through the Pi turn lifecycle", async () => {
		const fake = fakeSession();
		const { bridge, writes } = make(fake);
		void bridge.submit("harmless prompt");
		expect(replay(writes).get("tern.loading")?.k).toBe("spinner");
		fake.emit({ type: "agent_start" });
		expect(replay(writes).get("tern.loading")?.k).toBe("shimmer");
		fake.emit({ type: "agent_end" });
		expect(replay(writes).has("tern.loading")).toBe(false);
		bridge.close();
	});
	beforeEach(() => vi.useFakeTimers({ now: 1_000_000 }));
	afterEach(() => vi.useRealTimers());

	it("adds main, dock and layer roots in that order under the surface", () => {
		const { writes } = make(fakeSession());
		expect(childrenOf(writes, "pi")).toEqual(["main", "dock", "layer"]);
	});

	it("builds OMP's composer column (role omp.editor) with editor row and bar, in order", () => {
		const { writes } = make(fakeSession());
		expect(childrenOf(writes, "dock")).toEqual(["composer-col"]);
		expect(replay(writes).get("composer-col")?.p?.role).toBe("omp.editor");
		expect(childrenOf(writes, "composer-col")).toEqual(["composer-line", "composer-bar"]);
		expect(childrenOf(writes, "composer-line")).toEqual(["composer"]);
		expect(replay(writes).get("composer")?.p?.placeholder).toBe("What are we cooking?");
		expect(childrenOf(writes, "composer-bar")).toEqual(["extras", "usage", "send"]);
	});

	it("places the meter first in the dock column when context is valid", () => {
		const { writes } = make(fakeSession({ usage: { tokens: 10, contextWindow: 100, percent: 10 } }));
		expect(childrenOf(writes, "composer-col")).toEqual(["ctx", "composer-line", "composer-bar"]);
	});

	it("shows an unfilled meter (OMP: Context usage unknown) when tokens are unknown but the window is", () => {
		const { writes } = make(fakeSession({ usage: { tokens: null, contextWindow: 100, percent: null } }));
		const ctx = replay(writes).get("ctx");
		expect(ctx?.p?.value).toBeNull();
		expect(ctx?.p?.label).toBeUndefined();
		expect(String(ctx?.p?.title)).toContain("Context usage unknown");
	});

	it("orders the bar as OMP does: model, extras, usage, send", () => {
		const { writes } = make(fakeSession({ model: { provider: "anthropic", id: "claude-x" } }));
		expect(childrenOf(writes, "composer-bar")).toEqual(["model", "extras", "usage", "send"]);
		expect(childrenOf(writes, "model")).toEqual(["model-icon", "model-name", "model-chev"]);
	});

	it("opens the slash autocomplete in the layer root only, leaving dock unchanged", async () => {
		const { bridge, writes } = make(fakeSession());
		const dockBefore = childrenOf(writes, "dock");
		bridge.appendDraft("/");
		await vi.advanceTimersByTimeAsync(0);
		expect(childrenOf(writes, "layer")).toEqual(["complete"]);
		expect(childrenOf(writes, "complete")).toEqual(["complete.1"]);
		expect(childrenOf(writes, "complete.1")).toEqual(["complete.1.list"]);
		expect(childrenOf(writes, "dock")).toEqual(dockBefore);
		expect(replay(writes).get("complete")?.p).toEqual({ anchor: { caret: "composer" }, role: "omp.autocomplete" });
		expect(replay(writes).get("complete.1")?.p).toEqual({ role: "omp.select" });
	});

	it("removes the autocomplete from layer when it closes via Escape, keeping the draft", async () => {
		const { bridge, writes } = make(fakeSession());
		bridge.appendDraft("/");
		await vi.advanceTimersByTimeAsync(0);
		const mainBefore = childrenOf(writes, "main");
		bridge.escape();
		expect(childrenOf(writes, "layer")).toEqual([]);
		expect(childrenOf(writes, "main")).toEqual(mainBefore);
		expect(replay(writes).get("composer")?.p?.text).toBe("/");
	});

	it("Tab inserts the selected template into the composer and closes the layer", async () => {
		const commands = {
			extensionCommands: () => [],
			promptTemplates: () => [{ name: "review", description: "review code" }],
			skills: () => [],
		};
		const writes: Writes = [];
		const bridge = new PiTernBridge(fakeSession(), { write: (d) => writes.push(d), surfaceId: "pi", credits: 1000, commands });
		bridge.start("pi");
		for (const ch of "/rev") bridge.appendDraft(ch);
		await vi.advanceTimersByTimeAsync(0);
		expect(replay(writes).get("complete.1.list")?.p?.selected).toBe("complete.1.list/review");
		await bridge.tab();
		expect(bridge.draft).toBe("/review ");
		expect(childrenOf(writes, "layer")).toEqual([]);
		expect(replay(writes).get("composer")?.p?.text).toBe(bridge.draft);
	});

	it("closes the surface with a final frame and an x, leaving no further writes", () => {
		const { bridge, writes } = make(fakeSession());
		bridge.appendDraft("/");
		bridge.close();
		const last = writes.at(-1) ?? "";
		expect(last).toContain(`${ESC}_tsp;x;`);
		const count = writes.length;
		bridge.escape();
		expect(writes.length).toBe(count);
	});
});
