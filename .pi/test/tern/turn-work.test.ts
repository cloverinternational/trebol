// Turn-work UI: replay of real recorded Pi sessions and the four turn-grouping properties.
// Corpus: .pi/test/tern/fixtures/turn-work/*.events.jsonl were recorded from a live Tern window with
// PI_TERN_EVENT_LOG (see .pi/test/tern/live/extract-corpus.py); *.session.jsonl is Pi's persisted branch
// for the same session. No event in the corpus is hand-written.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PiTernBridge, TranscriptProjector, type PiEventLike, type PiSessionLike } from "../../lib/tern/bridge.ts";
import { ESC, parseTspMessages, type TspNode } from "../../lib/tern/tsp.ts";
import { summaryText } from "../../lib/tern/turn-groups.ts";
import { patchRunningWork, removeRunningWork, setRunningWork } from "../../lib/ui/running-work-store.ts";

const DIR = join(import.meta.dirname, "fixtures/turn-work");
const readJsonl = (file: string) => readFileSync(join(DIR, file), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const corpus = readdirSync(DIR).filter((f) => f.endsWith(".events.jsonl")).sort().map((f) => {
	const name = f.replace(".events.jsonl", "");
	return { name, events: readJsonl(f) as PiEventLike[], branch: readJsonl(`${name}.session.jsonl`) as unknown[] };
});

// The one-line text a settled summary shows (title, goal, step count), read back from the node.
const cardText = (n: TspNode) => summaryText(
	n.p?.title === "Done" ? "done" : n.p?.title === "Failed" ? "failed" : "interrupted",
	String(n.p?.target ?? ""),
	Number(String((n.p?.meta as string[] | undefined)?.[0] ?? "0").split(" ")[0]),
);
const workView = (nodes: readonly TspNode[]) => nodes.flatMap((n) =>
	n.p?.role === "tern.work-live" ? [`LIVE ${String(n.p.text)}`] : n.p?.role === "tern.work" ? [`SUMMARY ${cardText(n)}`] : []);

describe("replay corpus", () => {
	it("is built from real recorded sessions with tool calls in every settled state", () => {
		expect(corpus.length).toBeGreaterThanOrEqual(2);
		const p = new TranscriptProjector();
		for (const { events } of corpus) for (const e of events) p.apply(e);
		const titles = new Set(p.nodes().filter((n) => n.p?.role === "tern.work").map((n) => n.p?.title));
		expect([...titles].sort()).toEqual(["Done", "Failed", "Interrupted"]);
		const parallel = corpus.some(({ events }) => {
			let running = 0, max = 0;
			for (const e of events) {
				if (e.type === "tool_execution_start") max = Math.max(max, ++running);
				if (e.type === "tool_execution_end") running--;
			}
			return max >= 2;
		});
		expect(parallel).toBe(true);
	});
});

// Rebuilds the node tree from the TSP frames the bridge wrote, exactly as Tern applies them.
function applyFrames(writes: string[], all?: Map<string, TspNode & { parent: string }>): TspNode[] {
	type N = TspNode & { parent: string };
	const nodes = all ?? new Map<string, N>();
	const order: string[] = [];
	const add = (node: TspNode, parent: string, before: string | null) => {
		nodes.set(node.id, { ...node, c: undefined, parent });
		if (parent === "main") {
			const at = before === null ? -1 : order.indexOf(before);
			if (at < 0) order.push(node.id); else order.splice(at, 0, node.id);
		}
		for (const child of node.c ?? []) add(child, node.id, null);
	};
	const remove = (id: string) => {
		for (const [cid, n] of [...nodes]) if (n.parent === id) remove(cid);
		nodes.delete(id);
		const at = order.indexOf(id);
		if (at >= 0) order.splice(at, 1);
	};
	for (const w of writes) {
		if (!w.startsWith(`${ESC}_tsp;f;`)) continue;
		for (const op of (parseTspMessages(w)[0]?.body as { ops: unknown[][] }).ops) {
			if (op[0] === "add") add(op[4] as TspNode, String(op[2]), (op[3] as string | null) ?? null);
			else if (op[0] === "del") remove(String(op[1]));
			else if (op[0] === "set") { const n = nodes.get(String(op[1])); if (n) n.p = { ...n.p, ...(op[2] as Record<string, unknown>) }; }
			else if (op[0] === "move") { const id = String(op[1]); const at = order.indexOf(id); if (at >= 0) order.splice(at, 1); const b = order.indexOf(String(op[3])); if (b < 0) order.push(id); else order.splice(b, 0, id); }
		}
	}
	return order.map((id) => nodes.get(id)!).filter(Boolean);
}

function fakeSession() {
	const listeners = new Set<(e: PiEventLike) => void>();
	return {
		state: {},
		subscribe(l: (e: PiEventLike) => void) { listeners.add(l); return () => listeners.delete(l); },
		prompt: () => new Promise<void>(() => {}),
		abort: async () => {},
		dispose() {},
		sessionManager: { getSessionId: () => "replay", getEntries: () => [] },
		emit(e: PiEventLike) { for (const l of listeners) l(e); },
	} as unknown as PiSessionLike & { emit(e: PiEventLike): void };
}

describe("replay through the bridge: emitted TSP frames", () => {
	beforeEach(() => vi.useFakeTimers({ now: 1_000_000 }));
	afterEach(() => vi.useRealTimers());

	for (const { name, events } of corpus) {
		it(`${name}: the visible work rows after every event match the snapshot`, () => {
			const session = fakeSession();
			const writes: string[] = [];
			const bridge = new PiTernBridge(session, { write: (d) => writes.push(d), surfaceId: "pi", credits: 1_000_000 });
			bridge.start("pi");
			const frames: string[] = [];
			for (const e of events) {
				session.emit(e);
				const view = workView(applyFrames(writes)).join("\n");
				if (frames.at(-1) !== view) frames.push(view);
			}
			bridge.close?.();
			expect(frames).toMatchSnapshot();
		});
	}
});

// ---- Property tests -------------------------------------------------------------------------------

// Small seeded PRNG (mulberry32) so failures reproduce from the printed seed without extra dependencies.
function rng(seed: number) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const GOALS = ["fix login", "修復ログイン 🚀 テスト", "", "deploy ✅ 文字幅\nsecond line", "a".repeat(200)];

interface Generated { events: PiEventLike[]; branch: unknown[]; checkpoints: { index: number; open: boolean }[] }

// One random session: several turns, each with zero or more tool batches whose calls run in parallel and end
// in any order as ok, failed, aborted ("context canceled") or never. The persisted branch is written as Pi
// would write it for the same history, so restore can be compared with the live projection.
function generate(seed: number): Generated {
	const r = rng(seed);
	const pick = <T,>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)]!;
	const events: PiEventLike[] = [];
	const branch: unknown[] = [];
	const checkpoints: Generated["checkpoints"] = [];
	let call = 0, entry = 0;
	const turns = 1 + Math.floor(r() * 4);
	for (let t = 0; t < turns; t++) {
		const user = { role: "user", content: [{ type: "text", text: pick(GOALS) }] };
		events.push({ type: "agent_start" }, { type: "message_start", message: user }, { type: "message_end", message: user });
		branch.push({ id: `e${++entry}`, type: "message", message: user });
		checkpoints.push({ index: events.length, open: true });
		const aborted = r() < 0.3;
		const batches = Math.floor(r() * 3);
		for (let b = 0; b < batches && !(aborted && b > 0 && r() < 0.3); b++) {
			const ids = Array.from({ length: 1 + Math.floor(r() * 3) }, () => `c${++call}`);
			const assistant = { role: "assistant", content: ids.map((id) => ({ type: "toolCall", id, name: "Bash", arguments: { command: `run ${id}` } })), stopReason: "toolUse" };
			events.push({ type: "message_start", message: assistant }, { type: "message_end", message: assistant });
			branch.push({ id: `e${++entry}`, type: "message", message: assistant });
			for (const id of ids) events.push({ type: "tool_execution_start", toolCallId: id, toolName: "Bash", args: { command: `run ${id}` } });
			checkpoints.push({ index: events.length, open: true });
			const last = aborted && b === batches - 1;
			for (const id of [...ids].sort(() => r() - 0.5)) {
				const roll = r();
				if (last && roll < 0.4) continue; // aborted before Pi delivered an end
				const cancelledByAbort = last && roll < 0.8;
				const isError = cancelledByAbort || r() < 0.25;
				const text = cancelledByAbort ? "command execution error: context canceled" : isError ? "Error executing bash: Command exited with code 2: boom" : "ok";
				const details = isError && !cancelledByAbort ? { exit_code: 2, duration_ms: 5 } : { duration_ms: 5 };
				events.push({ type: "tool_execution_end", toolCallId: id, toolName: "Bash", result: { content: [{ type: "text", text }], details }, isError });
				branch.push({ id: `e${++entry}`, type: "message", message: { role: "toolResult", toolCallId: id, toolName: "Bash", isError, content: [{ type: "text", text }], details } });
				checkpoints.push({ index: events.length, open: true });
			}
		}
		const final = aborted
			? { role: "assistant", content: [], stopReason: "error", errorMessage: "This operation was aborted" }
			: { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop" };
		events.push({ type: "message_start", message: final }, { type: "message_end", message: final }, { type: "agent_end" });
		branch.push({ id: `e${++entry}`, type: "message", message: final });
		checkpoints.push({ index: events.length, open: false });
	}
	return { events, branch, checkpoints };
}

const SEEDS = Array.from({ length: 300 }, (_, i) => i + 1);

// Live projection after each prefix of events, so properties hold in every intermediate state too.
function* liveStates(events: readonly PiEventLike[]) {
	const p = new TranscriptProjector();
	for (let i = 0; i < events.length; i++) {
		p.apply(events[i]!);
		yield { index: i + 1, items: p.items.map((item) => ({ ...item })), nodes: p.nodes() };
	}
}

type ItemView = { id: string; role: string };
const toolIds = (items: readonly ItemView[]) => items.filter((i) => i.role === "tool").map((i) => i.id);

describe("turn-work properties", () => {
	it("every tool call appears in exactly one group (corpus and generated, every intermediate state)", () => {
		const sources = [...corpus.map((c) => ({ label: c.name, events: c.events })), ...SEEDS.map((s) => ({ label: `seed ${s}`, events: generate(s).events }))];
		for (const { label, events } of sources) {
			for (const { index, items, nodes } of liveStates(events)) {
				const groups = nodes.filter((n) => n.p?.role === "tern.work" || n.p?.role === "tern.work-live");
				// A live line names its group by id (g-<first call>); it has no children, so its members are the
				// turn's tool items from that call up to the next user message.
				const members = groups.flatMap((g) => {
					if (g.c) return g.c.map((c) => c.id);
					const from = items.findIndex((i) => i.id === String(g.id).slice(2));
					const out: string[] = [];
					for (let k = from; k >= 0 && k < items.length && items[k]!.role !== "user"; k++) if (items[k]!.role === "tool") out.push(items[k]!.id);
					return out;
				});
				const expected = toolIds(items);
				expect([...members].sort(), `${label} @${index}`).toEqual([...expected].sort());
				expect(new Set(members).size, `${label} @${index} duplicates`).toBe(members.length);
			}
		}
	});

	it("a running turn renders its work as one line with no tool children", () => {
		for (const seed of SEEDS) {
			const { events, checkpoints } = generate(seed);
			const states = [...liveStates(events)];
			for (const { index, open } of checkpoints) {
				if (!open) continue;
				const { items, nodes } = states[index - 1]!;
				const lastUser = items.map((i) => i.role).lastIndexOf("user");
				const turnHasTools = items.slice(lastUser + 1).some((i) => i.role === "tool");
				const live = nodes.filter((n) => n.p?.role === "tern.work-live");
				expect(live.length, `seed ${seed} @${index}`).toBe(turnHasTools ? 1 : 0);
				for (const n of live) {
					expect(n.k).toBe("text");
					expect(n.c).toBeUndefined();
					expect(n.p).toMatchObject({ wrap: "none", truncate: "end" });
					expect(String(n.p?.text)).not.toContain("\n");
				}
				// Nothing rendered after the turn's user message is a tool row.
				const after = nodes.slice(nodes.findLastIndex((n) => n.p?.role === "pi.user") + 1);
				expect(after.filter((n) => n.k === "tool"), `seed ${seed} @${index}`).toEqual([]);
			}
		}
	});

	it("a settled turn renders exactly one collapsed summary and no live line", () => {
		for (const seed of SEEDS) {
			const { events } = generate(seed);
			const p = new TranscriptProjector();
			for (const e of events) p.apply(e);
			const nodes = p.nodes();
			expect(nodes.filter((n) => n.p?.role === "tern.work-live"), `seed ${seed}`).toEqual([]);
			// Per user turn: one summary if the turn ran tools, none otherwise.
			// Tools per user turn come from the projector's items; cards per turn from the rendered nodes.
			const toolsPerTurn: number[] = [];
			for (const i of p.items) {
				if (i.role === "user") toolsPerTurn.push(0);
				else if (i.role === "tool") toolsPerTurn[toolsPerTurn.length - 1]! += 1;
			}
			let turnTools = 0, turnCards = 0, turn = -1;
			const check = () => {
				expect(turnCards, `seed ${seed} turn ${turn}`).toBe(turnTools > 0 ? 1 : 0);
				expect(turnTools, `seed ${seed} turn ${turn}`).toBe(toolsPerTurn[turn] ?? 0);
			};
			let first = true;
			for (const n of nodes) {
				if (n.p?.role === "pi.user") {
					if (!first) check();
					turn++;
					first = false; turnTools = 0; turnCards = 0;
				}
				if (n.p?.role === "tern.work") {
					turnCards++;
					turnTools += n.c?.length ?? 0;
					expect(n.p).toMatchObject({ collapsible: true, collapsed: true });
				}
			}
			check();
		}
	});

	it("restoring from the session JSONL produces the same summary text as the live run", () => {
		const cases = [
			...corpus.map((c) => ({ label: c.name, events: c.events, branch: c.branch })),
			...SEEDS.map((s) => ({ label: `seed ${s}`, ...generate(s) })),
		];
		let compared = 0;
		for (const { label, events, branch } of cases) {
			const live = new TranscriptProjector();
			for (const e of events) live.apply(e);
			const restored = new TranscriptProjector();
			restored.replaceFromSessionBranch(branch);
			const liveText = workView(live.nodes());
			expect(workView(restored.nodes()), label).toEqual(liveText);
			compared += liveText.length;
		}
		expect(compared).toBeGreaterThan(SEEDS.length);
	});
});

describe("turn line and running-work bar announce each piece of work once", () => {
	afterEach(() => removeRunningWork("bash-1"));

	it("a foreground call is only on the turn line; once backgrounded it is only in the bar", () => {
		const session = fakeSession();
		const writes: string[] = [];
		const bridge = new PiTernBridge(session, { write: (d) => writes.push(d), surfaceId: "pi", credits: 1_000_000 });
		bridge.start("pi");
		const view = () => {
			const all = new Map<string, TspNode & { parent: string }>();
			const main = applyFrames(writes, all);
			return {
				line: main.filter((n) => n.p?.role === "tern.work-live").map((n) => String(n.p?.text)),
				bar: [...all.values()].filter((n) => n.parent === "background-work").map((n) => n.id),
			};
		};
		session.emit({ type: "agent_start" });
		session.emit({ type: "message_start", message: { role: "user", content: [{ type: "text", text: "build" }] } });
		session.emit({ type: "tool_execution_start", toolCallId: "c1", toolName: "Bash", args: { command: "make" } });
		// Bash registers foreground work in the shared store as it starts (swarm-bgprocess.ts).
		setRunningWork({ id: "bash-1", kind: "bash", label: "make", status: "running", startedAt: Date.now(), detail: "", foreground: true });
		expect(view()).toEqual({ line: ["1 running · build"], bar: [] });

		// Ctrl+B / auto-background: the call returns, so the turn line no longer counts it, and the bar shows it.
		patchRunningWork("bash-1", { foreground: false });
		session.emit({ type: "tool_execution_end", toolCallId: "c1", toolName: "Bash", result: { content: [{ type: "text", text: "moved to background" }] }, isError: false });
		expect(view()).toEqual({ line: ["working · build"], bar: ["bg-work-bash-1"] });
		bridge.close?.();
	});
});

describe("expansion", () => {
	it("ctrl+o (outputExpanded) unfolds settled summaries and their steps; a running turn stays one line", () => {
		const { events } = corpus.find((c) => c.name.startsWith("2026-10-18T19-29"))!;
		const p = new TranscriptProjector();
		for (const e of events) p.apply(e);
		const folded = p.nodes(false).filter((n) => n.p?.role === "tern.work");
		const open = p.nodes(true).filter((n) => n.p?.role === "tern.work");
		expect(folded.every((n) => n.p?.collapsed === true)).toBe(true);
		expect(open.every((n) => n.p?.collapsed === false)).toBe(true);
		// Expansion changes nothing but the fold: the same groups, titles, and steps.
		expect(open.map((n) => [n.id, n.p?.title, n.c?.map((c) => c.id)])).toEqual(folded.map((n) => [n.id, n.p?.title, n.c?.map((c) => c.id)]));

		const running = new TranscriptProjector();
		running.apply({ type: "agent_start" });
		running.apply({ type: "message_start", message: { role: "user", content: [{ type: "text", text: "go" }] } });
		running.apply({ type: "tool_execution_start", toolCallId: "a", toolName: "bash", args: { command: "x" } });
		expect(running.nodes(true).filter((n) => n.p?.role === "tern.work-live").map((n) => [n.k, n.c])).toEqual([["text", undefined]]);
	});
});
