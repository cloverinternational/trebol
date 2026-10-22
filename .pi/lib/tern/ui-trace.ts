/**
 * Dogfooding trace for the Tern transcript. Each line of `<dir>/<stamp>.ui.jsonl` is one of:
 *   {k:"ev", at, type, …ids}       a Pi event, reduced to type and identifiers (never payload text)
 *   {k:"frame", at, seq, trigger, busy, rows}   what the main region shows after a render, written only when it changed
 * `rows` is one entry per top-level transcript node: [id, role, state, text], text cut to 80 characters.
 * findFlicker() reads frames back and reports rows that vanish, reappear, or change state and change back.
 */
import { appendFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { TspNode } from "./tsp.ts";

export type TraceRow = [id: string, role: string, state: string, text: string];
export interface TraceFrame { k: "frame"; at: number; seq: number; trigger: string; busy: boolean; rows: TraceRow[] }

const cut = (s: string) => (s.length > 80 ? `${s.slice(0, 79)}…` : s).replace(/\s+/g, " ");

export function traceRows(nodes: readonly TspNode[]): TraceRow[] {
	return nodes.filter((n) => !String(n.id).startsWith("startup")).map((n) => {
		const p = n.p ?? {};
		const role = String(p.role ?? n.k);
		const state = role === "tern.work-live" ? (n.k === "tool" ? "open" : "line") : role === "tern.work" ? `${String(p.title)} ${((p.meta as string[] | undefined) ?? []).join(" · ")}` : String(p.status ?? "");
		const text = String(p.text ?? p.target ?? n.c?.[0]?.p?.text ?? "");
		return [String(n.id), role, state, cut(text)];
	});
}

function eventIds(event: { type: string; [k: string]: unknown }): Record<string, unknown> {
	const m = event.message as { role?: unknown; customType?: unknown; display?: unknown; stopReason?: unknown } | undefined;
	const d = event.assistantMessageEvent as { type?: unknown } | undefined;
	return {
		type: event.type,
		...(typeof event.toolCallId === "string" ? { call: event.toolCallId.slice(-8), tool: event.toolName } : {}),
		...(event.type === "tool_execution_end" ? { isError: event.isError } : {}),
		...(m ? { role: m.role, ...(m.customType ? { custom: m.customType, display: m.display } : {}), ...(m.stopReason ? { stop: m.stopReason } : {}) } : {}),
		...(d?.type ? { delta: d.type } : {}),
	};
}

/** Off with PI_TERN_UI_TRACE=0. Keeps the newest 20 traces in the directory. */
export function createUiTrace(dir: string, now: () => number = Date.now) {
	let file: string | undefined;
	try {
		mkdirSync(dir, { recursive: true });
		const old = readdirSync(dir).filter((f) => f.endsWith(".ui.jsonl")).sort();
		for (const f of old.slice(0, Math.max(0, old.length - 19))) rmSync(join(dir, f), { force: true });
		file = join(dir, `${new Date(now()).toISOString().replace(/[:.]/g, "-")}-${process.pid}.ui.jsonl`);
	} catch {
		file = undefined;
	}
	let last = "";
	let seq = 0;
	const write = (line: object) => {
		if (!file) return;
		try { appendFileSync(file, `${JSON.stringify(line)}\n`); } catch { file = undefined; }
	};
	return {
		get file() { return file; },
		event(event: { type: string; [k: string]: unknown }): void {
			// Text deltas are the bulk of the stream; one line per delta kind change is enough to place renders.
			if (event.type === "message_update" && (event.assistantMessageEvent as { type?: unknown } | undefined)?.type === "text_delta") return;
			write({ k: "ev", at: now(), ...eventIds(event) });
		},
		render(nodes: readonly TspNode[], trigger: string, busy: boolean): void {
			const rows = traceRows(nodes);
			const key = JSON.stringify([busy, rows]);
			if (key === last) return;
			last = key;
			write({ k: "frame", at: now(), seq: ++seq, trigger, busy, rows } satisfies TraceFrame);
		},
	};
}

export interface Flicker { kind: "vanished" | "reappeared" | "state-flip" | "settled-while-busy"; id: string; role: string; at: number; detail: string }

/**
 * A row flickers when, while the agent is busy, it disappears (vanished; a live line only when new work replaces it), comes back after disappearing
 * (reappeared), returns to an earlier state (state-flip), or a work card shows a settled title (settled-while-busy).
 * A frame with no rows (session switch or reload) resets history.
 */
export function findFlicker(frames: readonly TraceFrame[]): Flicker[] {
	const out: Flicker[] = [];
	const history = new Map<string, string[]>();
	const gone = new Set<string>();
	let prev: Map<string, TraceRow> = new Map();
	let startsAtIdle = 0;
	for (const f of frames) {
		const cur = new Map(f.rows.map((r) => [r[0], r]));
		if (cur.size === 0 || f.trigger === "session_tree" || f.trigger === "rebind") { history.clear(); gone.clear(); prev = cur; continue; }
		for (const [id, row] of prev) {
			// A live line (or its streaming tail) handing over to the turn's reply is its one intended exit; it flickers only when other
			// work replaces it (a new id for the same work) while the turn still runs.
			const replaced = (row[1] !== "tern.work-live" && row[1] !== "tern.work-tail") || f.rows.some((r) => !prev.has(r[0]) && (r[1] === "tern.work-live" || r[1] === "tern.work"));
			if (!cur.has(id) && f.busy && replaced) { out.push({ kind: "vanished", id, role: row[1], at: f.at, detail: `${row[1]} "${row[3]}" after ${f.trigger}` }); gone.add(id); }
		}
		for (const [id, row] of cur) {
			if (gone.has(id) && !prev.has(id)) { out.push({ kind: "reappeared", id, role: row[1], at: f.at, detail: `${row[1]} after ${f.trigger}` }); gone.delete(id); }
			const states = history.get(id) ?? [];
			const state = `${row[1]}|${row[2]}`;
			if (states.at(-1) !== state) {
				if (states.includes(state) && f.busy) out.push({ kind: "state-flip", id, role: row[1], at: f.at, detail: `${states.at(-1)} -> ${state} after ${f.trigger}` });
				states.push(state);
				history.set(id, states);
			}
		}
		// The running turn is everything after the last user row or notice; its work must be the live line.
		// Until the run's own user row arrives (just after agent_start), the last turn shown is the previous one.
		const starts = f.rows.filter((r) => r[1] === "pi.user" || r[1] === "tern.notice").length;
		if (!f.busy) startsAtIdle = starts;
		if (f.busy && starts > startsAtIdle) {
			const lastStart = f.rows.findLastIndex((r) => r[1] === "pi.user" || r[1] === "tern.notice");
			for (const row of f.rows.slice(lastStart + 1)) {
				if (row[1] === "tern.work") out.push({ kind: "settled-while-busy", id: row[0], role: row[1], at: f.at, detail: `${row[2]} after ${f.trigger}` });
			}
		}
		prev = cur;
	}
	const seen = new Set<string>();
	return out.filter((x) => { const k = `${x.kind}|${x.id}|${x.detail}`; if (seen.has(k)) return false; seen.add(k); return true; });
}
