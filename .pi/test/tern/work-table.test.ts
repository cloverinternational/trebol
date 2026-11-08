// Work card in the Tern transcript: one native `tool` head per step (status glyph, terminal-clocked timer,
// typed target, exit chip) in one indented body, narration kept in place, the group's own fold driven by native
// toggle events, and a single Inspect affordance. No hand-built row list or control row: Tern draws each step.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PiTernBridge, TranscriptProjector, type PiEventLike, type PiSessionLike } from "../../lib/tern/bridge.ts";
import type { TspNode } from "../../lib/tern/tsp.ts";

type Msg = Parameters<PiTernBridge["handle"]>[0];
const CURRENT = { id: "7", subject: "Fix login" };
const start = (p: TranscriptProjector, toolCallId: string, args: unknown = { command: "echo" }, name = "bash") => p.apply({ type: "tool_execution_start", toolCallId, toolName: name, args });
const end = (p: TranscriptProjector, toolCallId: string) => p.apply({ type: "tool_execution_end", toolCallId, toolName: "bash", result: { content: [{ type: "text", text: "ok" }], details: { exit_code: 0, duration_ms: 10 } }, isError: false });
const user = (p: TranscriptProjector, text: string) => p.apply({ type: "message_start", message: { role: "user", content: [{ type: "text", text }] } });
const groups = (nodes: readonly TspNode[]) => nodes.filter((n) => n.p?.role === "tern.work" || n.p?.role === "tern.work-live");
// The card body is one indented column; the steps are its tool children, after the single Inspect line.
const body = (group: TspNode) => (group.c ?? []).find((n) => n.p?.role === "tern.work-body");
const steps = (group: TspNode) => (body(group)?.c ?? []).filter((n) => n.k === "tool");
const step = (group: TspNode, id: string) => steps(group).find((n) => n.id === id);
const text = (group: TspNode, role: string) => (body(group)?.c ?? []).find((n) => n.p?.role === role)?.p?.text;

describe("work steps (projector)", () => {
	it("renders one native tool head per step, in order, with the verb, typed target and intent Tern draws", () => {
		const p = new TranscriptProjector();
		user(p, "fix login");
		start(p, "a", { description: "Check build", command: "npm test" });
		start(p, "b", { path: "src/login.ts" }, "read");
		end(p, "a");
		const [live] = groups(p.nodes(false, { currentTask: CURRENT }));
		expect(steps(live!).map((s) => s.id)).toEqual(["t-a", "t-b"]);
		// The row is the model's description; the command is what opening it reveals.
		expect(step(live!, "t-a")?.p).toMatchObject({ name: "bash", title: "", status: "done", target: "Check build", targetKind: "text", took: 10 });
		expect(step(live!, "t-a")?.p?.intent).toBeUndefined();
		expect(step(live!, "t-a")?.c?.[0]).toMatchObject({ k: "code", p: { text: "npm test" } });
		expect(step(live!, "t-b")?.p).toMatchObject({ name: "read", title: "Read", status: "running", target: "src/login.ts", targetKind: "path" });
		// Nothing hand-drawn is left behind: the terminal owns the row rendering.
		expect((body(live!)?.c ?? []).some((n) => n.k === "list" || n.k === "item")).toBe(false);
	});

	it("keeps narration between tool steps in chronological order around the steps", () => {
		const p = new TranscriptProjector();
		user(p, "go");
		start(p, "a");
		end(p, "a");
		p.apply({ type: "message_start", message: { role: "assistant", content: [] } });
		p.apply({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Next step" } });
		start(p, "b");
		const [live] = groups(p.nodes(true, { currentTask: CURRENT }));
		// One Inspect line, then the steps with the narration kept between them, in one indented body.
		expect((body(live!)?.c ?? []).filter((n) => n.p?.role !== "tern.work-inspect" && n.p?.role !== "tern.work-focus").map((n) => n.k)).toEqual(["tool", "md", "tool"]);
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
		expect(text(settled!, "tern.work-focus")).toBeUndefined();
		expect(body(active!)?.c ?? []).toContainEqual(expect.objectContaining({ k: "text", p: expect.objectContaining({ text: "Current task · #7 Fix login" }) }));
		// Without a supplied task the heading is the labelled request, never the current task.
		expect(groups(p.nodes(false)).flatMap((g) => body(g)?.c ?? []).some((n) => String(n.p?.text).startsWith("Current task"))).toBe(false);
	});

	it("gives the group head a live age, then the settled duration and a failure badge", () => {
		const p = new TranscriptProjector();
		user(p, "go");
		p.apply({ type: "agent_start" });
		start(p, "a", { command: "exit 1" });
		const [live] = groups(p.nodes(false));
		expect(live!.p).toMatchObject({ status: "running" });
		expect(typeof live!.p?.age).toBe("number");
		expect(live!.p?.took).toBeUndefined();
		p.apply({ type: "tool_execution_end", toolCallId: "a", toolName: "bash", result: { content: [{ type: "text", text: "boom" }], details: { exit_code: 1, duration_ms: 40 } }, isError: true });
		start(p, "b");
		end(p, "b");
		p.apply({ type: "agent_end" });
		const [settled] = groups(p.nodes(false));
		expect(settled!.p).toMatchObject({ status: "done", meta: ["2 steps"] });
		expect(typeof settled!.p?.took).toBe("number");
		// "Done" already says the rest; only the failure count is worth a badge.
		expect(settled!.p?.badges).toEqual([{ text: "1 failed", tone: "warning" }]);
		expect(step(settled!, "t-a")?.p).toMatchObject({ status: "error", exit: 1 });
	});

	it("keeps the command as the head target, bounded only when it is too long to hold", () => {
		const p = new TranscriptProjector();
		user(p, "go");
		const long = "pnpm exec vitest run src/auth/login.test.ts src/auth/session.test.ts --reporter=verbose --coverage.enabled=false --pool=forks 2>&1 | tee /tmp/login.log";
		start(p, "long", { command: long });
		const stepNode = step(groups(p.nodes(false))[0]!, "t-long")!;
		// Tern ellipsizes the target folded and wraps it expanded, so the command belongs there and nowhere else.
		expect(stepNode.p).toMatchObject({ target: long, targetKind: "command" });
		expect(stepNode.p?.command).toBe(long);
		// With no description, the command is the label everywhere — including the card head.
		expect(groups(p.nodes(false))[0]!.p?.target).toBe(long);
		// No second copy of the command inside the body.
		expect(stepNode.c ?? []).toEqual([]);
		// Only an absurdly long shell line is cut, and the full text stays copyable.
		const huge = "echo " + "x".repeat(500);
		start(p, "huge", { command: huge });
		const cut = step(groups(p.nodes(false))[0]!, "t-huge")!;
		expect(String(cut.p?.target)).toMatch(/…$/);
		expect(String(cut.p?.target).length).toBe(400);
		expect(cut.p?.command).toBe(huge);
	});

	it("draws an apply_patch as a diff with its own +a −d, and folds it once settled", () => {
		const p = new TranscriptProjector();
		user(p, "go");
		const input = [
			"*** Begin Patch",
			"*** Update File: src/auth/login.ts",
			"@@ export function login(user) {",
			"   const session = open(user);",
			"-  calls++;",
			"+  calls = 1;",
			"*** Add File: src/auth/notes.md",
			"+keep the session counter at one",
			"*** End Patch",
		].join("\n");
		p.apply({ type: "tool_execution_start", toolCallId: "p1", toolName: "apply_patch", args: { input } });
		const running = step(groups(p.nodes(false))[0]!, "t-p1")!;
		expect(running.p).toMatchObject({ name: "edit", title: "Patch", status: "running", collapsed: false, meta: ["+2 −1"] });
		expect(running.p?.target).toBe("src/auth/login.ts, src/auth/notes.md");
		const diffs = (running.c ?? []) as TspNode[];
		expect(diffs.map((d) => [d.k, d.p?.path])).toEqual([["diff", "src/auth/login.ts"], ["diff", "src/auth/notes.md"]]);
		// The `***` markers never reach the diff as context lines.
		expect(String(diffs[0]?.p?.text)).toBe("@@ export function login(user) {\n   const session = open(user);\n-  calls++;\n+  calls = 1;");
		expect(String(diffs[1]?.p?.text)).toBe("+keep the session counter at one");
		p.apply({ type: "tool_execution_end", toolCallId: "p1", toolName: "apply_patch", result: { content: [{ type: "text", text: "2 files changed" }] }, isError: false });
		expect(step(groups(p.nodes(false))[0]!, "t-p1")?.p).toMatchObject({ status: "done", collapsed: true });
	});

	it("folds a settled step to its head and opens it with Ctrl+O", () => {
		const p = new TranscriptProjector();
		user(p, "go");
		start(p, "a");
		end(p, "a");
		p.apply({ type: "agent_end" });
		const folded = () => step(groups(p.nodes(false))[0]!, "t-a");
		expect(folded()?.p).toMatchObject({ collapsible: true, collapsed: true });
		expect(folded()?.c?.[0]).toMatchObject({ k: "ansi" });
		expect(step(groups(p.nodes(true))[0]!, "t-a")?.p).toMatchObject({ collapsed: false });
	});

	it("drops every group view the moment its items are replaced by a new session", () => {
		const p = new TranscriptProjector();
		user(p, "go");
		start(p, "a");
		const [live] = groups(p.nodes(false));
		p.setGroupCollapsed(live!.id, false);
		p.replaceFromSessionBranch([]);
		expect(p.nodes(false)).toEqual([]);
		user(p, "go");
		start(p, "a");
		const [again] = groups(p.nodes(false));
		expect(again!.id).toBe(live!.id);
		expect(again!.p?.collapsed).toBe(false);
	});
});

describe("work card through the bridge (native events)", () => {
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

	it("a running step shows its live output and a run timer without the user selecting anything", () => {
		const h = harness();
		h.session.emit({ type: "message_start", message: { role: "user", content: [{ type: "text", text: "go" }] } });
		h.session.emit({ type: "tool_execution_start", toolCallId: "live", toolName: "bash", args: { command: "printf first; sleep 1", description: "Print" } });
		h.session.emit({ type: "tool_execution_update", toolCallId: "live", partialResult: { content: [{ type: "text", text: "first" }] } });
		const [live] = groups(h.nodes());
		const running = step(live!, "t-live")!;
		// Open while it runs, so its output shows live without a click.
		// The command is the head line; the description is only its tooltip.
		expect(running.p).toMatchObject({ status: "running", collapsed: false, target: "Print", targetKind: "text", age: 0 });
		// Opening it shows the command first; the output tails underneath.
		expect(running.c?.[0]).toMatchObject({ k: "code", p: { role: "omp.tool.bash.command", text: "printf first; sleep 1" } });
		expect(running.c?.[1]).toMatchObject({ k: "ansi", p: { role: "omp.tool.bash.output", text: "first", follow: true } });
		h.session.emit({ type: "tool_execution_update", toolCallId: "live", partialResult: { content: [{ type: "text", text: "firstsecond" }] } });
		expect(step(groups(h.nodes())[0]!, "t-live")?.c?.[1]?.p?.text).toBe("firstsecond");
		// Once it settles the step folds to its head and carries its final duration.
		h.session.emit({ type: "tool_execution_end", toolCallId: "live", toolName: "bash", result: { content: [{ type: "text", text: "firstsecond" }], details: { exit_code: 0, duration_ms: 1200 } }, isError: false });
		// Settling folds the step to its head: command, state, exit and duration stay, the body closes.
		expect(step(groups(h.nodes())[0]!, "t-live")?.p).toMatchObject({ status: "done", took: 1200, collapsed: true });
	});

	it("windows a long running output with an honest count instead of pushing the turn off screen", () => {
		const h = harness();
		h.session.emit({ type: "message_start", message: { role: "user", content: [{ type: "text", text: "go" }] } });
		h.session.emit({ type: "tool_execution_start", toolCallId: "long", toolName: "bash", args: { command: "seq 1 40" } });
		const lines = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`);
		h.session.emit({ type: "tool_execution_update", toolCallId: "long", partialResult: { content: [{ type: "text", text: lines.join("\n") }] } });
		const body = step(groups(h.nodes())[0]!, "t-long")?.c?.[0]?.p?.text as string;
		// 40 lines in, 12 shown: the head of the window is an explicit count, never a silent cut.
		expect(body.split("\n")[0]).toBe("… 28 earlier lines");
		expect(body.split("\n").at(-1)).toBe("line 40");
		expect(body).not.toContain("line 1\n");
		// Once it settles the whole output is in the body again, behind the folded head.
		h.session.emit({ type: "tool_execution_end", toolCallId: "long", toolName: "bash", result: { content: [{ type: "text", text: lines.join("\n") }], details: { exit_code: 0, duration_ms: 90 } }, isError: false });
		const settled = step(groups(h.nodes())[0]!, "t-long")!;
		expect(settled.p).toMatchObject({ collapsed: true });
		expect(String(settled.c?.[0]?.p?.text)).toBe(lines.join("\n"));
	});

	it("a running TaskManage call is a checklist of pending items, and an abort leaves one cancelled step", () => {
		const p = new TranscriptProjector();
		user(p, "go");
		p.apply({ type: "agent_start" });
		p.apply({ type: "tool_execution_start", toolCallId: "t1", toolName: "TaskManage", args: { operations: [{ key: "a", op: "create", subject: "First" }, { key: "b", op: "create", subject: "Second" }] } });
		const running = step(groups(p.nodes(false))[0]!, "t-t1")!;
		expect(running.p).toMatchObject({ status: "running", name: "todo", title: "Tasks" });
		const checklist = running.c?.[0]?.c?.[0];
		expect(checklist).toMatchObject({ k: "checklist", p: { role: "tasks.list" } });
		const items = (checklist?.p?.phases as Array<{ items: Array<{ status: string; text: string }> }>)[0]!.items;
		expect(items.map((i) => i.status)).toEqual(["pending", "pending"]);
		expect(items.map((i) => i.text)).toEqual(["create · First", "create · Second"]);
		// An abort closes the call: the step reads cancelled and carries no note repeating its own status.
		p.apply({ type: "agent_end" });
		const aborted = step(groups(p.nodes(false))[0]!, "t-t1")!;
		expect(aborted.p).toMatchObject({ status: "cancelled" });
		expect(aborted.p?.note).toBeUndefined();
	});

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

	it("folding one group leaves the other group's fold exactly as the user set it", () => {
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
		collapseWork(h.bridge, second!.id);
		expect(groups(h.nodes()).map((g) => g.p?.collapsed)).toEqual([true, true]);
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

	it("a long output stays inside its own step: folding folds only its group and reopening keeps the output", () => {
		const h = harness();
		const body = Array.from({ length: 500 }, (_, i) => `line ${i + 1}`).join("\n");
		h.session.emit({ type: "message_start", message: { role: "user", content: [{ type: "text", text: "go" }] } });
		h.session.emit({ type: "tool_execution_start", toolCallId: "long", toolName: "bash", args: { command: "seq 1 500", description: "Count" } });
		h.session.emit({ type: "tool_execution_update", toolCallId: "long", partialResult: { content: [{ type: "text", text: body }] } });
		h.session.emit({ type: "tool_execution_end", toolCallId: "long", toolName: "bash", result: { content: [{ type: "text", text: body }] }, isError: false });
		const gid = groups(h.nodes())[0]!.id;
		const open = groups(h.nodes())[0]!;
		expect(step(open, "t-long")?.c?.[1]).toMatchObject({ k: "ansi", p: { text: body, follow: true } });
		collapseWork(h.bridge, gid);
		expect(groups(h.nodes())[0]).toMatchObject({ id: gid, p: { collapsed: true } });
		toggle(h.bridge, gid, false);
		const reopened = groups(h.nodes())[0]!;
		expect(reopened.p?.collapsed).toBe(false);
		expect(step(reopened, "t-long")?.c?.[1]?.p?.text).toBe(body);
	});
});

describe("the work tree", () => {
	const act = (p: TranscriptProjector, id: string) => p.apply({ type: "tool_execution_start", toolCallId: id, toolName: "read", args: { path: `${id}.ts` } });
	const finish = (p: TranscriptProjector, id: string, isError = false) => p.apply({ type: "tool_execution_end", toolCallId: id, toolName: "read", result: { content: [{ type: "text", text: "ok" }], details: { duration_ms: 5 } }, isError });

	it("keeps every step in one indented body with a single Inspect affordance and no control row", () => {
		const p = new TranscriptProjector();
		user(p, "big change");
		for (const id of ["a", "b", "c", "d", "e"]) act(p, id);
		const [live] = groups(p.nodes(false, { currentTask: CURRENT }));
		expect(live!.p?.collapsed).toBe(false);
		// Every running step is shown, in call order: there is no separate "activity" subset to switch to.
		expect(steps(live!).map((s) => s.id)).toEqual(["t-a", "t-b", "t-c", "t-d", "t-e"]);
		const tree = body(live!)!;
		expect(tree).toMatchObject({ k: "col", p: { role: "tern.work-body" } });
		// The overlay already owns All/Active/Failed and search, so the card offers exactly one way in.
		const affordances = tree.c!.filter((n) => n.p?.role !== "tern.work-focus" && (n.k === "button" || n.p?.role === "tern.work-inspect"));
		expect(affordances).toHaveLength(1);
		expect(affordances[0]).toMatchObject({ k: "text", p: { role: "tern.work-inspect", text: "Inspect steps", actions: { click: `work.inspect=${live!.id}` } } });
		expect(tree.c!.some((n) => n.k === "row" || n.p?.role === "tern.work-mode" || n.p?.role === "pi.work.explore")).toBe(false);
	});

	it("keeps a failure count after later steps succeed, without a completed badge", () => {
		const p = new TranscriptProjector();
		user(p, "go");
		p.apply({ type: "agent_start" });
		act(p, "a");
		finish(p, "a", true);
		act(p, "b");
		finish(p, "b");
		const [live] = groups(p.nodes(false));
		expect(live!.p?.badges).toEqual([{ text: "1 failed", tone: "warning" }]);
	});

	it("names the tracked task in the tree, and the head follows the tool call instead of the request", () => {
		const p = new TranscriptProjector();
		user(p, "fix the login bug");
		act(p, "a");
		// The head names what is running, never the prompt that is already in the user bubble.
		expect(groups(p.nodes(false))[0]!.p?.target).toBe("Read a.ts");
		expect(groups(p.nodes(false))[0]!.p?.target).not.toBe("fix the login bug");
		expect(text(groups(p.nodes(false))[0]!, "tern.work-focus")).toBeUndefined();
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

	it("moves the head to the newest running call, holds it while working, and settles on the last call", () => {
		const p = new TranscriptProjector();
		user(p, "fix login");
		p.apply({ type: "agent_start" });
		p.apply({ type: "tool_execution_start", toolCallId: "a", toolName: "read", args: { path: "src/a.ts" } });
		expect(groups(p.nodes(false))[0]!.p).toMatchObject({ title: "1 running", target: "Read src/a.ts" });
		// The call finishes, the turn is still open: the head holds what it last did, with an honest title.
		p.apply({ type: "tool_execution_end", toolCallId: "a", toolName: "read", result: { content: [] }, isError: false });
		expect(groups(p.nodes(false))[0]!.p).toMatchObject({ title: "working", target: "Read src/a.ts" });
		// A second call takes the head; settling keeps it instead of falling back to the prompt.
		p.apply({ type: "tool_execution_start", toolCallId: "b", toolName: "bash", args: { command: "npm test", description: "Run tests" } });
		expect(groups(p.nodes(false))[0]!.p?.target).toBe("Run tests");
		p.apply({ type: "tool_execution_end", toolCallId: "b", toolName: "bash", result: { content: [] }, isError: false });
		p.apply({ type: "agent_end" });
		expect(groups(p.nodes(false))[0]!.p).toMatchObject({ title: "Done", target: "Run tests" });
	});

	it("a settled group is compact by default and opens its tree when the user expands it", () => {
		const p = new TranscriptProjector();
		user(p, "one");
		act(p, "a");
		finish(p, "a");
		p.apply({ type: "agent_end" });
		expect(groups(p.nodes(false))[0]!.p?.collapsed).toBe(true);
		p.setGroupCollapsed(groups(p.nodes(false))[0]!.id, false);
		expect(steps(groups(p.nodes(false))[0]!).map((s) => s.id)).toEqual(["t-a"]);
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
