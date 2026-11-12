// Keystroke cost vs. session length. A keystroke re-renders the whole surface, so anything the render does
// per transcript item makes typing slower the longer a pane stays open. This file measures that growth on the
// real PiTernBridge and replays every emitted frame through an independent model of Tern's node tree, so a
// faster diff that sends wrong ops fails here even when the timings look good.
// TERN_PERF=1 prints the full table (N up to 1000); the default run keeps a small, fast scaling gate.
import { describe, expect, it } from "vitest";
import { performance } from "node:perf_hooks";
import { OUTPUT_KEEP_CHARS, PiTernBridge, TRANSCRIPT_EARLIER, TRANSCRIPT_TRIM_TURNS, TRANSCRIPT_WINDOW_TURNS, TranscriptProjector, type PiEventLike, type PiSessionLike } from "../../lib/tern/bridge.ts";
import { ESC, ST, diffChildren, encodeTspChunks, parseTspMessages, type TspNode } from "../../lib/tern/tsp.ts";

function fakeSession(branch: unknown[] = []) {
	const listeners = new Set<(e: PiEventLike) => void>();
	const session: PiSessionLike & { emit(e: PiEventLike): void } = {
		subscribe(l: (e: PiEventLike) => void) { listeners.add(l); return () => listeners.delete(l); },
		prompt() { return new Promise<void>(() => {}); },
		async abort() {},
		dispose() {},
		emit(e: PiEventLike) { for (const l of listeners) l(e); },
		sessionManager: { getBranch: () => branch, getSessionId: () => "perf" },
	} as never;
	return session;
}

const userMsg = (text: string) => ({ role: "user", content: [{ type: "text", text }] });
const asstMsg = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });

// One realistic turn: a request, narration, two tool calls with output, and a markdown answer.
function turnEvents(i: number): PiEventLike[] {
	const answer = `## Result ${i}\n\nChanged \`file-${i}.ts\`:\n\n- first point about turn ${i}\n- second point\n\n\`\`\`ts\nconst x${i} = ${i};\n\`\`\`\n`;
	return [
		{ type: "agent_start" },
		{ type: "message_start", message: userMsg(`please fix issue ${i}`) },
		{ type: "message_end", message: userMsg(`please fix issue ${i}`) },
		{ type: "message_start", message: asstMsg("") },
		{ type: "message_update", message: {}, assistantMessageEvent: { type: "text_delta", delta: `Looking at issue ${i}.` } },
		{ type: "message_update", message: {}, assistantMessageEvent: { type: "toolcall_start" } },
		{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: `Looking at issue ${i}.` }, { type: "toolCall", id: `a${i}`, name: "bash", arguments: {} }] } },
		{ type: "tool_execution_start", toolCallId: `a${i}`, toolName: "bash", args: { command: `rg -n issue${i} src`, description: "search" } },
		{ type: "tool_execution_update", toolCallId: `a${i}`, partialResult: { content: [{ type: "text", text: `src/a.ts:${i}: issue${i}\n` }] } },
		{ type: "tool_execution_end", toolCallId: `a${i}`, toolName: "bash", result: { content: [{ type: "text", text: `src/a.ts:${i}: issue${i}\n` }], details: { exit_code: 0, duration_ms: 12 } }, isError: false },
		{ type: "tool_execution_start", toolCallId: `b${i}`, toolName: "read", args: { path: `src/file-${i}.ts` } },
		{ type: "tool_execution_end", toolCallId: `b${i}`, toolName: "read", result: { content: [{ type: "text", text: "line\n".repeat(20) }], details: { duration_ms: 3 } }, isError: false },
		{ type: "message_start", message: asstMsg("") },
		// Streamed in pieces, so the wire carries `text append` ops as it does live.
		...[0, 1, 2].map((k) => ({ type: "message_update", message: {}, assistantMessageEvent: { type: "text_delta", delta: answer.slice((k * answer.length) / 3, ((k + 1) * answer.length) / 3) } })),
		{ type: "message_end", message: asstMsg(answer) },
		{ type: "agent_end" },
	];
}

// ---- Independent oracle: a minimal model of Tern's tree that applies TSP frame ops. -------------------------
type MNode = { id: string; k: string; p: Record<string, unknown>; c: MNode[]; parent?: MNode };
class TreeModel {
	byId = new Map<string, MNode>();
	root: MNode = { id: "pi", k: "surface", p: {}, c: [] };
	constructor() { this.byId.set("pi", this.root); }
	#build(n: TspNode, parent: MNode): MNode {
		const m: MNode = { id: n.id, k: n.k, p: { ...(n.p ?? {}) }, c: [], parent };
		if (this.byId.has(n.id)) throw new Error(`duplicate id ${n.id}`);
		this.byId.set(n.id, m);
		for (const child of n.c ?? []) m.c.push(this.#build(child, m));
		return m;
	}
	#drop(m: MNode) { this.byId.delete(m.id); for (const c of m.c) this.#drop(c); }
	apply(op: unknown[]) {
		const [verb, id] = op as [string, string];
		if (verb === "add") {
			const [, , parentId, before, node] = op as [string, string, string, string | null, TspNode];
			const parent = this.byId.get(parentId);
			if (!parent) throw new Error(`add: no parent ${parentId}`);
			const m = this.#build(node, parent);
			const at = before === null ? -1 : parent.c.findIndex((c) => c.id === before);
			if (at < 0) parent.c.push(m); else parent.c.splice(at, 0, m);
		} else if (verb === "del") {
			const m = this.byId.get(id);
			if (!m) throw new Error(`del: no node ${id}`);
			m.parent!.c.splice(m.parent!.c.indexOf(m), 1);
			this.#drop(m);
		} else if (verb === "set") {
			const m = this.byId.get(id);
			if (!m) throw new Error(`set: no node ${id}`);
			for (const [key, value] of Object.entries(op[2] as Record<string, unknown>)) {
				if (value === null) delete m.p[key]; else m.p[key] = value;
			}
		} else if (verb === "text") {
			const m = this.byId.get(id);
			if (!m) throw new Error(`text: no node ${id}`);
			m.p.text = String(m.p.text ?? "") + String(op[3]);
		} else if (verb === "move") {
			const [, , parentId, before] = op as [string, string, string, string | null];
			const m = this.byId.get(id);
			const parent = this.byId.get(parentId);
			if (!m || !parent) throw new Error(`move: missing ${id}/${parentId}`);
			m.parent!.c.splice(m.parent!.c.indexOf(m), 1);
			m.parent = parent;
			const at = before === null ? -1 : parent.c.findIndex((c) => c.id === before);
			if (at < 0) parent.c.push(m); else parent.c.splice(at, 0, m);
		}
	}
	region(id: string): TspNode[] {
		const plain = (m: MNode): TspNode => ({ id: m.id, k: m.k, ...(Object.keys(m.p).length ? { p: m.p } : {}), ...(m.c.length ? { c: m.c.map(plain) } : {}) });
		return (this.byId.get(id)?.c ?? []).map(plain);
	}
}
// Canonical form of an intended view: drop empty p/c so it compares with the model's plain output.
const canon = (nodes: TspNode[]): TspNode[] => nodes.map((n) => ({ id: n.id, k: n.k, ...(n.p && Object.keys(n.p).length ? { p: JSON.parse(JSON.stringify(n.p)) } : {}), ...(n.c?.length ? { c: canon(n.c) } : {}) }));

// Frame ops from raw writes, reassembling chunked messages (`c=<id>;` with `m=1;` on all but the last) as Tern
// does. A chunk is not JSON on its own, so parsing chunks one by one would silently drop large frames.
const partial = new Map<string, string>();
function frameOps(raw: string): unknown[][] {
	const ops: unknown[][] = [];
	const re = new RegExp(`${ESC}_tsp;f;(?:c=([A-Za-z0-9_-]+);)?(m=1;)?([\\s\\S]*?)${ESC.replace(/[\\^$]/g, "\\$&")}\\\\`, "g");
	for (const m of raw.matchAll(re)) {
		const [, id, more, body] = m;
		let json = body!;
		if (id) {
			json = (partial.get(id) ?? "") + body;
			if (more) { partial.set(id, json); continue; }
			partial.delete(id);
		}
		ops.push(...(JSON.parse(json) as { ops: unknown[][] }).ops);
	}
	return ops;
}

// A persisted branch of `turns` turns, as Pi's SessionManager hands it to a resumed pane.
function persistedBranch(turns: number): unknown[] {
	const out: unknown[] = [];
	const push = (message: unknown) => out.push({ type: "message", id: `e${out.length}`, message });
	for (let i = 0; i < turns; i++) {
		push(userMsg(`old request ${i}`));
		push({ role: "assistant", content: [{ type: "text", text: `On it ${i}.` }, { type: "toolCall", id: `p${i}`, name: "bash", arguments: { command: `ls ${i}` } }] });
		push({ role: "toolResult", toolCallId: `p${i}`, isError: false, content: [{ type: "text", text: `out ${i}` }] });
		push(asstMsg(`Done ${i}.`));
	}
	return out;
}

function harness(branch: unknown[] = []) {
	const writes: string[] = [];
	const session = fakeSession(branch);
	const views: Array<{ main: TspNode[]; dock: TspNode[] }> = [];
	const bridge = new PiTernBridge(session, { write: (d: string) => writes.push(d), surfaceId: "pi", credits: 1_000_000 });
	bridge.start();
	return { bridge, session, writes, views };
}

let draftLen = 0;
function keystroke(bridge: PiTernBridge, ch: string) {
	bridge.handle({ verb: "e", body: { ev: "edit", sf: "pi", id: "composer", from: draftLen, to: draftLen, len: draftLen, cursor: draftLen + 1, text: ch } } as never);
	draftLen += 1;
}

function measure(n: number, keys = 40) {
	const h = harness();
	draftLen = 0;
	for (let i = 0; i < n; i++) for (const e of turnEvents(i)) h.session.emit(e);
	// Warm up the JIT on this size before timing.
	for (let i = 0; i < 5; i++) keystroke(h.bridge, "w");
	const times: number[] = [];
	let bytes = 0, ops = 0;
	for (let i = 0; i < keys; i++) {
		const before = h.writes.length;
		const t0 = performance.now();
		keystroke(h.bridge, "x");
		times.push(performance.now() - t0);
		const out = h.writes.slice(before).join("");
		bytes += out.length;
		ops += frameOps(out).length;
	}
	times.sort((a, b) => a - b);
	// Stage split on a standalone projector holding the same items.
	const p = new TranscriptProjector();
	for (let i = 0; i < n; i++) for (const e of turnEvents(i)) p.apply(e);
	const a = p.nodes(), b = p.nodes();
	const tp = performance.now(); for (let i = 0; i < 10; i++) p.nodes(); const project = (performance.now() - tp) / 10;
	const td = performance.now(); for (let i = 0; i < 10; i++) diffChildren("main", a, b); const diff = (performance.now() - td) / 10;
	return { n, median: times[keys >> 1]!, p95: times[Math.floor(keys * 0.95)]!, project, diff, bytesPerKey: bytes / keys, opsPerKey: ops / keys };
}

describe("Tern bridge keystroke cost vs session length", () => {
	it.runIf(process.env.TERN_PERF === "1")("prints the scaling table", () => {
		const sizes = (process.env.TERN_PERF_SIZES ?? "0,50,200,500,1000").split(",").map(Number);
		for (const n of sizes) {
			const t0 = performance.now();
			const r = measure(n);
			console.log(`turns=${r.n} key_median_ms=${r.median.toFixed(3)} key_p95_ms=${r.p95.toFixed(3)} project_ms=${r.project.toFixed(3)} diff_ms=${r.diff.toFixed(3)} bytes_per_key=${Math.round(r.bytesPerKey)} ops_per_key=${r.opsPerKey.toFixed(1)} build_s=${((performance.now() - t0) / 1000).toFixed(1)}`);
		}
	}, 1_800_000);

	it("a keystroke sends only the composer change, however long the transcript", () => {
		const small = measure(5, 20);
		const large = measure(300, 20);
		expect(large.opsPerKey).toBe(small.opsPerKey);
		expect(large.bytesPerKey).toBeLessThan(small.bytesPerKey * 1.5);
		// Generous bound so CI noise cannot flake it, but linear growth (60x the items) fails it.
		expect(large.median).toBeLessThan(Math.max(small.median * 6, 2));
	}, 60_000);

	it("replaying every emitted frame reproduces the intended view (op oracle)", () => {
		const h = harness();
		draftLen = 0;
		const model = new TreeModel();
		const verbs = new Set<string>();
		let consumed = 0;
		const sync = () => {
			for (const chunk of h.writes.slice(consumed)) for (const op of frameOps(chunk)) { verbs.add(String(op[0])); model.apply(op); }
			consumed = h.writes.length;
		};
		// Interleave turns, streaming deltas, keystrokes, Ctrl+O and an inserted earlier-session notice so cached
		// and fresh subtrees, appends, deletions and reorders all mix.
		for (let i = 0; i < 25; i++) {
			for (const e of turnEvents(i)) {
				h.session.emit(e); sync();
				expect(model.region("main")).toEqual(canon(h.bridge.debugView().main));
			}
			keystroke(h.bridge, "k"); sync();
			if (i % 7 === 3) { h.bridge.toggleToolOutput(); sync(); }
		}
		expect(model.region("main")).toEqual(canon(h.bridge.debugView().main));
		expect(model.region("dock")).toEqual(canon(h.bridge.debugView().dock));
		// The oracle is only meaningful if the run exercised these ops.
		for (const verb of ["add", "set", "text"]) expect(verbs).toContain(verb);
	});

	it("the memoized projection equals a fresh projection at every step (cache oracle)", () => {
		const warm = new TranscriptProjector();
		const events: PiEventLike[] = [];
		// Late changes to settled items (artifacts attach after a tool ends, a message is rewritten), replayed on
		// the fresh projector too. Field values are replaced, as the bridge does.
		const late: Array<(p: TranscriptProjector) => void> = [];
		let expanded = false;
		const check = () => {
			const fresh = new TranscriptProjector();
			for (const e of events) fresh.apply(e);
			for (const change of late) change(fresh);
                        // Live groups read Date.now() for age, and a tool without duration_ms
                        // makes took Date.now() - startedAt. Compare without either clock.
                        const strip = (nodes: TspNode[]) => JSON.parse(JSON.stringify(nodes, (k, v) => (k === "age" || k === "took" ? undefined : v)));
			expect(strip(warm.nodes(expanded))).toEqual(strip(fresh.nodes(expanded)));
		};
		for (let i = 0; i < 12; i++) {
			for (const e of turnEvents(i)) { events.push(e); warm.apply(e); check(); }
			if (i % 3 === 1) { expanded = !expanded; check(); }
			if (i % 4 === 2) {
				const k = i;
				const change = (p: TranscriptProjector) => {
					const items = p.items as unknown as Array<Record<string, unknown>>;
					const tool = items.find((item) => item.id === `t-b${k - 1}`)!;
					tool.output = `rewritten ${k}`;
					const user = items.find((item) => item.role === "user")!;
					user.text = `first request, edited at ${k}`;
				};
				late.push(change);
				change(warm);
				check();
			}
		}
	});
});

// The encoder before it stopped allocating per character; the new one must emit byte-identical chunks.
function referenceChunks(verb: string, body: unknown, limit: number): string[] {
	const enc = (x: string) => new TextEncoder().encode(x).length;
	const json = JSON.stringify(body);
	if (enc(json) <= limit) return [`${ESC}_tsp;${verb};${json}${ST}`];
	const safe = (at: number) => {
		if (at >= json.length) return true;
		const code = json.charCodeAt(at);
		if (code >= 0xdc00 && code <= 0xdfff) return false;
		const semi = json.indexOf(";", at);
		return !/^[A-Za-z0-9_-]+=/.test(semi < 0 ? json.slice(at) : json.slice(at, semi));
	};
	const pieces: string[] = [];
	let start = 0;
	while (start < json.length) {
		let end = start, bytes = 0;
		while (end < json.length) {
			const ch = String.fromCodePoint(json.codePointAt(end)!);
			if (bytes + enc(ch) > limit) break;
			bytes += enc(ch); end += ch.length;
		}
		if (end < json.length) { let e = end; while (e > start && !safe(e)) e--; end = e; }
		pieces.push(json.slice(start, end)); start = end;
	}
	return pieces.map((piece, i) => `${ESC}_tsp;${verb};c=ID;${i < pieces.length - 1 ? "m=1;" : ""}${piece}${ST}`);
}

describe("TSP chunk encoder", () => {
	it("emits the same chunks as the per-character reference for mixed scripts, emoji and parameter-shaped text", () => {
		let seed = 7;
		const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
		const alphabet = ["a", "Z", "0", ";", "=", "x=", "ñ", "é", "中", "文", "😀", "🧪", "\n", " ", "\"", "\u{1F600}"];
		for (let round = 0; round < 60; round++) {
			let text = "";
			const len = 50 + rnd(3000);
			for (let i = 0; i < len; i++) text += alphabet[rnd(alphabet.length)]!.replace("\\n", "\n");
			const body = { sf: "pi", s: round, ops: [["add", "n", "main", null, { id: "n", k: "md", p: { text } }]] };
			const limit = 64 + rnd(900);
			const got = encodeTspChunks("f", body, limit).map((c) => c.replace(/c=k\d+;/, "c=ID;"));
			expect(got).toEqual(referenceChunks("f", body, limit));
		}
	});
});

describe("Transcript render window", () => {
	const earlier = (main: TspNode[]) => main.find((n) => n.id === "transcript-earlier");
	const users = (main: TspNode[]) => main.filter((n) => n.p?.role === "pi.user").length;

	it("a resumed session opens on its last turns, and older turns are one click away", () => {
		const h = harness(persistedBranch(120));
		let main = h.bridge.debugView().main;
		expect(users(main)).toBe(TRANSCRIPT_WINDOW_TURNS);
		expect(earlier(main)?.p?.text).toBe(`↑ 70 earlier turns · show ${TRANSCRIPT_WINDOW_TURNS} more`);
		h.bridge.handle({ verb: "e", body: { ev: "action", sf: "pi", act: TRANSCRIPT_EARLIER } } as never);
		main = h.bridge.debugView().main;
		expect(users(main)).toBe(2 * TRANSCRIPT_WINDOW_TURNS);
		h.bridge.handle({ verb: "e", body: { ev: "action", sf: "pi", act: TRANSCRIPT_EARLIER } } as never);
		main = h.bridge.debugView().main;
		expect(users(main)).toBe(120);
		expect(earlier(main)).toBeUndefined();
	});

	it("a short session shows everything with no earlier row", () => {
		const h = harness(persistedBranch(10));
		expect(users(h.bridge.debugView().main)).toBe(10);
		expect(earlier(h.bridge.debugView().main)).toBeUndefined();
	});

	it("a long live session is trimmed back to the window, and the wire stays exact through trim and expand", () => {
		const h = harness();
		draftLen = 0;
		const model = new TreeModel();
		let consumed = 0;
		const sync = () => { for (const chunk of h.writes.slice(consumed)) for (const op of frameOps(chunk)) model.apply(op); consumed = h.writes.length; };
		for (let i = 0; i <= TRANSCRIPT_TRIM_TURNS; i++) { for (const e of turnEvents(i)) h.session.emit(e); sync(); }
		const main = h.bridge.debugView().main;
		expect(users(main)).toBe(TRANSCRIPT_WINDOW_TURNS);
		expect(model.region("main")).toEqual(canon(main));
		h.bridge.handle({ verb: "e", body: { ev: "action", sf: "pi", act: TRANSCRIPT_EARLIER } } as never); sync();
		expect(users(h.bridge.debugView().main)).toBe(2 * TRANSCRIPT_WINDOW_TURNS);
		expect(model.region("main")).toEqual(canon(h.bridge.debugView().main));
		// Expanded by the user: a new turn must not trim it away again.
		for (const e of turnEvents(999)) h.session.emit(e); sync();
		expect(users(h.bridge.debugView().main)).toBe(2 * TRANSCRIPT_WINDOW_TURNS + 1);
		expect(model.region("main")).toEqual(canon(h.bridge.debugView().main));
	});

	it("revealing a step in a hidden turn brings that turn into the window", () => {
		const p = new TranscriptProjector();
		p.replaceFromSessionBranch(persistedBranch(80));
		const paints = () => JSON.stringify(p.nodes()).includes('"id":"t-p3"');
		expect(paints()).toBe(false);
		expect(p.revealStep("t-p3")).toBeTruthy();
		expect(paints()).toBe(true);
	});

	it("a resumed session's first frame and keystrokes stay bounded however old it is", () => {
		const sized = (turns: number) => {
			const h = harness(persistedBranch(turns));
			const first = h.writes.join("").length;
			draftLen = 0;
			const before = h.writes.length;
			for (let i = 0; i < 20; i++) keystroke(h.bridge, "x");
			return { first, perKey: h.writes.slice(before).join("").length / 20 };
		};
		const small = sized(60), huge = sized(2000);
		// Restoring is linear: an O(n²) item lookup made 3000 turns cost 400 ms before the first frame.
		const restore = (turns: number) => {
			const branch = persistedBranch(turns);
			const p = new TranscriptProjector();
			p.replaceFromSessionBranch(branch);
			const t0 = performance.now();
			for (let i = 0; i < 3; i++) p.replaceFromSessionBranch(branch);
			return (performance.now() - t0) / 3;
		};
		const r500 = restore(500), r4000 = restore(4000);
		expect(r4000).toBeLessThan(Math.max(r500 * 24, 5));
		expect(huge.first).toBeLessThan(small.first * 1.2);
		expect(huge.perKey).toBe(small.perKey);
	}, 60_000);
});

describe("Providers that reuse tool call ids", () => {
	// call ids restart per message, as some OpenAI-compatible gateways do.
	const reused = (): unknown[] => {
		const out: unknown[] = [];
		const push = (message: unknown) => out.push({ type: "message", id: `r${out.length}`, message });
		push(userMsg("first"));
		push({ role: "assistant", content: [{ type: "toolCall", id: "call_0", name: "bash", arguments: { command: "echo one" } }] });
		push({ role: "toolResult", toolCallId: "call_0", isError: false, content: [{ type: "text", text: "one" }] });
		push(asstMsg("ok"));
		push(userMsg("second"));
		push({ role: "assistant", content: [{ type: "toolCall", id: "call_0", name: "bash", arguments: { command: "echo two" } }] });
		push({ role: "toolResult", toolCallId: "call_0", isError: false, content: [{ type: "text", text: "two" }] });
		push(asstMsg("ok"));
		return out;
	};

	it("restores every repeated call settled with its own output, under unique ids", () => {
		const p = new TranscriptProjector();
		p.replaceFromSessionBranch(reused());
		const tools = p.items.filter((i) => i.role === "tool");
		expect(tools.map((t) => [t.status, t.output, t.cancelled ?? false])).toEqual([["ok", "one", false], ["ok", "two", false]]);
		expect(new Set(tools.map((t) => t.id)).size).toBe(2);
	});

	it("shows a live call that reuses a finished call's id as a new step, and the wire stays exact", () => {
		const h = harness(reused());
		const model = new TreeModel();
		for (const op of frameOps(h.writes.join(""))) model.apply(op);
		let consumed = h.writes.length;
		const emit = (e: PiEventLike) => { h.session.emit(e); for (const op of frameOps(h.writes.slice(consumed).join(""))) model.apply(op); consumed = h.writes.length; };
		emit({ type: "agent_start" });
		emit({ type: "message_start", message: userMsg("third") });
		emit({ type: "message_end", message: userMsg("third") });
		emit({ type: "tool_execution_start", toolCallId: "call_0", toolName: "bash", args: { command: "echo three" } });
		emit({ type: "tool_execution_end", toolCallId: "call_0", toolName: "bash", result: { content: [{ type: "text", text: "three" }], details: { exit_code: 0, duration_ms: 1 } }, isError: false });
		emit({ type: "agent_end" });
		const tools = h.bridge.items.filter((i) => i.role === "tool");
		expect(tools.map((t) => t.output)).toEqual(["one", "two", "three"]);
		expect(new Set(tools.map((t) => t.id)).size).toBe(3);
		expect(model.region("main")).toEqual(canon(h.bridge.debugView().main));
	});
});

describe("Hours of runtime", () => {
	const logLine = (i: number) => `INFO worker processed batch ${i} ok\n`;

	it("a command left streaming keeps a bounded tail with an honest count, and its updates do not slow down", () => {
		const p = new TranscriptProjector();
		p.apply({ type: "agent_start" });
		p.apply({ type: "tool_execution_start", toolCallId: "tail", toolName: "bash", args: { command: "tail -f log" } });
		let out = "";
		const cost: number[] = [];
		const total = 30_000;
		for (let i = 0; i < total; i++) {
			out += logLine(i);
			const t = performance.now();
			p.apply({ type: "tool_execution_update", toolCallId: "tail", partialResult: { content: [{ type: "text", text: out }] } });
			p.nodes();
			cost.push(performance.now() - t);
		}
		const item = p.items.find((i) => i.id === "t-tail")!;
		expect(item.output!.length).toBeLessThan(OUTPUT_KEEP_CHARS + 200);
		const kept = item.output!.split("\n");
		const dropped = Number(/^… (\d+) earlier lines not kept$/.exec(kept[0]!)![1]);
		// Every line is accounted for: the dropped count plus the kept lines is the whole stream.
		expect(dropped + kept.length - 2).toBe(total);
		expect(kept.at(-2)).toBe(logLine(total - 1).trimEnd());
		// The live window reports the real number of earlier lines, not the kept ones.
		const live = JSON.stringify(p.nodes());
		expect(live).toContain(`… ${total - 12} earlier lines`);
		const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1]!;
		const early = med(cost.slice(8000, 9000)), late = med(cost.slice(-1000));
		expect(late).toBeLessThan(Math.max(early * 3, 0.5));
	}, 60_000);

	it("a settled noisy command does not keep its full output alive", () => {
		const p = new TranscriptProjector();
		const big = logLine(1).repeat(200_000);
		p.apply({ type: "tool_execution_start", toolCallId: "n", toolName: "bash", args: { command: "npm test" } });
		p.apply({ type: "tool_execution_update", toolCallId: "n", partialResult: { content: [{ type: "text", text: big }] } });
		p.apply({ type: "tool_execution_end", toolCallId: "n", toolName: "bash", result: { content: [{ type: "text", text: big }], details: { exit_code: 1 } }, isError: true });
		const item = p.items[0]!;
		expect(item.output!.length).toBeLessThan(OUTPUT_KEEP_CHARS + 200);
		expect(item.errorText!.length).toBeLessThanOrEqual(OUTPUT_KEEP_CHARS + 1);
		expect(item.output!.startsWith("… ")).toBe(true);
	});

	it("short output is kept exactly as before", () => {
		const p = new TranscriptProjector();
		p.apply({ type: "tool_execution_start", toolCallId: "s", toolName: "bash", args: { command: "ls" } });
		p.apply({ type: "tool_execution_update", toolCallId: "s", partialResult: { content: [{ type: "text", text: "a\nb\n" }] } });
		p.apply({ type: "tool_execution_end", toolCallId: "s", toolName: "bash", result: { content: [{ type: "text", text: "a\nb\n" }], details: { exit_code: 0 } }, isError: false });
		expect(p.items[0]!.output).toBe("a\nb\n");
		expect(p.items[0]!.outputDropped).toBeUndefined();
	});
});

