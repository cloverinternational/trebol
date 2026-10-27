// Tern native composer editing (TSP protocol/input.md, Native editing + Events): the `edit`, `undo` and `send`
// events, the stale-`len` guard, and the `anchor` prop Tern draws a program selection from.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DraftEditor } from "../../lib/tern/draft-edit.ts";
import { PiTernBridge, type PiEventLike, type PiSessionLike } from "../../lib/tern/bridge.ts";
import { UI_PROMPT_INPUT_ID } from "../../lib/tern/ext-ui.ts";
import { keyEffect } from "../../lib/tern/keys.ts";
import { ESC, parseTspMessages, PI_TSP_FEATURES } from "../../lib/tern/tsp.ts";

function editorWith(text: string): DraftEditor {
	const e = new DraftEditor();
	e.setText(text);
	return e;
}

describe("DraftEditor.applyHostEdit", () => {
	it("a click (from == to, no text) only moves the caret and adds no undo step", () => {
		const e = editorWith("hello world");
		expect(e.applyHostEdit({ from: 3, to: 3, text: "", cursor: 3, len: 11 })).toBe(true);
		expect(e.text).toBe("hello world");
		expect(e.cursor).toBe(3);
		expect(e.anchor).toBeNull();
		e.undo();
		expect(e.text).toBe(""); // the only undo step is setText, not the click
	});

	it("replaces a native selection (⌘A then type) and puts the caret where Tern says", () => {
		const e = editorWith("hello world");
		expect(e.applyHostEdit({ from: 0, to: 11, text: "bye", cursor: 3, len: 11 })).toBe(true);
		expect(e.text).toBe("bye");
		expect(e.cursor).toBe(3);
	});

	it("deletes a dragged range with ⌫ (empty text) and is one undo step", () => {
		const e = editorWith("hello world");
		e.applyHostEdit({ from: 5, to: 11, text: "", cursor: 5, len: 11 });
		expect(e.text).toBe("hello");
		e.undo();
		expect(e.text).toBe("hello world");
	});

	it("drops a stale edit whose len no longer matches (keys in flight)", () => {
		const e = editorWith("hello");
		e.insert("!");
		expect(e.applyHostEdit({ from: 0, to: 5, text: "", cursor: 0, len: 5 })).toBe(false);
		expect(e.text).toBe("hello!");
	});

	it("orders reversed offsets, clamps out-of-range ones and rejects non-numbers", () => {
		const e = editorWith("abcdef");
		expect(e.applyHostEdit({ from: 4, to: 2, text: "", cursor: 2, len: 6 })).toBe(true);
		expect(e.text).toBe("abef");
		expect(e.applyHostEdit({ from: 2, to: 99, text: "", cursor: 99, len: 4 })).toBe(true);
		expect(e.text).toBe("ab");
		expect(e.cursor).toBe(2);
		expect(e.applyHostEdit({ from: "0", to: 1, text: "", cursor: 0, len: 2 })).toBe(false);
	});

	it("never splits a surrogate pair", () => {
		const e = editorWith("a😀b"); // 😀 is two UTF-16 units at [1, 3)
		e.applyHostEdit({ from: 2, to: 2, text: "", cursor: 2, len: 4 });
		expect(e.cursor).toBe(1);
		e.applyHostEdit({ from: 2, to: 4, text: "", cursor: 2, len: 4 });
		expect(e.text).toBe("a");
	});

	it("treats a paste marker as atomic: a range touching it removes it whole, a click inside goes to its end", () => {
		const e = new DraftEditor();
		e.insert("x ");
		e.insertPaste(Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n"));
		const marker = e.text.slice(2);
		expect(marker).toMatch(/^\[paste #1 \+12 lines\]$/);
		e.applyHostEdit({ from: 4, to: 4, text: "", cursor: 4, len: e.text.length });
		expect(e.cursor).toBe(e.text.length);
		e.applyHostEdit({ from: 1, to: 5, text: "", cursor: 1, len: e.text.length });
		expect(e.text).toBe("x");
	});

	it("a large paste over a selection becomes a marker; a small one is flattened to one line", () => {
		const e = editorWith("ab");
		e.applyHostEdit({ from: 0, to: 2, text: "one\r\ntwo", cursor: 7, len: 2 });
		expect(e.text).toBe("one two");
		expect(e.cursor).toBe(7);
		const big = Array.from({ length: 12 }, (_, i) => `l${i}`).join("\n");
		e.applyHostEdit({ from: 0, to: 7, text: big, cursor: big.length, len: 7 });
		expect(e.text).toMatch(/^\[paste #\d+ \+12 lines\]$/);
		expect(e.cursor).toBe(e.text.length);
		expect(e.expandedText).toBe(big);
	});

	it("reports the selection anchor for Tern to draw, and none when collapsed", () => {
		const e = editorWith("hello");
		expect(e.anchor).toBeNull();
		e.selectAll();
		expect(e.anchor).toBe(0);
		expect(e.cursor).toBe(5);
		e.move(1);
		expect(e.anchor).toBeNull();
	});
});

function fakeSession() {
	const listeners = new Set<(e: PiEventLike) => void>();
	const prompts: string[] = [];
	const session = {
		disposed: false,
		prompts,
		subscribe(l: (e: PiEventLike) => void) {
			listeners.add(l);
			return () => listeners.delete(l);
		},
		prompt: async (text: string) => { prompts.push(text); },
		abort: async () => {},
		dispose() { this.disposed = true; },
		model: { provider: "p1", id: "m1" },
		modelRuntime: { getAvailableSnapshot: () => ["m1", "m2"].map((id, i) => ({ provider: `p${i + 1}`, id, name: id, api: "test", baseUrl: "", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, reasoning: false, contextWindow: 1000, maxTokens: 500 })), async getAvailable() { return this.getAvailableSnapshot(); } },
		models: [] as string[],
		async setModel(model: { provider: string; id: string }) { this.models.push(`${model.provider}/${model.id}`); },
		sessionManager: { getSessionId: () => "s1", getEntries: () => [] },
		getContextUsage: () => undefined,
	};
	return session as typeof session & PiSessionLike;
}

type Node = { id: string; k: string; p?: Record<string, unknown>; c?: Node[]; parent?: string };

// Replays every frame into the node tree Tern would hold.
function tree(writes: string[]): Map<string, Node> {
	const nodes = new Map<string, Node>();
	const add = (n: Node, parent: string): void => {
		nodes.set(n.id, { ...n, c: undefined, parent });
		for (const c of n.c ?? []) add(c, n.id);
	};
	const del = (id: string): void => {
		for (const [cid, n] of [...nodes]) if (n.parent === id) del(cid);
		nodes.delete(id);
	};
	for (const w of writes) {
		if (!w.startsWith(`${ESC}_tsp;f;`)) continue;
		for (const op of (parseTspMessages(w)[0]?.body as { ops: unknown[][] }).ops) {
			if (op[0] === "add") add(op[4] as Node, String(op[2]));
			else if (op[0] === "del") del(String(op[1]));
			else if (op[0] === "set") {
				const n = nodes.get(String(op[1]));
				if (n) n.p = { ...n.p, ...(op[2] as Record<string, unknown>) };
			}
		}
	}
	return nodes;
}

const composerProps = (writes: string[]): Record<string, unknown> => tree(writes).get("composer")?.p ?? {};

// The `focus` op of the last frame that set one: the field Tern shows the caret in.
function lastFocus(writes: string[]): string | undefined {
	let focus: string | undefined;
	for (const w of writes) {
		if (!w.startsWith(`${ESC}_tsp;f;`)) continue;
		for (const op of (parseTspMessages(w)[0]?.body as { ops: unknown[][] }).ops) if (op[0] === "focus") focus = String(op[1]);
	}
	return focus;
}

describe("PiTernBridge native editing events", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	function make() {
		const writes: string[] = [];
		const session = fakeSession();
		const bridge = new PiTernBridge(session, { write: (d) => writes.push(d), surfaceId: "pi", credits: 1000 });
		bridge.start("pi");
		return { bridge, writes, session };
	}
	const ev = (body: Record<string, unknown>) => ({ verb: "e", body: { sf: "pi", id: "composer", ...body } }) as never;

	it("advertises the same features as OMP 18.13.1's hello", () => {
		expect([...PI_TSP_FEATURES]).toEqual(["edit", "undo", "send"]);
	});

	it("renders a select-all as anchor..cursor (the editor prop Tern draws), not an unknown prop", () => {
		const { bridge, writes } = make();
		for (const ch of "hello") bridge.appendDraft(ch);
		bridge.selectAllDraft();
		const p = composerProps(writes);
		expect(p.anchor).toBe(0);
		expect(p.cursor).toBe(5);
		expect(p).not.toHaveProperty("selection");
		bridge.moveCursor(1, false, false);
		expect(composerProps(writes).anchor).toBeNull();
	});

	it("a click edit event moves the rendered caret; a stale one changes nothing", () => {
		const { bridge, writes } = make();
		for (const ch of "hello") bridge.appendDraft(ch);
		bridge.handle(ev({ ev: "edit", from: 2, to: 2, text: "", cursor: 2, len: 5 }));
		expect(composerProps(writes).cursor).toBe(2);
		bridge.appendDraft("X");
		expect(bridge.draft).toBe("heXllo");
		const frames = writes.length;
		bridge.handle(ev({ ev: "edit", from: 0, to: 5, text: "", cursor: 0, len: 5 }));
		expect(bridge.draft).toBe("heXllo");
		expect(writes.length).toBe(frames);
	});

	it("undo events go through the composer's own history", () => {
		const { bridge } = make();
		for (const ch of "hi") bridge.appendDraft(ch);
		bridge.handle(ev({ ev: "edit", from: 0, to: 2, text: "", cursor: 0, len: 2 }));
		expect(bridge.draft).toBe("");
		bridge.handle(ev({ ev: "undo" }));
		expect(bridge.draft).toBe("hi");
	});

	it("reports sendable and submits a send event without touching the draft", async () => {
		const { bridge, writes, session } = make();
		expect(composerProps(writes).sendable).toBe(true);
		bridge.appendDraft("d");
		await bridge.handle(ev({ ev: "send", text: "line one\nline two" }));
		expect(session.prompts[0]).toContain("line one\nline two");
		expect(bridge.draft).toBe("d");
	});

	it("ignores events for other ids", () => {
		const { bridge } = make();
		bridge.appendDraft("a");
		bridge.handle({ verb: "e", body: { sf: "pi", id: "other", ev: "edit", from: 0, to: 1, text: "", cursor: 0, len: 1 } } as never);
		expect(bridge.draft).toBe("a");
	});
});

describe("extension prompt text field (the other natively edited field)", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	function withPrompt(kind: "input" | "editor" = "input", prefill?: string) {
		const writes: string[] = [];
		const bridge = new PiTernBridge(fakeSession(), { write: (d) => writes.push(d), surfaceId: "pi", credits: 1000 });
		bridge.start("pi");
		const ctx = bridge.uiContext() as { input(t: string): Promise<string | undefined>; editor(t: string, p?: string): Promise<string | undefined> };
		const answer = kind === "input" ? ctx.input("Name") : ctx.editor("Body", prefill);
		const field = () => tree(writes).get(UI_PROMPT_INPUT_ID)?.p ?? {};
		const ev = (body: Record<string, unknown>) => bridge.handle({ verb: "e", body: { sf: "pi", id: UI_PROMPT_INPUT_ID, ...body } } as never);
		return { bridge, writes, answer, field, ev };
	}

	it("a click moves the caret, typing inserts there, and the answer is the edited text", async () => {
		const { bridge, writes, answer, field, ev } = withPrompt();
		for (const ch of "helo") bridge.appendDraft(ch);
		expect(lastFocus(writes)).toBe(UI_PROMPT_INPUT_ID);
		ev({ ev: "edit", from: 3, to: 3, text: "", cursor: 3, len: 4 });
		expect(field().cursor).toBe(3);
		bridge.appendDraft("l");
		expect(field().text).toBe("hello");
		expect(bridge.draft).toBe("");
		await bridge.submitDraft();
		await expect(answer).resolves.toBe("hello");
	});

	it("a native selection replaced by typing is applied, not lost; a stale one is dropped", async () => {
		const { bridge, answer, field, ev } = withPrompt();
		for (const ch of "abc") bridge.appendDraft(ch);
		ev({ ev: "edit", from: 0, to: 3, text: "x", cursor: 1, len: 3 });
		expect(field().text).toBe("x");
		ev({ ev: "edit", from: 0, to: 3, text: "", cursor: 0, len: 3 });
		expect(field().text).toBe("x");
		ev({ ev: "undo" });
		expect(field().text).toBe("abc");
		await bridge.submitDraft();
		await expect(answer).resolves.toBe("abc");
	});

	it("caret keys, select-all and deletes edit the prompt, and its selection is drawn with anchor", () => {
		const { bridge, field } = withPrompt();
		for (const ch of "one two") bridge.appendDraft(ch);
		bridge.applyEditKey(keyEffect("\x1b[H")!); // home
		expect(field().cursor).toBe(0);
		bridge.applyEditKey(keyEffect("\x1b[3;5~")!); // ctrl+delete: word forward
		expect(field().text).toBe(" two");
		bridge.selectAllDraft();
		expect(field().anchor).toBe(0);
		expect(field().cursor).toBe(4);
		expect(bridge.draft).toBe("");
	});

	it("an editor prompt keeps newlines from a native paste and does not count its prefill as an undo step", async () => {
		const { bridge, answer, field, ev } = withPrompt("editor", "pre");
		ev({ ev: "edit", from: 3, to: 3, text: "\nline", cursor: 8, len: 3 });
		expect(field().text).toBe("pre\nline");
		ev({ ev: "undo" });
		ev({ ev: "undo" });
		expect(field().text).toBe("pre");
		await bridge.submitDraft();
		await expect(answer).resolves.toBe("pre");
	});
});

describe("focus event", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("a click in the composer while the model picker is open closes it without choosing and refocuses the composer", async () => {
		const writes: string[] = [];
		const session = fakeSession();
		const bridge = new PiTernBridge(session, { write: (d) => writes.push(d), surfaceId: "pi", credits: 1000 });
		bridge.start("pi");
		bridge.handle({ verb: "e", body: { ev: "action", sf: "pi", id: "model", act: "model.select" } } as never);
		await vi.waitFor(() => expect(tree(writes).has("model-picker-sheet")).toBe(true));
		expect(lastFocus(writes)).toBe("model-picker-sheet");
		bridge.handle({ verb: "e", body: { ev: "focus", sf: "pi", id: "composer" } } as never);
		expect(tree(writes).has("model-picker-sheet")).toBe(false);
		expect(lastFocus(writes)).toBe("composer");
		expect(session.models).toEqual([]);
	});

	it("a modal prompt keeps the keys", () => {
		const writes: string[] = [];
		const bridge = new PiTernBridge(fakeSession(), { write: (d) => writes.push(d), surfaceId: "pi", credits: 1000 });
		bridge.start("pi");
		void (bridge.uiContext() as { input(t: string): Promise<unknown> }).input("Name");
		bridge.handle({ verb: "e", body: { ev: "focus", sf: "pi", id: "composer" } } as never);
		expect(lastFocus(writes)).toBe(UI_PROMPT_INPUT_ID);
	});
});

// The runner itself, on a real pty: the hello it writes first is what Tern decides native editing from.
describe.skipIf(process.platform === "win32")("Pi Tern runner hello", () => {
	it("is written with edit, undo and send", () => {
		const root = fileURLToPath(new URL("../../..", import.meta.url));
		let out: string;
		try {
			out = JSON.parse(execFileSync("python3", [fileURLToPath(new URL("./fixtures/pty-hello.py", import.meta.url)), ".pi/lib/tern/run.ts", "30"], { cwd: root, encoding: "utf8", timeout: 40_000 })) as string;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return; // no python3 on this host
			throw error;
		}
		const hello = parseTspMessages(out).find((m) => m.verb === "q" && m.body.q === "hello");
		expect(hello?.body).toMatchObject({ app: "pi", features: ["edit", "undo", "send"] });
	}, 45_000);
});
