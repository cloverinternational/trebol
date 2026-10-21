// Work table in the Tern transcript: one list of factual rows per run of tool steps, detail beneath the
// selected row, the group's own fold driven by native toggle events, and a bottom Collapse work control.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PiTernBridge, TranscriptProjector, type PiEventLike, type PiSessionLike } from "../../lib/tern/bridge.ts";
import type { TspNode } from "../../lib/tern/tsp.ts";

type Msg = Parameters<PiTernBridge["handle"]>[0];
const CURRENT = { id: "7", subject: "Fix login" };
const start = (p: TranscriptProjector, toolCallId: string, args: unknown = { command: "echo" }, name = "bash") => p.apply({ type: "tool_execution_start", toolCallId, toolName: name, args });
const end = (p: TranscriptProjector, toolCallId: string) => p.apply({ type: "tool_execution_end", toolCallId, toolName: "bash", result: { content: [{ type: "text", text: "ok" }], details: { exit_code: 0, duration_ms: 10 } }, isError: false });
const user = (p: TranscriptProjector, text: string) => p.apply({ type: "message_start", message: { role: "user", content: [{ type: "text", text }] } });
const groups = (nodes: readonly TspNode[]) => nodes.filter((n) => n.p?.role === "tern.work" || n.p?.role === "tern.work-live");
const lists = (group: TspNode) => (group.c ?? []).filter((n) => n.k === "list");
const rows = (group: TspNode) => lists(group).flatMap((l) => (l.c ?? []).map((item) => item));

describe("work rows (projector)", () => {
	it("renders one aligned factual row per tool step, in order, with stable row ids", () => {
		const p = new TranscriptProjector();
		user(p, "fix login");
		start(p, "a", { description: "Check build", command: "npm test" });
		start(p, "b", { path: "src/login.ts" }, "read");
		end(p, "a");
		// The default live view is the activity panel (running steps only); this checks the all-steps rows.
		p.setGroupView("g-t-a", "all");
		const [live] = groups(p.nodes(false, { currentTask: CURRENT }));
		expect(rows(live!).map((r) => [r.id, r.p?.label, r.p?.detail, r.p?.value])).toEqual([
			["row-t-a", "Run", "Check build", "Done · 10 ms"],
			["row-t-b", "Read", "src/login.ts", "Running"],
		]);
		expect(lists(live!)[0]!.p).toMatchObject({ role: "tern.work-rows" });
	});

	it("keeps narration between tool steps in chronological order around separate lists", () => {
		const p = new TranscriptProjector();
		user(p, "go");
		start(p, "a");
		end(p, "a");
		p.apply({ type: "message_start", message: { role: "assistant", content: [] } });
		p.apply({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Next step" } });
		start(p, "b");
		const [live] = groups(p.nodes(true, { currentTask: CURRENT }));
		// Focus, two lists around the narration, then the All-steps mode's Activity control and Collapse work.
		expect((live!.c ?? []).map((n) => n.k)).toEqual(["text", "list", "md", "list", "text", "text"]);
	});

	it("shows the current task only in the active group, and only when one is supplied", () => {
		const p = new TranscriptProjector();
		user(p, "one");
		start(p, "a");
		end(p, "a");
		p.apply({ type: "agent_end" });
		user(p, "two");
		start(p, "b");
		const withTask = groups(p.nodes(false, { currentTask: CURRENT }));
		const [settled, active] = withTask;
		expect(settled!.p?.role).toBe("tern.work");
		expect((settled!.c ?? []).some((n) => n.p?.role === "tern.work-focus")).toBe(false);
		expect((active!.c ?? [])[0]).toMatchObject({ k: "text", p: { role: "tern.work-focus", text: "Current task · #7 Fix login" } });
		// Without a supplied task the heading is the labelled request, never the current task.
		expect(groups(p.nodes(false)).flatMap((g) => g.c ?? []).some((n) => String(n.p?.text).startsWith("Current task"))).toBe(false);
	});

	it("drops the work-rows selection of a group the moment its items are replaced by a new session", () => {
		const p = new TranscriptProjector();
		user(p, "go");
		start(p, "a");
		const [live] = groups(p.nodes(false));
		p.setGroupCollapsed(live!.id, false);
		p.selectRow(live!.id, "row-t-a");
		p.replaceFromSessionBranch([]);
		expect(p.nodes(false)).toEqual([]);
		user(p, "go");
		start(p, "a");
		const [again] = groups(p.nodes(false));
		expect(again!.id).toBe(live!.id);
		expect(again!.p?.collapsed).toBe(false);
		expect(lists(again!)[0]!.p?.selected).toBeUndefined();
	});
});

describe("work rows through the bridge (native events)", () => {
	beforeEach(() => vi.useFakeTimers({ now: 1_000_000 }));
	afterEach(() => vi.useRealTimers());

	function harness() {
		const listeners = new Set<(e: PiEventLike) => void>();
		const session = {
			state: {},
			subscribe(l: (e: PiEventLike) => void) { listeners.add(l); return () => listeners.delete(l); },
			prompt: () => new Promise<void>(() => {}),
			abort: async () => {},
			dispose() {},
			sessionManager: { getSessionId: () => "work-table", getEntries: () => [], getBranch: () => [] },
			emit(e: PiEventLike) { for (const l of listeners) l(e); },
		} as unknown as PiSessionLike & { emit(e: PiEventLike): void };
		const seen = { nodes: [] as TspNode[] };
		const bridge = new PiTernBridge(session, { write: () => {}, surfaceId: "pi", credits: 1_000_000, onRender: (nodes) => { seen.nodes = [...nodes]; } } as never);
		bridge.start("pi");
		return { session, bridge, nodes: () => seen.nodes };
	}
	const send = (bridge: PiTernBridge, body: Record<string, unknown>) => bridge.handle({ verb: "e", body } as Msg);
	const toggle = (bridge: PiTernBridge, id: string, collapsed: boolean) => send(bridge, { ev: "toggle", id, collapsed });
	const collapseWork = (bridge: PiTernBridge, id: string) => send(bridge, { ev: "action", sf: "pi", act: "work.collapse", value: id });
	const select = (bridge: PiTernBridge, listId: string, item: string) => send(bridge, { ev: "select", sf: "pi", id: listId, item });

	it("a toggle event sets only its group's fold, and an expanded group hides the duplicate streaming tail", () => {
		const h = harness();
		h.session.emit({ type: "agent_start" });
		h.session.emit({ type: "message_start", message: { role: "user", content: [{ type: "text", text: "fix login" }] } });
		h.session.emit({ type: "tool_execution_start", toolCallId: "a", toolName: "bash", args: { command: "x" } });
		h.session.emit({ type: "message_start", message: { role: "assistant", content: [] } });
		h.session.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Checking the\nbuild log" } });
		const gid = groups(h.nodes())[0]!.id;
		expect(groups(h.nodes())[0]!.p?.collapsed).toBe(false);
		expect(h.nodes().some((n) => n.p?.role === "tern.work-tail")).toBe(false);
		toggle(h.bridge, gid, true);
		expect(groups(h.nodes())[0]!.p?.collapsed).toBe(true);
		expect(h.nodes().some((n) => n.p?.role === "tern.work-tail")).toBe(true);
		toggle(h.bridge, gid, false);
		expect(groups(h.nodes())[0]!.p?.collapsed).toBe(false);
		expect(h.nodes().some((n) => n.p?.role === "tern.work-tail")).toBe(false);
	});

	it("Collapse work closes exactly its group and leaves the other group's fold as the user set it", () => {
		const h = harness();
		h.session.emit({ type: "message_start", message: { role: "user", content: [{ type: "text", text: "one" }] } });
		h.session.emit({ type: "tool_execution_start", toolCallId: "a", toolName: "bash", args: { command: "x" } });
		h.session.emit({ type: "tool_execution_end", toolCallId: "a", toolName: "bash", result: { content: [] }, isError: false });
		h.session.emit({ type: "agent_end" });
		h.session.emit({ type: "message_start", message: { role: "user", content: [{ type: "text", text: "two" }] } });
		h.session.emit({ type: "tool_execution_start", toolCallId: "b", toolName: "bash", args: { command: "y" } });
		const [first, second] = groups(h.nodes());
		toggle(h.bridge, first!.id, true);
		toggle(h.bridge, second!.id, false);
		expect(groups(h.nodes()).map((g) => g.p?.collapsed)).toEqual([true, false]);
		const control = (groups(h.nodes())[0]!.c ?? []).at(-1);
		expect(control).toMatchObject({ p: { role: "tern.work-collapse", actions: { click: `work.collapse=${first!.id}` } } });
		collapseWork(h.bridge, second!.id);
		expect(groups(h.nodes()).map((g) => g.p?.collapsed)).toEqual([true, true]);
	});

	it("selecting a row opens its existing renderer beneath that row and keeps the selection while the result settles", () => {
		const h = harness();
		h.session.emit({ type: "message_start", message: { role: "user", content: [{ type: "text", text: "go" }] } });
		h.session.emit({ type: "tool_execution_start", toolCallId: "a", toolName: "bash", args: { description: "Check build", command: "npm test" } });
		const gid = groups(h.nodes())[0]!.id;
		select(h.bridge, `${gid}-rows-0`, "row-t-a");
		const open = groups(h.nodes())[0]!;
		expect(lists(open)[0]!.p?.selected).toBe("row-t-a");
		const detail = (open.c ?? []).find((n) => n.id === "t-a");
		expect(detail).toMatchObject({ k: "tool", p: { status: "running", collapsed: false } });
		h.session.emit({ type: "tool_execution_end", toolCallId: "a", toolName: "bash", result: { content: [{ type: "text", text: "all green" }] }, isError: false });
		const settled = groups(h.nodes())[0]!;
		expect(lists(settled)[0]!.p?.selected).toBe("row-t-a");
		expect((settled.c ?? []).find((n) => n.id === "t-a")?.p?.status).toBe("done");
		expect(rows(settled)[0]).toMatchObject({ p: { label: "Run", detail: "Check build", value: expect.stringMatching(/^Done/) } });
	});

	it("Ctrl+O overrides local folds for every group and then returns each group to the global state", () => {
		const h = harness();
		h.session.emit({ type: "message_start", message: { role: "user", content: [{ type: "text", text: "go" }] } });
		h.session.emit({ type: "tool_execution_start", toolCallId: "a", toolName: "bash", args: { command: "x" } });
		const gid = groups(h.nodes())[0]!.id;
		toggle(h.bridge, gid, true);
		h.bridge.toggleToolOutput();
		expect(groups(h.nodes())[0]!.p?.collapsed).toBe(false);
		h.bridge.toggleToolOutput();
		expect(groups(h.nodes())[0]!.p?.collapsed).toBe(false);
	});

	it("a session replacement forgets local folds, so the rebuilt group starts from the default", () => {
		const h = harness();
		h.session.emit({ type: "message_start", message: { role: "user", content: [{ type: "text", text: "go" }] } });
		h.session.emit({ type: "tool_execution_start", toolCallId: "a", toolName: "bash", args: { command: "x" } });
		const gid = groups(h.nodes())[0]!.id;
		toggle(h.bridge, gid, true);
		const next = harness();
		h.bridge.rebind(next.session);
		next.session.emit({ type: "message_start", message: { role: "user", content: [{ type: "text", text: "go" }] } });
		next.session.emit({ type: "tool_execution_start", toolCallId: "a", toolName: "bash", args: { command: "x" } });
		expect(groups(next.nodes())[0]).toMatchObject({ id: gid, p: { collapsed: false } });
	});
	it("a long output stays behind its row: the bottom Collapse work closes only its group, and reopening keeps the selection and raw output", () => {
		const h = harness();
		const text = Array.from({ length: 500 }, (_, i) => `line ${i + 1}`).join("\n");
		h.session.emit({ type: "message_start", message: { role: "user", content: [{ type: "text", text: "go" }] } });
		h.session.emit({ type: "tool_execution_start", toolCallId: "long", toolName: "bash", args: { command: "seq 1 500", description: "Count" } });
		h.session.emit({ type: "tool_execution_update", toolCallId: "long", partialResult: { content: [{ type: "text", text }] } });
		h.session.emit({ type: "tool_execution_end", toolCallId: "long", toolName: "bash", result: { content: [{ type: "text", text }] }, isError: false });
		const gid = groups(h.nodes())[0]!.id;
		select(h.bridge, `${gid}-rows-0`, "row-t-long");
		const open = groups(h.nodes())[0]!;
		expect(open.c!.at(-1)).toMatchObject({ id: `${gid}-collapse`, p: { role: "tern.work-collapse", actions: { click: `work.collapse=${gid}` } } });
		const renderer = open.c!.find((n) => n.id === "t-long")!;
		expect(renderer.c?.[0]?.c?.[1]).toMatchObject({ k: "ansi", p: { text, follow: true } });
		collapseWork(h.bridge, gid);
		expect(groups(h.nodes())[0]).toMatchObject({ id: gid, p: { collapsed: true } });
		toggle(h.bridge, gid, false);
		const reopened = groups(h.nodes())[0]!;
		expect(reopened.p?.collapsed).toBe(false);
		expect(lists(reopened)[0]!.p?.selected).toBe("row-t-long");
		expect(reopened.c!.find((n) => n.id === "t-long")?.c?.[0]?.c?.[1]?.p?.text).toBe(text);
	});
});

describe("live activity panel (default, modes, persistence)", () => {
	const act = (p: TranscriptProjector, id: string) => p.apply({ type: "tool_execution_start", toolCallId: id, toolName: "read", args: { path: `${id}.ts` } });
	const finish = (p: TranscriptProjector, id: string, isError = false) => p.apply({ type: "tool_execution_end", toolCallId: id, toolName: "read", result: { content: [{ type: "text", text: "ok" }], details: { duration_ms: 5 } }, isError });
	const roleOf = (group: TspNode) => (group.c ?? []).filter((n) => n.p?.role);
	const text = (group: TspNode, role: string) => (group.c ?? []).find((n) => n.p?.role === role)?.p?.text;

	it("shows up to three active rows in call order with the overflow count, and no detail beneath them", () => {
		const p = new TranscriptProjector();
		user(p, "big change");
		for (const id of ["a", "b", "c", "d", "e"]) act(p, id);
		const [live] = groups(p.nodes(false, { currentTask: CURRENT }));
		expect(live!.p?.collapsed).toBe(false);
		expect(rows(live!).map((r) => r.id)).toEqual(["row-t-a", "row-t-b", "row-t-c"]);
		expect(text(live!, "tern.work-overflow")).toBe("+2 more running");
		expect(live!.c!.some((n) => n.id === "t-a")).toBe(false);
	});

	it("names the step that finished last by completion order, not by call order", () => {
		const p = new TranscriptProjector();
		user(p, "go");
		p.apply({ type: "agent_start" });
		act(p, "a");
		act(p, "b");
		finish(p, "b");
		finish(p, "a");
		const [live] = groups(p.nodes(false));
		expect(text(live!, "tern.work-latest")).toBe("Last · Read · a.ts · Done · 5 ms");
	});

	it("keeps a failure indicator after later steps succeed", () => {
		const p = new TranscriptProjector();
		user(p, "go");
		act(p, "a");
		finish(p, "a", true);
		act(p, "b");
		finish(p, "b");
		act(p, "c");
		const [live] = groups(p.nodes(false));
		expect(text(live!, "tern.work-failed")).toMatch(/^1 failed · Read · a\.ts · Failed/);
		expect(text(live!, "tern.work-latest")).toBe("Last · Read · b.ts · Done · 5 ms");
	});

	it("says it is preparing the next action when nothing runs and no narration is streaming", () => {
		const p = new TranscriptProjector();
		user(p, "go");
		p.apply({ type: "agent_start" });
		act(p, "a");
		finish(p, "a");
		const [live] = groups(p.nodes(false));
		expect(text(live!, "tern.work-preparing")).toBe("Preparing next action");
	});

	it("uses the authoritative task as the heading, else the bounded request, never an invented title", () => {
		const p = new TranscriptProjector();
		user(p, "fix the login bug");
		act(p, "a");
		expect(text(groups(p.nodes(false))[0]!, "tern.work-focus")).toBe("Request · fix the login bug");
		expect(text(groups(p.nodes(false, { currentTask: CURRENT }))[0]!, "tern.work-focus")).toBe("Current task · #7 Fix login");
	});

	it("keeps a minimized group minimized through streamed updates and new steps", () => {
		const h = harnessFor();
		h.session.emit({ type: "message_start", message: { role: "user", content: [{ type: "text", text: "go" }] } });
		h.session.emit({ type: "tool_execution_start", toolCallId: "a", toolName: "read", args: { path: "a.ts" } });
		const gid = groups(h.nodes())[0]!.id;
		h.bridge.handle({ verb: "e", body: { ev: "toggle", id: gid, collapsed: true } } as never);
		h.session.emit({ type: "tool_execution_end", toolCallId: "a", toolName: "read", result: { content: [] }, isError: false });
		h.session.emit({ type: "tool_execution_start", toolCallId: "b", toolName: "read", args: { path: "b.ts" } });
		h.session.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "more" } });
		expect(groups(h.nodes())[0]).toMatchObject({ id: gid, p: { collapsed: true } });
	});

	it("All steps shows every step as before, and Activity returns to the panel; the bottom Collapse stays last", () => {
		const h = harnessFor();
		h.session.emit({ type: "message_start", message: { role: "user", content: [{ type: "text", text: "go" }] } });
		for (const id of ["a", "b", "c", "d"]) h.session.emit({ type: "tool_execution_start", toolCallId: id, toolName: "read", args: { path: `${id}.ts` } });
		const gid = groups(h.nodes())[0]!.id;
		h.bridge.handle({ verb: "e", body: { ev: "action", sf: "pi", act: "work.all", value: gid } } as never);
		const all = groups(h.nodes())[0]!;
		expect(rows(all).map((r) => r.id)).toEqual(["row-t-a", "row-t-b", "row-t-c", "row-t-d"]);
		expect(all.c!.at(-1)).toMatchObject({ p: { role: "tern.work-collapse" } });
		expect(all.c!.at(-2)).toMatchObject({ p: { actions: { click: `work.activity=${gid}` } } });
		h.bridge.handle({ verb: "e", body: { ev: "action", sf: "pi", act: "work.activity", value: gid } } as never);
		expect(rows(groups(h.nodes())[0]!).map((r) => r.id)).toEqual(["row-t-a", "row-t-b", "row-t-c"]);
	});

	it("a settled group is compact by default and opens its full steps when the user expands it", () => {
		const p = new TranscriptProjector();
		user(p, "one");
		act(p, "a");
		finish(p, "a");
		p.apply({ type: "agent_end" });
		expect(groups(p.nodes(false))[0]!.p?.collapsed).toBe(true);
		p.setGroupCollapsed(groups(p.nodes(false))[0]!.id, false);
		expect(rows(groups(p.nodes(false))[0]!).map((r) => r.id)).toEqual(["row-t-a"]);
	});
});

function harnessFor() {
	const listeners = new Set<(e: PiEventLike) => void>();
	const session = {
		state: {},
		subscribe(l: (e: PiEventLike) => void) { listeners.add(l); return () => listeners.delete(l); },
		prompt: () => new Promise<void>(() => {}),
		abort: async () => {},
		dispose() {},
		sessionManager: { getSessionId: () => "activity", getEntries: () => [], getBranch: () => [] },
		emit(e: PiEventLike) { for (const l of listeners) l(e); },
	} as unknown as PiSessionLike & { emit(e: PiEventLike): void };
	const seen = { nodes: [] as TspNode[] };
	const bridge = new PiTernBridge(session, { write: () => {}, surfaceId: "pi", credits: 1_000_000, onRender: (nodes) => { seen.nodes = [...nodes]; } } as never);
	bridge.start("pi");
	return { session, bridge, nodes: () => seen.nodes };
}
