// Work card in the Tern transcript: one native `tool` head per step (status glyph, terminal-clocked timer,
// typed target, exit chip), narration kept in place, the group's own fold driven by native toggle events, and
// a bottom Collapse work control. No hand-built row list: Tern draws and clocks each step.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PiTernBridge, TranscriptProjector, type PiEventLike, type PiSessionLike } from "../../lib/tern/bridge.ts";
import type { TspNode } from "../../lib/tern/tsp.ts";

type Msg = Parameters<PiTernBridge["handle"]>[0];
const CURRENT = { id: "7", subject: "Fix login" };
const start = (p: TranscriptProjector, toolCallId: string, args: unknown = { command: "echo" }, name = "bash") => p.apply({ type: "tool_execution_start", toolCallId, toolName: name, args });
const end = (p: TranscriptProjector, toolCallId: string) => p.apply({ type: "tool_execution_end", toolCallId, toolName: "bash", result: { content: [{ type: "text", text: "ok" }], details: { exit_code: 0, duration_ms: 10 } }, isError: false });
const user = (p: TranscriptProjector, text: string) => p.apply({ type: "message_start", message: { role: "user", content: [{ type: "text", text }] } });
const groups = (nodes: readonly TspNode[]) => nodes.filter((n) => n.p?.role === "tern.work" || n.p?.role === "tern.work-live");
const steps = (group: TspNode) => (group.c ?? []).filter((n) => n.k === "tool");
const step = (group: TspNode, id: string) => steps(group).find((n) => n.id === id);
const text = (group: TspNode, role: string) => (group.c ?? []).find((n) => n.p?.role === role)?.p?.text;
// The group's chips live in one controls row; a chip is addressed by its own role.
const controlChip = (group: TspNode, role: string) => (group.c ?? []).flatMap((n) => (n.p?.role === "tern.work-controls" ? n.c ?? [] : [])).find((n) => n.p?.role === role);

describe("work steps (projector)", () => {
	it("renders one native tool head per step, in order, with the verb, typed target and intent Tern draws", () => {
		const p = new TranscriptProjector();
		user(p, "fix login");
		start(p, "a", { description: "Check build", command: "npm test" });
		start(p, "b", { path: "src/login.ts" }, "read");
		end(p, "a");
		// The default live view is the activity panel (running steps only); this checks the all-steps body.
		p.setGroupView("g-t-a", "all");
		const [live] = groups(p.nodes(false, { currentTask: CURRENT }));
		expect(steps(live!).map((s) => s.id)).toEqual(["t-a", "t-b"]);
		expect(step(live!, "t-a")?.p).toMatchObject({ name: "bash", title: "Bash", status: "done", target: "npm test", targetKind: "command", intent: "Check build", took: 10 });
		expect(step(live!, "t-b")?.p).toMatchObject({ name: "read", title: "Read", status: "running", target: "src/login.ts", targetKind: "path" });
		// Nothing hand-drawn is left behind: the terminal owns the row rendering.
		expect((live!.c ?? []).some((n) => n.k === "list" || n.k === "item")).toBe(false);
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
		// The controls and the heading come first, then the steps with the narration kept between them.
		expect((live!.c ?? []).filter((n) => n.k !== "text" && n.p?.role !== "tern.work-controls").map((n) => n.k)).toEqual(["tool", "md", "tool"]);
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
		expect((active!.c ?? []).find((n) => n.p?.role === "tern.work-focus")).toMatchObject({ k: "text", p: { text: "Current task · #7 Fix login" } });
		// Without a supplied task the heading is the labelled request, never the current task.
		expect(groups(p.nodes(false)).flatMap((g) => g.c ?? []).some((n) => String(n.p?.text).startsWith("Current task"))).toBe(false);
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
		expect(settled!.p?.badges).toEqual([{ text: "1 failed", tone: "warning" }]);
		expect(step(settled!, "t-a")?.p).toMatchObject({ status: "error", exit: 1 });
	});

	it("keeps the head to one line and shows a long command in full inside the body", () => {
		const p = new TranscriptProjector();
		user(p, "go");
		const long = "pnpm exec vitest run src/auth/login.test.ts src/auth/session.test.ts --reporter=verbose --coverage.enabled=false --pool=forks 2>&1 | tee /tmp/login.log";
		start(p, "long", { command: long, description: "Run the login tests" });
		const stepNode = step(groups(p.nodes(false))[0]!, "t-long")!;
		expect(String(stepNode.p?.target).length).toBe(64);
		expect(String(stepNode.p?.target)).toMatch(/…$/);
		// The full command is in the body, where it can wrap; the head keeps the copyable command prop.
		const body = stepNode.c?.[0]?.c ?? [];
		expect(body[0]).toMatchObject({ k: "code", p: { role: "omp.tool.bash.command", lang: "bash", text: long } });
		expect(stepNode.p?.command).toBe(long);
		// A short command is not repeated: the head already names it.
		start(p, "short", { command: "npm test" });
		expect((step(groups(p.nodes(false))[0]!, "t-short")!.c?.[0]?.c ?? []).some((n) => n.k === "code")).toBe(false);
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
		const diffs = (running.c?.[0]?.c ?? []) as TspNode[];
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
		expect(folded()?.c?.[0]?.c?.[0]).toMatchObject({ k: "ansi" });
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
		expect(running.p).toMatchObject({ status: "running", collapsed: false, target: "printf first; sleep 1", targetKind: "command", intent: "Print", age: 0 });
		// The body is the OMP run box: tailing output and the terminal-clocked foot.
		expect(running.c?.[0]).toMatchObject({ k: "col", p: { role: "omp.run" } });
		expect(running.c?.[0]?.c?.[0]).toMatchObject({ k: "ansi", p: { text: "first", follow: true } });
		h.session.emit({ type: "tool_execution_update", toolCallId: "live", partialResult: { content: [{ type: "text", text: "firstsecond" }] } });
		expect(step(groups(h.nodes())[0]!, "t-live")?.c?.[0]?.c?.[0]?.p?.text).toBe("firstsecond");
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
		const body = step(groups(h.nodes())[0]!, "t-long")?.c?.[0]?.c?.[0]?.p?.text as string;
		// 40 lines in, 12 shown: the head of the window is an explicit count, never a silent cut.
		expect(body.split("\n")[0]).toBe("… 28 earlier lines");
		expect(body.split("\n").at(-1)).toBe("line 40");
		expect(body).not.toContain("line 1\n");
		// Once it settles the whole output is in the body again, behind the folded head.
		h.session.emit({ type: "tool_execution_end", toolCallId: "long", toolName: "bash", result: { content: [{ type: "text", text: lines.join("\n") }], details: { exit_code: 0, duration_ms: 90 } }, isError: false });
		const settled = step(groups(h.nodes())[0]!, "t-long")!;
		expect(settled.p).toMatchObject({ collapsed: true });
		expect(String(settled.c?.[0]?.c?.[0]?.p?.text)).toBe(lines.join("\n"));
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
		const control = controlChip(groups(h.nodes())[0]!, "tern.work-collapse");
		expect(control).toMatchObject({ p: { actions: { click: `work.collapse=${first!.id}` } } });
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

	it("a long output stays inside its own step: Collapse work folds only its group and reopening keeps the output", () => {
		const h = harness();
		const body = Array.from({ length: 500 }, (_, i) => `line ${i + 1}`).join("\n");
		h.session.emit({ type: "message_start", message: { role: "user", content: [{ type: "text", text: "go" }] } });
		h.session.emit({ type: "tool_execution_start", toolCallId: "long", toolName: "bash", args: { command: "seq 1 500", description: "Count" } });
		h.session.emit({ type: "tool_execution_update", toolCallId: "long", partialResult: { content: [{ type: "text", text: body }] } });
		h.session.emit({ type: "tool_execution_end", toolCallId: "long", toolName: "bash", result: { content: [{ type: "text", text: body }] }, isError: false });
		const gid = groups(h.nodes())[0]!.id;
		const open = groups(h.nodes())[0]!;
		expect(controlChip(open, "tern.work-collapse")).toMatchObject({ id: `${gid}-collapse`, p: { actions: { click: `work.collapse=${gid}` } } });
		expect(step(open, "t-long")?.c?.[0]?.c?.[0]).toMatchObject({ k: "ansi", p: { text: body, follow: true } });
		collapseWork(h.bridge, gid);
		expect(groups(h.nodes())[0]).toMatchObject({ id: gid, p: { collapsed: true } });
		toggle(h.bridge, gid, false);
		const reopened = groups(h.nodes())[0]!;
		expect(reopened.p?.collapsed).toBe(false);
		expect(step(reopened, "t-long")?.c?.[0]?.c?.[0]?.p?.text).toBe(body);
	});
});

describe("live activity panel (default, modes, persistence)", () => {
	const act = (p: TranscriptProjector, id: string) => p.apply({ type: "tool_execution_start", toolCallId: id, toolName: "read", args: { path: `${id}.ts` } });
	const finish = (p: TranscriptProjector, id: string, isError = false) => p.apply({ type: "tool_execution_end", toolCallId: id, toolName: "read", result: { content: [{ type: "text", text: "ok" }], details: { duration_ms: 5 } }, isError });

	it("shows up to three running steps in call order with their own heads, plus the overflow count", () => {
		const p = new TranscriptProjector();
		user(p, "big change");
		for (const id of ["a", "b", "c", "d", "e"]) act(p, id);
		p.setGroupView("g-t-a", "activity");
		const [live] = groups(p.nodes(false, { currentTask: CURRENT }));
		expect(live!.p?.collapsed).toBe(false);
		expect(steps(live!).map((s) => s.id)).toEqual(["t-a", "t-b", "t-c"]);
		expect(text(live!, "tern.work-overflow")).toBe("+2 more running");
		expect(steps(live!).every((s) => s.p?.status === "running" && s.p?.targetKind === "path")).toBe(true);
	});

	it("names the step that finished last by completion order, not by call order", () => {
		const p = new TranscriptProjector();
		user(p, "go");
		p.apply({ type: "agent_start" });
		act(p, "a");
		act(p, "b");
		finish(p, "b");
		finish(p, "a");
		p.setGroupView("g-t-a", "activity");
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
		p.setGroupView("g-t-a", "activity");
		const [live] = groups(p.nodes(false));
		expect(text(live!, "tern.work-failed")).toMatch(/^1 failed · Read · a\.ts · Failed/);
		expect(text(live!, "tern.work-latest")).toBe("Last · Read · b.ts · Done · 5 ms");
	});

	it("says it is preparing the next action, with a shimmer, when nothing runs and no narration is streaming", () => {
		const p = new TranscriptProjector();
		user(p, "go");
		p.apply({ type: "agent_start" });
		act(p, "a");
		finish(p, "a");
		p.setGroupView("g-t-a", "activity");
		const [live] = groups(p.nodes(false));
		expect((live!.c ?? []).find((n) => n.p?.role === "tern.work-preparing")).toMatchObject({ k: "shimmer", p: { text: "Preparing next action" } });
	});

	it("names the tracked task in the heading, and never repeats the request the head already carries", () => {
		const p = new TranscriptProjector();
		user(p, "fix the login bug");
		act(p, "a");
		// The head's target is the request; a second line saying the same thing is noise.
		expect(groups(p.nodes(false))[0]!.p?.target).toBe("fix the login bug");
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

	it("All steps shows every step, and Activity returns to the running panel; Collapse stays last", () => {
		const h = harnessFor();
		h.session.emit({ type: "message_start", message: { role: "user", content: [{ type: "text", text: "go" }] } });
		for (const id of ["a", "b", "c", "d"]) h.session.emit({ type: "tool_execution_start", toolCallId: id, toolName: "read", args: { path: `${id}.ts` } });
		const gid = groups(h.nodes())[0]!.id;
		h.bridge.handle({ verb: "e", body: { ev: "action", sf: "pi", act: "work.all", value: gid } } as never);
		const all = groups(h.nodes())[0]!;
		expect(steps(all).map((s) => s.id)).toEqual(["t-a", "t-b", "t-c", "t-d"]);
		// Controls first, so an opened card shows how to fold it again without scrolling past its steps.
		expect(all.c![0]).toMatchObject({ k: "row", p: { role: "tern.work-controls" } });
		expect(controlChip(all, "tern.work-mode")).toMatchObject({ p: { actions: { click: `work.activity=${gid}` } } });
		expect(controlChip(all, "tern.work-collapse")).toMatchObject({ p: { actions: { click: `work.collapse=${gid}` } } });
		h.bridge.handle({ verb: "e", body: { ev: "action", sf: "pi", act: "work.activity", value: gid } } as never);
		expect(steps(groups(h.nodes())[0]!).map((s) => s.id)).toEqual(["t-a", "t-b", "t-c"]);
	});

	it("a settled group is compact by default and opens its steps when the user expands it", () => {
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
