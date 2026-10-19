// Turn-work UI: replay of real recorded Pi sessions and the four turn-grouping properties.
// Corpus: .pi/test/tern/fixtures/turn-work/*.events.jsonl were recorded from a live Tern window with
// PI_TERN_EVENT_LOG (see .pi/test/tern/live/extract-corpus.py); *.session.jsonl is Pi's persisted branch
// for the same session. No event in the corpus is hand-written.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PiTernBridge, TranscriptProjector, type PiEventLike, type PiSessionLike } from "../../lib/tern/bridge.ts";
import { ESC, parseTspMessages, type TspNode } from "../../lib/tern/tsp.ts";
import { isTurnBoundary, summaryText } from "../../lib/tern/turn-groups.ts";
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
const cardLine = (n: TspNode) => [cardText(n), ...((n.p?.meta as string[] | undefined) ?? []).slice(1)].join(" · ");
const workView = (nodes: readonly TspNode[]) => nodes.flatMap((n) =>
	n.p?.role === "tern.work-live" ? [`LIVE ${String(n.p.text)}`] : n.p?.role === "tern.work" ? [`SUMMARY ${cardLine(n)}`] : []);

describe("replay corpus", () => {
	it("is built from real recorded sessions with tool calls in every settled state", () => {
		expect(corpus.length).toBeGreaterThanOrEqual(2);
		const p = new TranscriptProjector();
		for (const { events } of corpus) for (const e of events) p.apply(e);
		const cards = p.nodes().filter((n) => n.p?.role === "tern.work");
		expect([...new Set(cards.map((n) => n.p?.title))].sort()).toEqual(["Done", "Interrupted"]);
		// A real step failure the agent recovered from: the turn reads Done and counts the failed step.
		expect(cards.some((n) => n.p?.title === "Done" && (n.p?.meta as string[]).some((m) => / failed$/.test(m)))).toBe(true);
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

	it("a recorded background-agent run: one notice line, the wakeup's work in its own card, no narration outside", () => {
		const run = corpus.find((c) => c.events.some((e) => (e.message as { customType?: string } | undefined)?.customType === "swarm-agent-complete"));
		expect(run, "corpus holds a real swarm-agent-complete wakeup").toBeDefined();
		const live = new TranscriptProjector();
		for (const e of run!.events) live.apply(e);
		const restored = new TranscriptProjector();
		restored.replaceFromSessionBranch(run!.branch);
		for (const nodes of [live.nodes(), restored.nodes()]) {
			const roles = nodes.map((n) => String(n.p?.role ?? n.k));
			const notice = roles.indexOf("tern.notice");
			expect(notice).toBeGreaterThan(-1);
			expect(nodes[notice]!.p).toMatchObject({ wrap: "none", truncate: "end" });
			expect(String(nodes[notice]!.p?.text)).toMatch(/^\[agent completed\] id=subagent-\S+ status=failed$/);
			// The user turn: its card, then its final answer; the wakeup turn: its card, then its answer.
			expect(roles.slice(roles.lastIndexOf("pi.user"))).toEqual(["pi.user", "tern.work", "pi.assistant", "tern.notice", "tern.work", "pi.assistant"]);
			const cards = nodes.filter((n) => n.p?.role === "tern.work");
			expect(cards.at(-2)!.c!.filter((c) => c.k !== "md").map((c) => c.p?.name)).toEqual(["TaskManage", "Subagent", "Subagent"]);
		}
		expect(workView(restored.nodes())).toEqual(workView(live.nodes()));
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
		// A turn starts from the user or from a visible custom message (goal/monitor/schedule wakeup).
		const fromNotice = t > 0 && r() < 0.25;
		const user = fromNotice
			? { role: "custom", customType: "swarm-goal", display: true, content: `Work toward this goal: ${pick(GOALS)}` }
			: { role: "user", content: [{ type: "text", text: pick(GOALS) }] };
		events.push({ type: "agent_start" }, { type: "message_start", message: user }, { type: "message_end", message: user });
		branch.push(fromNotice ? { id: `e${++entry}`, type: "custom_message", customType: "swarm-goal", display: true, content: user.content } : { id: `e${++entry}`, type: "message", message: user });
		checkpoints.push({ index: events.length, open: true });
		const aborted = r() < 0.3;
		const batches = Math.floor(r() * 3);
		for (let b = 0; b < batches && !(aborted && b > 0 && r() < 0.3); b++) {
			const ids = Array.from({ length: 1 + Math.floor(r() * 3) }, () => `c${++call}`);
			// Hidden hook context and narration before the calls: neither may show outside the work fold.
			if (r() < 0.3) {
				const hidden = { role: "custom", customType: "swarm-hook-context", display: false, content: "<system-reminder>nudge</system-reminder>" };
				events.push({ type: "message_start", message: hidden }, { type: "message_end", message: hidden });
				branch.push({ id: `e${++entry}`, type: "custom_message", customType: "swarm-hook-context", display: false, content: hidden.content });
			}
			const narration = r() < 0.5 ? [{ type: "text", text: `checking ${call}` }] : [];
			const assistant = { role: "assistant", content: [...narration, ...ids.map((id) => ({ type: "toolCall", id, name: "Bash", arguments: { command: `run ${id}` } }))], stopReason: "toolUse" };
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
		const providerFailed = !aborted && r() < 0.15;
		const final = aborted
			? { role: "assistant", content: [], stopReason: "error", errorMessage: "This operation was aborted" }
			: providerFailed
				? { role: "assistant", content: [], stopReason: "error", errorMessage: "529 overloaded" }
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
// A rendered turn start: the user's message, or a visible custom notice (one tern.notice line).
const isBoundaryNode = (n: TspNode) => n.p?.role === "pi.user" || n.p?.role === "tern.notice";
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
					if (g.c) return g.c.filter((c) => c.k !== "md").map((c) => c.id.replace(/-group$/, ""));
					const from = items.findIndex((i) => i.id === String(g.id).slice(2));
					const out: string[] = [];
					for (let k = from; k >= 0 && k < items.length && (k === from || !isTurnBoundary(items[k]!)); k++) if (items[k]!.role === "tool") out.push(items[k]!.id);
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
				const lastUser = items.findLastIndex((i) => isTurnBoundary(i));
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
				const after = nodes.slice(nodes.findLastIndex(isBoundaryNode) + 1);
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
				if (isTurnBoundary(i)) toolsPerTurn.push(0);
				else if (i.role === "tool") toolsPerTurn[toolsPerTurn.length - 1]! += 1;
			}
			let turnTools = 0, turnCards = 0, turn = -1;
			const check = () => {
				expect(turnCards, `seed ${seed} turn ${turn}`).toBe(turnTools > 0 ? 1 : 0);
				expect(turnTools, `seed ${seed} turn ${turn}`).toBe(toolsPerTurn[turn] ?? 0);
			};
			let first = true;
			for (const n of nodes) {
				if (isBoundaryNode(n)) {
					if (!first) check();
					turn++;
					first = false; turnTools = 0; turnCards = 0;
				}
				if (n.p?.role === "tern.work") {
					turnCards++;
					turnTools += (n.c ?? []).filter((c) => c.k !== "md").length;
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

	it("nothing written mid-turn spills outside its work, live or restored, and Failed means the turn failed", () => {
		// The streaming tail under a running turn's line is part of its work, not a transcript row.
		const top = (nodes: readonly TspNode[]) => nodes.filter((n) => n.p?.role !== "tern.work" && n.p?.role !== "tern.work-live" && n.p?.role !== "tern.work-tail")
			.map((n) => `${String(n.p?.role ?? n.k)} ${String(n.c?.[0]?.p?.text ?? n.p?.text ?? "")}`);
		let narrated = 0, failedTurns = 0, recovered = 0;
		for (const seed of SEEDS) {
			const { events, branch } = generate(seed);
			for (const { index, nodes } of liveStates(events)) {
				for (const line of top(nodes)) {
					expect(line, `seed ${seed} @${index}`).not.toMatch(/system-reminder|checking \d/);
				}
			}
			const live = new TranscriptProjector();
			for (const e of events) live.apply(e);
			const restored = new TranscriptProjector();
			restored.replaceFromSessionBranch(branch);
			expect(top(restored.nodes()), `seed ${seed}`).toEqual(top(live.nodes()));
			// Each turn's outcome comes from how the turn ended, never from one step's error.
			const outcomes = events.filter((e) => e.type === "message_end" && (e.message as { role?: string }).role === "assistant" && (e.message as { stopReason?: string }).stopReason !== "toolUse");
			const cards = live.nodes().filter((n) => n.p?.role === "tern.work");
			const turnsWithWork = cards.length;
			expect(cards.filter((n) => n.p?.title === "Failed").length).toBeLessThanOrEqual(outcomes.filter((e) => (e.message as { errorMessage?: string }).errorMessage === "529 overloaded").length);
			for (const c of cards) {
				if (c.p?.title === "Failed") failedTurns++;
				if (c.p?.title === "Done" && (c.p?.meta as string[]).length > 1) recovered++;
				narrated += (c.c ?? []).filter((x) => x.k === "md").length;
			}
			expect(turnsWithWork).toBeLessThanOrEqual(outcomes.length);
		}
		expect({ narrated: narrated > 0, failedTurns: failedTurns > 0, recovered: recovered > 0 }).toEqual({ narrated: true, failedTurns: true, recovered: true });
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
	it("ctrl+o (outputExpanded) unfolds settled summaries and their steps, and opens a running turn in place", () => {
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
		running.apply({ type: "message_start", message: { role: "assistant", content: [] } });
		running.apply({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Now checking the\nbuild log" } });
		// Folded: one line plus the streaming tail (the last line written so far); no steps.
		expect(running.nodes(false).slice(1).map((n) => [n.k, n.p?.role, n.p?.text, n.c])).toEqual([
			["text", "tern.work-live", "1 running · go", undefined],
			["text", "tern.work-tail", "build log", undefined],
		]);
		// Unfolded: the same id as an open running card with the step and the narration streaming inside; no tail.
		const open2 = running.nodes(true).slice(1);
		expect(open2.map((n) => [n.id, n.k, n.p?.role, n.p?.status, n.p?.collapsed])).toEqual([[running.nodes(false)[1]!.id, "tool", "tern.work-live", "running", false]]);
		expect(open2[0]!.c?.map((c) => [c.k, c.p?.role ?? c.p?.name, c.p?.text ?? c.p?.status])).toEqual([["tool", "omp.tool.bash", "running"], ["md", "tern.work-note", "Now checking the\nbuild log"]]);
		running.apply({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: " now" } });
		expect(running.nodes(false).at(-1)?.p?.text).toBe("build log now");
		// Settling keeps the id: the open card becomes the Done card.
		running.apply({ type: "tool_execution_end", toolCallId: "a", toolName: "bash", result: { content: [] }, isError: false });
		running.apply({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Now checking the\nbuild log now" }], stopReason: "stop" } });
		running.apply({ type: "agent_end" });
		const settled = running.nodes(true).filter((n) => n.p?.role === "tern.work");
		expect(settled.map((n) => [n.id, n.p?.title])).toEqual([[open2[0]!.id, "Done"]]);
		expect(running.nodes(false).some((n) => n.p?.role === "tern.work-tail")).toBe(false);
	});
});
