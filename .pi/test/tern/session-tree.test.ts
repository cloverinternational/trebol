import { describe, expect, it } from "vitest";
import { PiTernBridge, type PiSessionLike } from "../../lib/tern/bridge.ts";
import { buildTreeModel, filterRows, nextFilter, SESSION_TREE_PICKER_ID, summarize, sessionTreePickerNode } from "../../lib/tern/session-tree.ts";
import { parseTspMessages, type TspMessage } from "../../lib/tern/tsp.ts";

type Node = { id: string; k: string; p?: Record<string, any>; c?: unknown[] };
// The surface as the terminal holds it, replayed from the frames the bridge wrote.
function surfaceTree(writes: string[]) {
	const nodes = new Map<string, Node>();
	for (const w of writes) for (const m of parseTspMessages(w)) for (const op of ((m.body as { ops?: unknown[][] }).ops ?? [])) {
		const walk = (n: Node) => { nodes.set(n.id, n); for (const c of (n.c ?? []) as Node[]) walk(c); };
		if (op[0] === "add") walk(op[4] as Node);
		if (op[0] === "del") nodes.delete(op[1] as string);
		if (op[0] === "set") { const n = nodes.get(op[1] as string); if (n) n.p = { ...n.p, ...(op[2] as object) }; }
	}
	return nodes;
}

// Shaped like Pi's SessionManager.getTree(): one root chain, a fork after the first answer, hook-state
// `custom` entries interleaved, and (as in 49 of 50 real sessions) a hook entry as the leaf.
const T = "2026-10-29T12:00:00.000Z";
let seq = 0;
const n = (entry: Record<string, unknown>, children: unknown[] = [], label?: string) => ({ entry: { id: `e${++seq}`, timestamp: T, ...entry }, children, ...(label ? { label } : {}) });
const user = (text: string) => ({ type: "message", message: { role: "user", content: [{ type: "text", text }] } });
const pi = (content: unknown[], extra: Record<string, unknown> = {}) => ({ type: "message", message: { role: "assistant", content, ...extra } });
const hook = { type: "custom", customType: "pi-swarm-hook-state", data: { big: "x".repeat(50) } };

function fixture() {
	seq = 0;
	const leafHook = n(hook);
	const answerB = n(pi([{ type: "text", text: "Branch B answer" }]), [leafHook]);
	const promptB = n(user("Try the other approach"), [answerB]);
	const toolResult = n({ type: "message", message: { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "ok" }] } });
	const toolOnly = n(pi([{ type: "toolCall", name: "bash", arguments: { command: "npm test" } }]), [toolResult]);
	const aborted = n(pi([], { stopReason: "aborted" }), [toolOnly]);
	const promptA = n(user("First approach"), [aborted]);
	const answer1 = n(pi([{ type: "text", text: "Hello there" }]), [promptA, promptB], "checkpoint");
	const root = n({ type: "model_change", provider: "p", modelId: "m" }, [n(user("Hi\nsecond line"), [n(hook, [answer1])])]);
	return { roots: [root], leaf: leafHook.entry.id as string, ids: { answer1: answer1.entry.id as string, promptB: promptB.entry.id as string, answerB: answerB.entry.id as string, promptA: promptA.entry.id as string, toolOnly: toolOnly.entry.id as string } };
}

describe("session tree model", () => {
	it("follows Pi's selector: active branch first, indent only at the fork, bookkeeping hidden by default", () => {
		const { roots, leaf, ids } = fixture();
		const model = buildTreeModel(roots, leaf);
		expect(model).toMatchObject({ forkCount: 1, turnCount: 3, leafId: leaf });
		const conv = filterRows(model, "no-tools");
		// The branch holding the leaf (prompt B) is listed before the other branch (prompt A).
		expect(conv.map((r) => r.text)).toEqual(["Hi second line", "Hello there", "Try the other approach", "Branch B answer", "First approach", "(no text)"]);
		// The linear chain stays at depth 0; a fork indents its children and, as in Pi, their first child once more.
		expect(conv.map((r) => r.depth)).toEqual([0, 0, 1, 2, 1, 2]);
		expect(conv.find((r) => r.id === ids.answer1)?.badges).toEqual([{ text: "checkpoint", tone: "accent", title: "Label" }, { text: "2 branches", tone: "warning", title: "Fork point" }]);
		expect(conv.find((r) => r.text === "(no text)")?.badges[0]).toMatchObject({ text: "stopped" });
		expect(conv.filter((r) => r.onActivePath).map((r) => r.id).at(-1)).toBe(ids.answerB);
		// Tool-only replies, tool output and hook state show only where asked for.
		expect(filterRows(model, "default").some((r) => r.kind === "tool")).toBe(true);
		expect(filterRows(model, "default").some((r) => r.id === ids.toolOnly)).toBe(false);
		expect(filterRows(model, "all").filter((r) => r.settings)).toHaveLength(3);
		expect(filterRows(model, "user").map((r) => r.id)).toContain(ids.promptA);
		expect(filterRows(model, "labeled").map((r) => r.id)).toEqual([ids.answer1]);
		expect(filterRows(model, "no-tools", "other APPROACH").map((r) => r.id)).toEqual([ids.promptB]);
	});

	it("renders a picker that marks where you are, names what Enter does, and previews the entry", () => {
		const { roots, leaf, ids } = fixture();
		const model = buildTreeModel(roots, leaf);
		const { node } = sessionTreePickerNode(model, { filter: "no-tools", query: "", now: Date.parse(T) + 3 * 3_600_000 });
		const p = node.p as Record<string, any>;
		const item = (id: string) => p.items.find((i: { id: string }) => i.id === id);
		expect(p).toMatchObject({ layout: "tree", tab: "no-tools", selected: ids.answerB, current: [ids.answerB], subtitle: "3 turns · 1 fork" });
		expect(p.tabs.map((t: { label: string; count: number }) => `${t.label} ${t.count}`)).toEqual(["Conversation 6", "Prompts 3", "With tools 7", "Labeled 1", "All 11"]);
		expect(item(ids.answerB)).toMatchObject({ depth: 2, dot: "accent", facts: { when: expect.stringMatching(/^\d\d:\d\d$/) } });
		expect(item(ids.promptA).tone).toBe("muted");
		expect(p.actions.find((a: { id: string }) => a.id === "navigate")).toMatchObject({ label: "Continue from here", disabled: false });
		const preview = JSON.stringify(node.c);
		expect(preview).toContain("Branch B answer");
		expect(preview).toContain("On the current branch");
		// A prompt rewinds: Pi reopens it in the composer (agent-session.js navigateTree).
		const onPrompt = sessionTreePickerNode(model, { filter: "no-tools", query: "", selected: ids.promptA, now: Date.parse(T) });
		expect((onPrompt.node.p as any).actions[1].label).toBe("Edit this prompt");
		expect(JSON.stringify(onPrompt.node.c)).toContain("reopens this prompt");
	});

	it("uses the timeline for a linear session and hides an empty Labeled tab", () => {
		seq = 0;
		const roots = [n(user("only"), [n(pi([{ type: "text", text: "reply" }]))])];
		const model = buildTreeModel(roots, "e1");
		const p = sessionTreePickerNode(model, { filter: "no-tools", query: "", now: 0 }).node.p as Record<string, any>;
		expect(p.layout).toBe("timeline");
		expect(p.items.find((i: { id: string }) => i.id === "e2").node).toBe("user");
		expect(Array.isArray(p.items)).toBe(true);
		expect(p.tabs.map((t: { id: string }) => t.id)).toEqual(["no-tools", "user", "default", "all"]);
		expect(nextFilter("default", 1, model)).toBe("all");
		expect(p.actions[1]).toMatchObject({ label: "You are here", disabled: true });
	});

	it("keeps a deep linear chain flat and cheap", () => {
		seq = 0;
		let node: any = n(hook);
		for (let i = 0; i < 20_000; i++) node = n(i % 10 ? hook : user(`turn ${i}`), [node]);
		const t0 = performance.now();
		const model = buildTreeModel([node], "e1");
		expect(model.rows).toHaveLength(20_001);
		expect(Math.max(...model.rows.map((r) => r.depth))).toBe(0);
		expect(filterRows(model, "no-tools")).toHaveLength(2_000);
		expect(performance.now() - t0).toBeLessThan(1_000);
	});

	it("reads rows as prose: headings give way to body text, markdown markers drop", () => {
		expect(summarize("# Mode: ACT\n## Plan\nThe **host** question is `answered` — see [docs](http://x).")).toBe("The host question is answered — see docs.");
		expect(summarize("# Only a heading")).toBe("Only a heading");
		expect(summarize("- first\n> quoted")).toBe("first quoted");
	});

	it("keeps hidden hook context and empty system messages out of the conversation", () => {
		seq = 0;
		const roots = [n(user("go"), [
			n({ type: "custom_message", customType: "swarm-hook-context", display: false, content: "<system-reminder>…" }, [
				n({ type: "message", message: { role: "system", content: "" } }, [
					n({ type: "custom_message", customType: "swarm-goal", display: true, content: "Goal set" }, [n(pi([{ type: "text", text: "done" }]))]),
				]),
			]),
		])];
		const model = buildTreeModel(roots, "e1");
		expect(filterRows(model, "no-tools").map((r) => r.text)).toEqual(["go", "Goal set", "done"]);
		expect(filterRows(model, "all")).toHaveLength(5);
	});

	it("adds day headers only when the session spans days", () => {
		seq = 0;
		const late = { ...user("next day"), timestamp: "2026-10-30T12:00:00.000Z" };
		const roots = [n(user("first"), [n(late)])];
		const p = sessionTreePickerNode(buildTreeModel(roots, "e1"), { filter: "no-tools", query: "", now: Date.parse("2026-10-30T10:00:00Z") }).node.p as Record<string, any>;
		expect(p.order.filter((o: unknown) => typeof o === "object").map((o: { label: string; count: number }) => [o.label, o.count])).toEqual([[expect.any(String), 1], [expect.any(String), 1]]);
		const one = sessionTreePickerNode(buildTreeModel([n(user("a"), [n(pi([{ type: "text", text: "b" }]))])], "e3"), { filter: "no-tools", query: "", now: 0 }).node.p as Record<string, any>;
		expect(one.order.every((o: unknown) => typeof o === "string")).toBe(true);
	});
});

describe("session tree in the bridge", () => {
	function setup() {
		const { roots, leaf, ids } = fixture();
		const navigated: string[] = [];
		const session = {
			subscribe: () => () => {},
			prompt: async () => {},
			abort: async () => {},
			dispose() {},
			sessionManager: { getSessionId: () => "s", getEntries: () => [], getBranch: () => [], getTree: () => roots, getLeafId: () => leaf, getSessionName: () => "Refactor" },
			navigateTree: async (id: string) => { navigated.push(id); return { cancelled: false, editorText: id === ids.promptA ? "First approach" : undefined }; },
		} as unknown as PiSessionLike;
		const writes: string[] = [];
		const bridge = new PiTernBridge(session, { write: (d: string) => writes.push(d), surfaceId: "pi", credits: 1_000_000 } as never);
		bridge.start("pi");
		const picker = () => surfaceTree(writes).get(SESSION_TREE_PICKER_ID);
		const ev = (body: Record<string, unknown>) => bridge.handle({ verb: "e", body: { sf: "pi", id: SESSION_TREE_PICKER_ID, ...body } } as TspMessage);
		return { bridge, picker, ev, navigated, ids };
	}

	it("/tree opens the picker; tabs, search, arrows and Enter drive it", async () => {
		const { bridge, picker, ev, navigated, ids } = setup();
		bridge.setDraft("/tree");
		await bridge.submitDraft();
		expect(picker()?.p).toMatchObject({ tab: "no-tools", subtitle: "Refactor · 3 turns · 1 fork", selected: ids.answerB });
		await bridge.tab();
		expect(picker()?.p?.tab).toBe("user");
		ev({ ev: "action", act: "tab", value: "no-tools" });
		bridge.appendDraft("first");
		expect(picker()?.p).toMatchObject({ query: "first", order: [ids.promptA] });
		bridge.backspaceDraft();
		expect(picker()?.p?.query).toBe("firs");
		bridge.escape();
		expect(picker()?.p?.query).toBe("");
		// The row found by the search stays selected once the search is cleared.
		expect(picker()?.p?.selected).toBe(ids.promptA);
		bridge.movePicker(-1);
		expect(picker()?.p?.selected).toBe(ids.answerB);
		ev({ ev: "select", item: ids.promptA });
		await bridge.submitDraft();
		expect(navigated).toEqual([ids.promptA]);
		expect(picker()).toBeUndefined();
	});

	it("does not navigate to the leaf you are already on, and Esc closes", async () => {
		const { bridge, picker, ev, navigated } = setup();
		bridge.setDraft("/tree");
		await bridge.submitDraft();
		bridge.escape();
		expect(picker()).toBeUndefined();
		bridge.setDraft("/tree");
		await bridge.submitDraft();
		ev({ ev: "action", act: "close" });
		expect(picker()).toBeUndefined();
		expect(navigated).toEqual([]);
	});
});
