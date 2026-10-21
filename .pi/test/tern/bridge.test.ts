import { describe, expect, it } from "vitest";
import { PiTernBridge, TranscriptProjector, type PiEventLike, type PiSessionLike } from "../../lib/tern/bridge.ts";
import { ESC, ST, parseTspMessages, type TspMessage, type TspNode } from "../../lib/tern/tsp.ts";

// Tool steps inside a summary (tern.work) or live (tern.work-live) group, in order.
// Selects one tool call's row in its work group (as a native list selection would) and returns its renderer node.
const detail = (p: TranscriptProjector, toolCallId: string): TspNode => {
	const row = `row-t-${toolCallId}`;
	const group = p.nodes().filter((n) => n.p?.role === "tern.work" || n.p?.role === "tern.work-live").find((g) => (g.c ?? []).some((list) => list.k === "list" && (list.c ?? []).some((item) => item.id === row)));
	if (!group) throw new Error(`no work group holds ${row}`);
	p.selectRow(group.id, row);
	return p.nodes().find((n) => n.id === group.id)!.c!.find((n) => n.id === `t-${toolCallId}`)!;
};
const rowsOf = (p: TranscriptProjector) => p.nodes().flatMap((n) => (n.c ?? []).filter((c) => c.k === "list").flatMap((list) => list.c ?? []));

function fakeSession() {
	const listeners = new Set<(e: PiEventLike) => void>();
	const calls: string[] = [];
	const pendingPrompts: Array<() => void> = [];
	const session: PiSessionLike & { emit(e: PiEventLike): void; disposed: boolean } = {
		disposed: false,
		subscribe(l) {
			listeners.add(l);
			return () => listeners.delete(l);
		},
		prompt(text) {
			calls.push(`prompt:${text}`);
			return new Promise<void>((r) => {
				pendingPrompts.push(r);
			});
		},
		async abort() {
			calls.push("abort");
		},
		dispose() {
			this.disposed = true;
			calls.push("dispose");
		},
		emit(e) {
			for (const l of listeners) l(e);
		},
	};
	return { session, calls, finish: () => { for (const resolve of pendingPrompts.splice(0)) resolve(); }, listenerCount: () => listeners.size };
}

function capture() {
	const writes: string[] = [];
	return { writes, write: (d: string) => writes.push(d) };
}

// Credits are high so content assertions see the latest frame without acks.
const CREDITS = 1000;

function action(body: Record<string, unknown>): TspMessage {
	return { verb: "e", body: { ev: "action", sf: "pi", ...body } };
}

function lastFrame(writes: string[]): unknown {
	const frames = writes.filter((w) => w.startsWith(`${ESC}_tsp;f;`));
	const last = frames.at(-1);
	if (!last) throw new Error("no frame written");
	return parseTspMessages(last)[0]?.body;
}

describe("TranscriptProjector", () => {
	it("streams assistant text deltas into one stable node", () => {
		const p = new TranscriptProjector();
		p.apply({ type: "message_start", message: { role: "assistant", content: [] } });
		p.apply({ type: "message_update", message: {}, assistantMessageEvent: { type: "text_delta", delta: "Hel" } });
		p.apply({ type: "message_update", message: {}, assistantMessageEvent: { type: "text_delta", delta: "lo" } });
		p.apply({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Hello" }] } });
		expect(p.items).toHaveLength(1);
		expect(p.items[0]).toMatchObject({ role: "assistant", text: "Hello" });
		expect(p.nodes()[0]).toEqual({ id: `msg-${p.items[0].id}`, k: "col", p: { role: "pi.assistant" }, c: [{ id: `msg-${p.items[0].id}.body`, k: "md", p: { text: "Hello", stream: false } }] });
	});

	it("tracks tool execution start and end by toolCallId", () => {
		const p = new TranscriptProjector();
		p.apply({ type: "tool_execution_start", toolCallId: "c1", toolName: "read", args: {} });
		expect(p.items[0]).toMatchObject({ id: "t-c1", status: "running" });
		expect(p.apply({ type: "tool_execution_update", toolCallId: "c1", partialResult: { content: [{ type: "text", text: "partial" }] } })).toBe(true);
		expect(p.items[0]).toMatchObject({ output: "partial" });
		expect(p.apply({ type: "tool_execution_update", toolCallId: "missing", partialResult: "ignored" })).toBe(false);
		p.apply({ type: "tool_execution_end", toolCallId: "c1", toolName: "read", result: {}, isError: true });
		expect(p.items[0]).toMatchObject({ status: "error", text: "tool read error" });
	});

	it("does not duplicate toolResult messages as system transcript rows", () => {
		const p = new TranscriptProjector();
		expect(p.apply({ type: "message_start", message: { role: "toolResult", content: [{ type: "text", text: "done" }] } })).toBe(false);
		expect(p.apply({ type: "message_end", message: { role: "toolResult", content: [{ type: "text", text: "done" }] } })).toBe(false);
		expect(p.items).toHaveLength(0);
	});

	it("does not duplicate a user prompt echoed by Pi after a local submit", () => {
		const p = new TranscriptProjector();
		p.add("user", "hi");
		p.apply({ type: "message_start", message: { role: "user", content: "hi" } });
		expect(p.items.filter((i) => i.role === "user")).toHaveLength(1);
	});

	it("ignores unrelated events", () => {
		expect(new TranscriptProjector().apply({ type: "compaction_start", reason: "manual" })).toBe(false);
	});
});

describe("PiTernBridge", () => {
	it("pastes clipboard file paths, image references, and text in Pi's priority order", async () => {
		const fake = fakeSession();
		const out = capture();
		const bridge = new PiTernBridge(fake.session, {
			write: out.write, surfaceId: "pi", credits: CREDITS,
			clipboard: {
				filePaths: async () => ["/tmp/a file.png"],
				image: async () => new Uint8Array([1]),
				text: async () => "unused",
			},
		});
		bridge.start();
		await bridge.pasteClipboard();
		expect(bridge.draft).toBe("/tmp/a file.png");
		bridge.close();
	});

	it("pastes image file reference when no file paths are copied", async () => {
		const fake = fakeSession();
		const bridge = new PiTernBridge(fake.session, {
			write: capture().write, surfaceId: "pi",
			clipboard: {
				filePaths: async () => null,
				image: async () => new Uint8Array([1]),
				text: async () => "fallback",
				saveImage: () => "/tmp/pi-clipboard-test.png",
			},
		});
		bridge.start();
		await bridge.pasteClipboard();
		expect(bridge.draft).toBe("/tmp/pi-clipboard-test.png");
		bridge.close();
	});

	it("falls back to clipboard text when there are no files or image", async () => {
		const fake = fakeSession();
		const bridge = new PiTernBridge(fake.session, {
			write: capture().write, surfaceId: "pi",
			clipboard: { filePaths: async () => null, image: async () => null, text: async () => "first\nsecond" },
		});
		bridge.start();
		await bridge.pasteClipboard();
		expect(bridge.draft).toBe("first second");
		bridge.close();
	});

	it("opens one inline surface and renders the projected transcript", () => {
		const out = capture();
		const { session } = fakeSession();
		const bridge = new PiTernBridge(session, { write: out.write, surfaceId: "pi", credits: CREDITS });
		bridge.start("pi");
		expect(out.writes[0]).toContain('"mode":"inline"');
		expect(out.writes.some((w) => w.startsWith(`${ESC}_tsp;f;`))).toBe(true);
	});

	it("submits typed text and queues a follow-up while busy", async () => {
		const out = capture();
		const fake = fakeSession();
		const bridge = new PiTernBridge(fake.session, { write: out.write, surfaceId: "pi", credits: CREDITS });
		bridge.start();
		const first = bridge.submit("  what is 2+2?  ");
		expect(fake.calls).toEqual(["prompt:what is 2+2?"]);
		fake.session.emit({ type: "agent_start" });
		expect(bridge.busy).toBe(true);
		const followUp = bridge.submit("second");
		expect(fake.calls).toEqual(["prompt:what is 2+2?", "prompt:second"]);
		expect(JSON.stringify(lastFrame(out.writes))).toContain("Follow-up queued");
		fake.finish();
		await Promise.all([first, followUp]);
	});

	it("ignores blank submissions", async () => {
		const fake = fakeSession();
		const bridge = new PiTernBridge(fake.session, { write: capture().write, surfaceId: "pi" });
		bridge.start();
		await bridge.submit("   ");
		expect(fake.calls).toEqual([]);
	});

	it("routes a submit action from Tern through values.text", () => {
		const fake = fakeSession();
		const bridge = new PiTernBridge(fake.session, { write: capture().write, surfaceId: "pi" });
		bridge.start();
		void bridge.handle(action({ act: "submit", values: { text: "ping" } }));
		expect(fake.calls).toEqual(["prompt:ping"]);
	});

	it("cancels a running turn through abort and reports it", async () => {
		const out = capture();
		const fake = fakeSession();
		const bridge = new PiTernBridge(fake.session, { write: out.write, surfaceId: "pi", credits: CREDITS });
		bridge.start();
		void bridge.submit("long");
		fake.session.emit({ type: "agent_start" });
		await bridge.cancel();
		expect(fake.calls).toContain("abort");
		expect(bridge.busy).toBe(false);
		expect(JSON.stringify(lastFrame(out.writes))).toContain("cancelled");
	});

	it("cancel is a no-op when idle", async () => {
		const fake = fakeSession();
		const bridge = new PiTernBridge(fake.session, { write: capture().write, surfaceId: "pi" });
		bridge.start();
		await bridge.cancel();
		expect(fake.calls).toEqual([]);
	});

	it("close unsubscribes, closes the surface, disposes the session, and ignores later events", () => {
		const out = capture();
		const fake = fakeSession();
		let closed = 0;
		const bridge = new PiTernBridge(fake.session, { write: out.write, surfaceId: "pi", onClose: () => closed++ });
		bridge.start();
		expect(fake.listenerCount()).toBe(1);
		bridge.handle(action({ act: "close" }));
		expect(bridge.closed).toBe(true);
		expect(fake.listenerCount()).toBe(0);
		expect(fake.session.disposed).toBe(true);
		expect(closed).toBe(1);
		expect(out.writes.at(-1)?.startsWith(`${ESC}_tsp;x;`)).toBe(true);
		const before = out.writes.length;
		fake.session.emit({ type: "message_start", message: { role: "assistant", content: "late" } });
		expect(out.writes.length).toBe(before);
		bridge.close();
		expect(closed).toBe(1);
	});

	it("ignores submit and cancel after close", async () => {
		const fake = fakeSession();
		const bridge = new PiTernBridge(fake.session, { write: capture().write, surfaceId: "pi" });
		bridge.start();
		bridge.close();
		await bridge.submit("nope");
		await bridge.cancel();
		expect(fake.calls).toEqual(["dispose"]);
	});

	it("surfaces prompt rejection as a system item and clears busy", async () => {
		const out = capture();
		const session: PiSessionLike = {
			subscribe: () => () => {},
			prompt: () => Promise.reject(new Error("no model configured")),
			abort: async () => {},
			dispose: () => {},
		};
		const bridge = new PiTernBridge(session, { write: out.write, surfaceId: "pi", credits: CREDITS });
		bridge.start();
		await bridge.submit("hi");
		expect(bridge.busy).toBe(false);
		expect(JSON.stringify(lastFrame(out.writes))).toContain("no model configured");
	});

	it("does not auto-approve: unbound UI prompts never reach the bridge as grants", () => {
		const fake = fakeSession();
		const bridge = new PiTernBridge(fake.session, { write: capture().write, surfaceId: "pi" });
		bridge.start();
		bridge.handle({ verb: "e", body: { ev: "action", sf: "pi", act: "approve" } } as TspMessage);
		expect(fake.calls).toEqual([]);
	});

	it("ignores acks for other surfaces and non-action events", () => {
		const fake = fakeSession();
		const bridge = new PiTernBridge(fake.session, { write: capture().write, surfaceId: "pi" });
		bridge.start();
		expect(bridge.handle({ verb: "e", body: { ev: "focus", id: "x" } })).toBeUndefined();
		expect(fake.calls).toEqual([]);
	});
});

describe("bridge rendering and draft ownership", () => {
	it("renders bash with OMP's run box, command source, state foot and timer", () => {
		const out = capture();
		const fake = fakeSession();
		const bridge = new PiTernBridge(fake.session, { write: out.write, surfaceId: "pi", credits: CREDITS });
		bridge.start();
		fake.session.emit({ type: "tool_execution_start", toolCallId: "c9", toolName: "bash", args: { command: "ls -la" } });
		bridge.handle({ verb: "e", body: { ev: "select", sf: "pi", id: "g-t-c9-rows-0", item: "row-t-c9" } } as never);
		fake.session.emit({ type: "tool_execution_end", toolCallId: "c9", toolName: "bash", result: "ok", isError: false });
		const all = out.writes.join("");
		expect(all).toContain('"k":"tool"');
		expect(all).toContain('"role":"omp.run"');
		expect(all).toContain('"role":"omp.tool.bash.command"');
		expect(all).toContain('"text":"ls -la"');
		expect(all).toContain('"role":"omp.run.foot"');
		expect(all).toContain('"frame":"inline"');
		expect(all).toContain('"preview":"children"');
		expect(all).toContain('"status":"done"');
	});

	it("uses OMP's optional Bash name in the verb and description as intent", () => {
		const p = new TranscriptProjector();
		p.apply({ type: "tool_execution_start", toolCallId: "named", toolName: "bash", args: { name: "Tests", description: "Run focused checks", command: "npm test" } });
		p.apply({ type: "tool_execution_end", toolCallId: "named", toolName: "bash", result: { content: [{ type: "text", text: "ok" }], details: { exit_code: 0 } }, isError: false });
		expect(detail(p, "named").p).toMatchObject({ title: "Bash · Tests", target: "Run focused checks", targetKind: "text", command: "npm test" });
	});

	it("renders live bash output before completion and replaces it with human-readable final output", () => {
		const out = capture();
		const fake = fakeSession();
		const bridge = new PiTernBridge(fake.session, { write: out.write, surfaceId: "pi", credits: CREDITS });
		bridge.start();
		fake.session.emit({ type: "tool_execution_start", toolCallId: "live", toolName: "bash", args: { command: "printf first; sleep 1; printf second" } });
		bridge.handle({ verb: "e", body: { ev: "select", sf: "pi", id: "g-t-live-rows-0", item: "row-t-live" } } as never);
		fake.session.emit({ type: "tool_execution_update", toolCallId: "live", partialResult: { content: [{ type: "text", text: "first" }] } });
		const during = out.writes.join("");
		expect(during).toContain("1 running");
		// The selected row's renderer opens beneath it (expanded), so its live output is visible while running.
		expect(during).toContain('"collapsed":false');
		expect(during).toContain('"k":"ansi"');
		expect(during).toContain("printf first");
		fake.session.emit({ type: "tool_execution_update", toolCallId: "live", partialResult: { content: [{ type: "text", text: "firstsecond" }] } });
		fake.session.emit({ type: "tool_execution_end", toolCallId: "live", toolName: "bash", result: { content: [{ type: "text", text: '<result exit_code="0"><stdout><![CDATA[firstsecond]]></stdout><stderr><![CDATA[]]></stderr></result>' }], details: { duration_ms: 1000 } }, isError: false });
		expect(bridge.items[0]).toMatchObject({ output: "firstsecond", status: "ok", took: 1000 });
		expect(bridge.items[0]?.output).not.toContain("<result");
	});

	it("shows failure and cancellation with OMP run states and preserves output", () => {
		const p = new TranscriptProjector();
		p.apply({ type: "tool_execution_start", toolCallId: "failed", toolName: "bash", args: { command: "exit 7", description: "Check status" } });
		p.apply({ type: "tool_execution_update", toolCallId: "failed", partialResult: { content: [{ type: "text", text: "before failure" }] } });
		p.apply({ type: "tool_execution_end", toolCallId: "failed", toolName: "bash", result: { content: [{ type: "text", text: "Error executing bash: Command exited with code 7" }], details: { exit_code: 7, duration_ms: 50 } }, isError: true });
		const failed = detail(p, "failed");
		expect(failed.p).toMatchObject({ status: "error", exit: 7, title: "Bash", target: "Check status" });
		expect(failed.c?.[0]?.c?.[1]).toMatchObject({ k: "ansi", p: { text: "before failure", follow: true } });
		expect(failed.c?.[0]?.c?.[2]?.c?.[0]?.p).toMatchObject({ spans: [{ t: "exit 7" }] });
		p.apply({ type: "tool_execution_start", toolCallId: "cancelled", toolName: "bash", args: { command: "sleep 10" } });
		p.apply({ type: "agent_end" });
		expect(detail(p, "cancelled").p).toMatchObject({ status: "cancelled", note: "cancelled" });
		expect(p.apply({ type: "tool_execution_update", toolCallId: "cancelled", partialResult: "late" })).toBe(false);
		expect(p.apply({ type: "tool_execution_end", toolCallId: "cancelled", result: "late", isError: true })).toBe(false);
		expect(detail(p, "cancelled").p).toMatchObject({ status: "cancelled" });
		expect(p.apply({ type: "tool_execution_start", toolCallId: "cancelled", toolName: "bash", args: {} })).toBe(false);
		expect(rowsOf(p)).toHaveLength(2);
	});

	it("recognizes thrown Bash failures without details and distinguishes timeout", () => {
		const p = new TranscriptProjector();
		p.apply({ type: "tool_execution_start", toolCallId: "err", toolName: "bash", args: { command: "exit 9" } });
		p.apply({ type: "tool_execution_end", toolCallId: "err", toolName: "bash", result: { content: [{ type: "text", text: "Error executing bash: Command exited with code 9: exit status 9" }] }, isError: true });
		expect(detail(p, "err").p).toMatchObject({ status: "error", exit: 9 });
		p.apply({ type: "tool_execution_start", toolCallId: "timeout", toolName: "bash", args: { command: "wait" } });
		p.apply({ type: "tool_execution_end", toolCallId: "timeout", toolName: "bash", result: { content: [{ type: "text", text: "Error executing bash: command timed out after 60s (exit_code=-1)" }] }, isError: true });
		expect(detail(p, "timeout").p).toMatchObject({ status: "error", note: "timed out", tone: "warning" });
	});

	it("retains streamed ANSI colors when the final model envelope strips them", () => {
		const p = new TranscriptProjector();
		p.apply({ type: "tool_execution_start", toolCallId: "color", toolName: "bash", args: { command: "printf red" } });
		p.apply({ type: "tool_execution_update", toolCallId: "color", partialResult: { content: [{ type: "text", text: "\x1b[31mred\x1b[0m" }] } });
		p.apply({ type: "tool_execution_end", toolCallId: "color", result: { content: [{ type: "text", text: '<result exit_code="0"><stdout><![CDATA[red]]></stdout><stderr><![CDATA[]]></stderr></result>' }] }, isError: false });
		expect(detail(p, "color").c?.[0]?.c?.[1]?.p?.text).toBe("\x1b[31mred\x1b[0m");
	});

	it("keeps the observed interleaving instead of replacing it with channel-grouped XML", () => {
		const p = new TranscriptProjector();
		p.apply({ type: "tool_execution_start", toolCallId: "interleaved", toolName: "bash", args: { command: "print" } });
		p.apply({ type: "tool_execution_update", toolCallId: "interleaved", partialResult: { content: [{ type: "text", text: "out-1 err-2 out-3" }] } });
		p.apply({ type: "tool_execution_end", toolCallId: "interleaved", result: { content: [{ type: "text", text: '<result exit_code="0"><stdout><![CDATA[out-1 out-3]]></stdout><stderr><![CDATA[err-2]]></stderr></result>' }] }, isError: false });
		expect(detail(p, "interleaved").c?.[0]?.c?.[1]?.p?.text).toBe("out-1 err-2 out-3");
	});

	it("keeps the draft in the bridge and clears it on submit", async () => {
		const fake = fakeSession();
		const bridge = new PiTernBridge(fake.session, { write: capture().write, surfaceId: "pi", credits: CREDITS });
		bridge.start();
		bridge.appendDraft("hi");
		bridge.backspaceDraft();
		bridge.appendDraft("ey");
		expect(bridge.draft).toBe("hey");
		void bridge.submitDraft();
		expect(fake.calls).toEqual(["prompt:hey"]);
		expect(bridge.draft).toBe("");
	});

	it("Ctrl+C draft clearing leaves an active turn alone", async () => {
		const fake = fakeSession();
		const bridge = new PiTernBridge(fake.session, { write: capture().write, surfaceId: "pi", credits: CREDITS });
		bridge.start();
		const submitted = bridge.submit("running");
		bridge.appendDraft("clear me");
		bridge.clearDraft();
		expect(bridge.draft).toBe("");
		expect(bridge.busy).toBe(true);
		expect(fake.calls).not.toContain("abort");
		fake.finish();
		await submitted;
	});

	it("escape clears a non-empty draft first, then closes with the configured none action", () => {
		const fake = fakeSession();
		fake.session.settingsManager = { getDoubleEscapeAction: () => "none" };
		const bridge = new PiTernBridge(fake.session, { write: capture().write, surfaceId: "pi", credits: CREDITS });
		bridge.start();
		bridge.appendDraft("stray");
		expect(bridge.escape()).toBe(false);
		expect(bridge.draft).toBe("");
		expect(bridge.closed).toBe(false);
		expect(bridge.escape()).toBe(true);
		expect(bridge.closed).toBe(true);
	});

	it("escape while running cancels and does not close", async () => {
		const fake = fakeSession();
		const bridge = new PiTernBridge(fake.session, { write: capture().write, surfaceId: "pi", credits: CREDITS });
		bridge.start();
		void bridge.submit("long");
		fake.session.emit({ type: "agent_start" });
		expect(bridge.escape()).toBe(false);
		await Promise.resolve();
		expect(fake.calls).toContain("abort");
		expect(bridge.closed).toBe(false);
	});

	it("never renders a grant action in the dock", () => {
		const out = capture();
		const bridge = new PiTernBridge(fakeSession().session, { write: out.write, surfaceId: "pi", credits: CREDITS });
		bridge.start();
		const frame = JSON.stringify(lastFrame(out.writes));
		expect(frame).not.toContain('"approve"');
	});
});

describe("bridge wire compatibility", () => {
	it("produces frames parseable by the TSP reader", () => {
		const out = capture();
		const fake = fakeSession();
		const bridge = new PiTernBridge(fake.session, { write: out.write, surfaceId: "pi", credits: CREDITS });
		bridge.start();
		for (const w of out.writes) expect(w.startsWith(`${ESC}_tsp;`)).toBe(true);
		expect(out.writes.every((w) => w.endsWith(ST))).toBe(true);
	});
});
