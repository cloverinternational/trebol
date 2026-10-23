import { describe, expect, it } from "vitest";
import {
	APC_LIMIT,
	ESC,
	ST,
	TernInlineSurface,
	detectTern,
	encodeTsp,
	diffChildren,
	encodeTspChunks,
	helloQuery,
	parseTspMessages,
	projectTranscript,
	splitInput,
	shouldProbe,
	type TspMessage,
} from "../../lib/tern/tsp.ts";

const HELLO_REPLY = `${ESC}_tsp;r;{"r":"hello","v":1,"term":"tern","ver":"0.4.3","kinds":["col","md"],"features":["flow"],"apc":65536,"credits":2}${ST}`;
const DA1 = `${ESC}[?62;52;c`;

function capture() {
	const writes: string[] = [];
	return { writes, write: (d: string) => writes.push(d) };
}

function frames(writes: string[]) {
	return writes
		.filter((w) => w.startsWith(`${ESC}_tsp;f;`))
		.map((w) => JSON.parse(w.slice(`${ESC}_tsp;f;`.length, -ST.length)));
}

describe("TSP wire encoding", () => {
	it("sends a surface-scoped composer stylesheet before the first frame", () => {
		const { writes, write } = capture();
		const surface = new TernInlineSurface(write, "pi");
		surface.open("pi");
		surface.stylesheet("composer", ".sf-col[data-role='pi.editor'] { gap: 8px; }");
		surface.render([]);
		expect(writes.map((w) => w.match(/^\x1b_tsp;([a-z]);/)?.[1])).toEqual(["o", "s", "f"]);
		expect(parseTspMessages(writes[1])[0]?.body).toMatchObject({ sf: "pi", name: "composer" });
	});
	it("frames verb and JSON body with ST and keeps ';' and '=' inside the body", () => {
		const out = encodeTsp("x", { id: "a;b=c", keep: false });
		expect(out).toBe(`${ESC}_tsp;x;{"id":"a;b=c","keep":false}${ST}`);
	});

	it("rejects bodies over the APC limit instead of sending an unchunked string", () => {
		expect(() => encodeTsp("f", { big: "x".repeat(APC_LIMIT) })).toThrow(RangeError);
	});

	it("builds the hello query followed by DA1", () => {
		expect(helloQuery("pi", ["send"])).toBe(
			`${ESC}_tsp;q;{"q":"hello","v":[1],"app":"pi","features":["send"]}${ST}${ESC}[c`,
		);
	});
});

describe("TSP parsing and detection", () => {
	it("chunks oversized bodies with c= and m=1 on all but the last, reassembling to the original", () => {
		const body = { sf: "s", s: 1, ops: [["add", "main", "s", null, { id: "x", k: "md", p: { text: "é".repeat(50_000) } }]] };
		const chunks = encodeTspChunks("f", body, 1000);
		expect(chunks.length).toBeGreaterThan(1);
		const parts = chunks.map((c, i) => {
			const head = `${ESC}_tsp;f;c=`;
			expect(c.startsWith(head)).toBe(true);
			const id = c.slice(head.length).split(";")[0];
			expect(id).toMatch(/^k\d+$/);
			const more = i < chunks.length - 1 ? "m=1;" : "";
			expect(c.slice(head.length + id.length + 1).startsWith(more)).toBe(true);
			const rest = c.slice(head.length + id.length + 1 + more.length, -ST.length);
			expect(Buffer.byteLength(rest)).toBeLessThanOrEqual(1000);
			return rest;
		});
		expect(JSON.parse(parts.join(""))).toEqual(body);
	});

	it("keeps small bodies as one unchunked message", () => {
		expect(encodeTspChunks("x", { id: "a" })).toEqual([encodeTsp("x", { id: "a" })]);
	});

	it("splits long unbroken runs of word characters without failing", () => {
		const body = { id: "x", k: "md", p: { text: "a".repeat(70_000) } };
		const chunks = encodeTspChunks("f", body, 65536);
		expect(chunks.length).toBeGreaterThan(1);
		const joined = chunks
			.map((c) => c.replace(/^\x1b_tsp;f;c=k\d+;(m=1;)?/, "").slice(0, -ST.length))
			.join("");
		expect(JSON.parse(joined)).toEqual(body);
	});

	it("holds back an incomplete APC string and separates keys from complete messages", () => {
		const msg = `${ESC}_tsp;e;{"ev":"ack","sf":"s","s":1}${ST}`;
		const got = splitInput(`ab${msg}cd`);
		expect(got.keys).toBe("abcd");
		expect(got.messages).toHaveLength(1);
		const partial = splitInput(`x${ESC}_tsp;e;{"ev"`);
		expect(partial.keys).toBe("x");
		expect(partial.rest).toBe(`${ESC}_tsp;e;{"ev"`);
		const esc = splitInput(`k${ESC}_ts`);
		expect(esc.rest).toBe(`${ESC}_ts`);
	});

	it("extracts replies and events, ignoring malformed bodies", () => {
		const input = `${HELLO_REPLY}${ESC}_tsp;e;{bad json${ST}${ESC}_tsp;e;{"ev":"ack","sf":"s1","s":3}${ST}`;
		const msgs = parseTspMessages(input);
		expect(msgs.map((m) => m.verb)).toEqual(["r", "e"]);
		expect(msgs[1].body).toEqual({ ev: "ack", sf: "s1", s: 3 });
	});

	it("detects TSP only when a v1 hello precedes DA1", () => {
		const caps = detectTern(HELLO_REPLY + DA1);
		expect(caps).toMatchObject({ term: "tern", ver: "0.4.3", credits: 2, apc: 65536, features: ["flow"] });
		expect(detectTern(DA1)).toBeNull();
		expect(detectTern(HELLO_REPLY)).toBeNull();
		expect(detectTern(HELLO_REPLY.replace('"v":1', '"v":2') + DA1)).toBeNull();
		expect(detectTern(DA1 + HELLO_REPLY)).toBeNull();
	});

	it("does not probe inside multiplexers or when TERN_TSP=0", () => {
		expect(shouldProbe({})).toBe(true);
		expect(shouldProbe({ TERN_TSP: "0" })).toBe(false);
		expect(shouldProbe({ TMUX: "/tmp/tmux" })).toBe(false);
		expect(shouldProbe({ STY: "1" })).toBe(false);
		expect(shouldProbe({ ZELLIJ: "0" })).toBe(false);
	});
});

describe("TernInlineSurface", () => {
	it("opens, adds main and dock once, then diffs by key instead of rebuilding main", () => {
		const { writes, write } = capture();
		const surface = new TernInlineSurface(write, "pi1", 2);
		surface.open("pi");
		surface.render([{ id: "a", k: "md", p: { text: "one" } }]);
		surface.render([{ id: "a", k: "md", p: { text: "two" } }]);
		expect(writes[0]).toBe(`${ESC}_tsp;o;{"id":"pi1","mode":"inline","title":"pi"}${ST}`);
		const sent = frames(writes);
		expect(sent).toHaveLength(2);
		expect(sent[0].ops.slice(0, 2).map((o: unknown[]) => o[1])).toEqual(["main", "dock"]);
		expect(sent[1].s).toBe(2);
		expect(sent[1].ops).toEqual([["set", "a", { text: "two" }]]);
	});

	it("streams growing text as text append ops on the same keyed node", () => {
		const { writes, write } = capture();
		const surface = new TernInlineSurface(write, "pi1", 1000);
		surface.open();
		surface.render([{ id: "a", k: "md", p: { text: "Hel" } }]);
		surface.render([{ id: "a", k: "md", p: { text: "Hello" } }]);
		const sent = frames(writes);
		expect(sent[1].ops).toEqual([["text", "a", "append", "lo"]]);
	});

	it("patches status without resending local collapse state and still clears removed props", () => {
		const before = { id: "work", k: "tool", p: { collapsed: true, status: "running", title: "Working", note: "old" } };
		const after = { id: "work", k: "tool", p: { collapsed: true, status: "done", title: "Done" } };
		expect(diffChildren("main", [before], [after])).toEqual([
			["set", "work", { note: null, status: "done", title: "Done" }],
		]);
		expect(diffChildren("main", [after], [{ ...after, p: { ...after.p, collapsed: false } }])).toEqual([
			["set", "work", { collapsed: false }],
		]);
	});

	it("appends a new keyed child and deletes removed tail children without touching the rest", () => {
		const { writes, write } = capture();
		const surface = new TernInlineSurface(write, "pi1", 1000);
		surface.open();
		const a = { id: "a", k: "md", p: { text: "x" } };
		surface.render([a, { id: "b", k: "md", p: { text: "y" } }]);
		surface.render([a, { id: "c", k: "md", p: { text: "z" } }]);
		const ops = frames(writes)[1].ops;
		expect(ops.map((o: unknown[]) => o[0])).toEqual(["del", "add"]);
		expect(ops[0]).toEqual(["del", "b"]);
		expect(ops[1]).toEqual(["add", "c", "main", null, { id: "c", k: "md", p: { text: "z" } }]);
	});

	it("sends a focus op for the composer when it is named", () => {
		const { writes, write } = capture();
		const surface = new TernInlineSurface(write, "pi1", 1000);
		surface.open();
		surface.render([], [{ id: "composer", k: "editor", p: { text: "" } }], "composer");
		expect(frames(writes)[0].ops.at(-1)).toEqual(["focus", "composer"]);
	});

	it("reveals a changed autocomplete selection after list updates, without repeating an unchanged reveal", () => {
		const { writes, write } = capture();
		const surface = new TernInlineSurface(write, "pi1", 1000);
		surface.open();
		const list = [{ id: "list", k: "list", c: [{ id: "list/one", k: "item" }, { id: "list/two", k: "item" }] }];
		surface.render([], [], "composer", list, "list/one");
		surface.render([], [], "composer", list, "list/one");
		surface.render([], [], "composer", list, "list/two");
		expect(frames(writes)).toHaveLength(2);
		expect(frames(writes)[0].ops.at(-1)).toEqual(["reveal", "list/one", "nearest"]);
		expect(frames(writes)[1].ops).toEqual([["reveal", "list/two", "nearest"]]);
	});

	it("skips identical views", () => {
		const { writes, write } = capture();
		const surface = new TernInlineSurface(write, "pi1");
		surface.open();
		surface.render([{ id: "a", k: "md", p: { text: "same" } }]);
		surface.render([{ id: "a", k: "md", p: { text: "same" } }]);
		expect(frames(writes)).toHaveLength(1);
	});

	it("holds only the newest view while credit is exhausted and sends it on ack", () => {
		const { writes, write } = capture();
		const surface = new TernInlineSurface(write, "pi1", 1);
		surface.open();
		surface.render([{ id: "a", k: "md", p: { text: "1" } }]);
		surface.render([{ id: "a", k: "md", p: { text: "2" } }]);
		surface.render([{ id: "a", k: "md", p: { text: "3" } }]);
		expect(frames(writes)).toHaveLength(1);

		const ack = (s: number): TspMessage => ({ verb: "e", body: { ev: "ack", sf: "pi1", s } });
		surface.handleEvent(ack(1));
		const sent = frames(writes);
		expect(sent).toHaveLength(2);
		expect(JSON.stringify(sent[1].ops)).toContain('"3"');
		expect(JSON.stringify(sent[1].ops)).not.toContain('"2"');
	});

	it("ignores acks for other surfaces", () => {
		const { writes, write } = capture();
		const surface = new TernInlineSurface(write, "pi1", 1);
		surface.open();
		surface.render([{ id: "a", k: "md", p: { text: "1" } }]);
		surface.render([{ id: "a", k: "md", p: { text: "2" } }]);
		surface.handleEvent({ verb: "e", body: { ev: "ack", sf: "other", s: 1 } });
		expect(frames(writes)).toHaveLength(1);
	});

	it("closes with x and keep flag, sending any pending view first", () => {
		const { writes, write } = capture();
		const surface = new TernInlineSurface(write, "pi1", 1);
		surface.open();
		surface.render([{ id: "a", k: "md", p: { text: "1" } }]);
		surface.render([{ id: "a", k: "md", p: { text: "last" } }]);
		surface.close();
		expect(frames(writes)).toHaveLength(2);
		expect(writes[writes.length - 1]).toBe(`${ESC}_tsp;x;{"id":"pi1","keep":false}${ST}`);
	});

	it("refuses to render before open", () => {
		const surface = new TernInlineSurface(capture().write, "pi1");
		expect(() => surface.render([])).toThrow(/before open/);
	});
});

describe("projectTranscript", () => {
	it("maps messages to keyed md nodes with unique ids", () => {
		const nodes = projectTranscript([
			{ id: "1", role: "user", text: "hi" },
			{ id: "2", role: "assistant", text: "hello **there**" },
		]);
		expect(nodes).toEqual([
			{ id: "msg-1", k: "card", p: { role: "pi.user", tone: "user" }, c: [{ id: "msg-1.body", k: "md", p: { text: "hi" } }] },
			{ id: "msg-2", k: "col", p: { role: "pi.assistant" }, c: [{ id: "msg-2.body", k: "md", p: { text: "hello **there**", stream: false } }] },
		]);
		expect(new Set(nodes.map((n) => n.id)).size).toBe(nodes.length);
	});
});

describe("diffChildren", () => {
	it("streams only the added assistant text into its stable Markdown child", () => {
		const before = projectTranscript([{ id: "a", role: "assistant", text: "Hel" }]);
		const after = projectTranscript([{ id: "a", role: "assistant", text: "Hello" }]);
		expect(diffChildren("main", before, after)).toEqual([["text", "msg-a.body", "append", "lo"]]);
	});
	it("emits set for a changed prop and null for a removed one", () => {
		const ops = diffChildren("main", [{ id: "t", k: "tool", p: { status: "running", target: "ls" } }], [
			{ id: "t", k: "tool", p: { status: "done" } },
		]);
		expect(ops).toEqual([["set", "t", { status: "done", target: null }]]);
	});

	it("recurses into children of a matched node", () => {
		const ops = diffChildren("main", [{ id: "p", k: "col", c: [{ id: "q", k: "md", p: { text: "a" } }] }], [
			{ id: "p", k: "col", c: [{ id: "q", k: "md", p: { text: "ab" } }] },
		]);
		expect(ops).toEqual([["text", "q", "append", "b"]]);
	});

	it("emits nothing for identical trees", () => {
		const node = { id: "x", k: "md", p: { text: "same" } };
		expect(diffChildren("main", [node], [{ ...node, p: { text: "same" } }])).toEqual([]);
	});

	// A positional diff deleted and re-added every sibling after a removal. The terminal loses its per-node
	// state with each re-add (local fold, ansi scroll, highlighted block), so a work card repainted its whole
	// step list whenever one child disappeared.
	it("removes one child without re-adding the siblings that follow it", () => {
		const a = { id: "a", k: "md", p: { text: "a" } };
		const b = { id: "b", k: "md", p: { text: "b" } };
		const c = { id: "c", k: "md", p: { text: "c" } };
		expect(diffChildren("main", [a, b, c], [a, c])).toEqual([["del", "b"]]);
		expect(diffChildren("main", [a, b, c], [b, c])).toEqual([["del", "a"]]);
	});

	it("adds a child before the existing ones without touching them", () => {
		const a = { id: "a", k: "md", p: { text: "a" } };
		const b = { id: "b", k: "md", p: { text: "b" } };
		const step = { id: "s", k: "tool", p: { status: "running" } };
		// The new child is appended, then the last survivor is moved behind it: no sibling is rebuilt.
		expect(diffChildren("main", [a, b], [a, step, b])).toEqual([
			["add", "s", "main", null, step],
			["move", "b", "main", null],
		]);
	});

	it("moves a surviving child instead of rebuilding its subtree", () => {
		const a = { id: "a", k: "tool", p: { status: "running" }, c: [{ id: "a-out", k: "ansi", p: { text: "x" } }] };
		const b = { id: "b", k: "text", p: { text: "note" } };
		// The note moves below the still-running step: no del/add for `a`, only its new position.
		expect(diffChildren("main", [b, a], [a, b])).toEqual([["move", "b", "main", null]]);
	});

	it("re-adds a child whose kind changed, since a node cannot be re-kinded in place", () => {
		const before = { id: "x", k: "text", p: { text: "a" } };
		const after = { id: "x", k: "shimmer", p: { text: "a" } };
		expect(diffChildren("main", [before], [after])).toEqual([
			["del", "x"],
			["add", "x", "main", null, after],
		]);
	});
});
