import type { RunningWorkItem } from "../ui/running-work-store.ts";
import { DraftEditor, type HostEdit } from "./draft-edit.ts";
import type { KeyEffect } from "./keys.ts";
import type { TspNode } from "./tsp.ts";
import { formatBackgroundOutput, readAgentTimeline, safeWorkText, type AgentTimeline } from "./background-format.ts";

const n = (id: string, k: string, p: Record<string, unknown>, c?: TspNode[]): TspNode => ({ id, k, p, ...(c ? { c } : {}) });
const button = (id: string, text: string, click: string, disabled = false) => n(id, "button", { text, size: "sm", variant: "quiet", disabled, actions: { click } });
const live = (i: RunningWorkItem) => i.status === "running" || i.status === "queued";
const label = (s: string) => safeWorkText(s.slice(0, 500)).replace(/\s+/g, " ");
interface Snapshot { output: string; timeline?: AgentTimeline; error?: boolean }

export class BackgroundPanel {
	selected?: string;
	filter: "all" | "bash" | "subagent" = "all";
	mode: "formatted" | "raw" = "formatted";
	follow = true;
	search = new DraftEditor();
	stopping = new Set<string>();
	stopError?: string;
	#snapshot?: Snapshot;
	#snapshotId?: string;
	select(id: string | undefined): void { this.selected = id; this.follow = true; this.#snapshot = undefined; this.#snapshotId = undefined; }
	rows(items: RunningWorkItem[]): RunningWorkItem[] { return items.filter((i) => (this.filter === "all" || i.kind === this.filter) && label(`${i.label} ${i.detail} ${i.status}`).toLowerCase().includes(this.search.text.toLowerCase())); }
	capture(item: RunningWorkItem): Snapshot {
		if (!this.follow && this.#snapshot && this.#snapshotId === item.id) return this.#snapshot;
		let output = item.output ?? ""; let error = false;
		try { if (live(item)) output = item.readOutput?.() ?? output; } catch { error = true; }
		this.#snapshotId = item.id;
		// Do not retain an unbounded process buffer merely because viewing is paused.
		if (output.length > 65536) output = `… earlier captured output omitted …\n${output.slice(-65536)}`;
		return this.#snapshot = { output, error, ...(item.kind === "subagent" && item.transcriptPath ? { timeline: readAgentTimeline(item.transcriptPath) } : {}) };
	}
	key(effect: KeyEffect, items: RunningWorkItem[]): void {
		const e = this.search;
		switch (effect.kind) {
			case "text": e.insert(effect.text); break;
			case "backspace": e.backspace(); break;
			case "deleteWord": e.deleteWordBackward(); break;
			case "deleteForward": e.deleteForward({ word: effect.word }); break;
			case "deleteToEdge": e.deleteToEdge(effect.direction); break;
			case "selectAll": e.selectAll(); break;
			case "undo": e.undo(); break;
			case "cursor": e.move(effect.direction, { word: effect.word, extend: effect.extend, line: effect.line }); break;
			case "tabMove": e.move(effect.delta < 0 ? -1 : 1); break;
			case "tab": this.mode = this.mode === "raw" ? "formatted" : "raw"; break;
			case "up": case "down": { const rows = this.rows(items); const i = Math.max(0, rows.findIndex((r) => r.id === this.selected)); this.select(rows[Math.max(0, Math.min(rows.length - 1, i + (effect.kind === "up" ? -1 : 1)))]?.id); break; }
		}
	}
	event(b: Record<string, unknown>): void {
		if (b.ev === "edit" && b.id === "bg-search") this.search.applyHostEdit(b as unknown as HostEdit);
		if (b.ev === "undo" && b.id === "bg-search") this.search.undo();
		if (b.ev === "select" || b.ev === "activate") {
			if (b.id === "bg-list" && typeof b.item === "string") this.select(b.item);
			if (b.id === "bg-filter" && ["all", "bash", "subagent"].includes(String(b.item))) this.filter = b.item as typeof this.filter;
			if (b.id === "bg-mode" && ["formatted", "raw"].includes(String(b.item))) this.mode = b.item as typeof this.mode;
		}
		if (b.ev === "action" && b.act === "bg.follow") this.follow = !this.follow;
	}
	nodes(items: RunningWorkItem[], columns: number): TspNode[] {
		const rows = this.rows(items);
		for (const id of this.stopping) if (!items.some((i) => i.id === id && live(i))) this.stopping.delete(id);
		if (!this.selected) this.selected = rows[0]?.id;
		const item = items.find((i) => i.id === this.selected);
		if (item && !live(item)) this.stopping.delete(item.id);
		const snapshot = item ? this.capture(item) : undefined;
		const body: TspNode[] = [];
		if (!item) body.push(n("bg-output-gone", "empty", { title: this.selected ? "This work is no longer tracked" : "No background work", description: "Select another item. Completed work follows the runtime's existing retention policy." }));
		else {
			body.push(n("bg-output-detail", "text", { text: label(item.detail), tone: "muted" }));
			body.push(n("bg-facts", "stats", { items: [{ label: "State", value: item.status }, { label: "Kind", value: item.kind === "bash" ? "Command" : "Agent" }, ...(item.tokens !== undefined ? [{ label: "Tokens reported", value: String(item.tokens) }] : [])] }));
			body.push(live(item) ? n("bg-duration", "elapsed", { age: Math.max(0, Date.now() - item.startedAt) }) : n("bg-duration", "text", { text: item.endedAt === undefined ? "Duration unavailable" : `Duration · ${Math.max(0, (item.endedAt - item.startedAt) / 1000).toFixed(1)} s`, tone: "muted" }));
			body.push(n("bg-mode", "tabs", { active: this.mode, items: [{ id: "formatted", label: item.kind === "subagent" ? "Conversation" : "Formatted" }, { id: "raw", label: "Raw text" }] }));
			if (snapshot?.error || snapshot?.timeline?.unavailable) body.push(n("bg-read-error", "text", { text: "Live source unavailable. Showing any captured output below.", tone: "warning" }));
			if (snapshot?.timeline?.truncated) body.push(n("bg-history-truncated", "text", { text: "Bounded recent transcript window; earlier entries omitted.", tone: "muted" }));
			const content: TspNode[] = [];
			if (item.kind === "subagent" && snapshot?.timeline?.steps.length) {
				for (const step of snapshot.timeline.steps) {
					const id = `bg-message-${item.id}-${step.id}`;
					if (this.mode === "raw") content.push(n(id, "code", { text: `${step.title}\n${step.text}`, wrap: true }));
					else if (step.role === "tool") content.push(n(id, "card", { head: step.title, tone: step.error ? "error" : "neutral", collapsible: true }, outputNodes(`${id}-body`, step.text, false)));
					else content.push(n(id, "message", { author: step.title, role: step.role }, [n(`${id}-text`, "md", { text: step.text })]));
				}
			} else content.push(...outputNodes("bg-output-text", snapshot?.output ?? "", this.mode === "raw"));
			body.push(n("bg-output-scroll", "scroll", { max: { h: "26lines" }, ...(this.follow ? { stick: "end" } : {}) }, content));
		}
		if (this.stopError) body.push(n("bg-stop-error", "text", { text: this.stopError, tone: "error" }));
		if (item && this.stopping.has(item.id)) body.push(n("bg-stop-pending", "text", { text: "Stop requested; awaiting runtime settlement.", tone: "warning" }));
		return [n("bg-output", "overlay", { head: item ? `${label(item.label)} · ${item.status}` : "Background work", meta: "Work manager", size: "lg", modal: true, role: "pi.background.output", end: "bg-output-controls", foot: "bg-footer" }, [
			n("bg-output-controls", "row", { gap: "sm" }, [button("bg-follow", this.follow ? "Pause viewing" : "Follow live", "bg.follow"), ...(item && live(item) && item.stop ? [button("bg-output-stop", "Stop", `bg.stop=${item.id}`, this.stopping.has(item.id))] : []), button("bg-output-close", "Close", "bg.close")]),
			n("bg-search", "input", { text: this.search.text, cursor: this.search.cursor, anchor: this.search.anchor, placeholder: "Find commands or agents…", icon: "search", aria: "Search background work" }),
			n("bg-filter", "tabs", { active: this.filter, variant: "segmented", items: [{ id: "all", label: "All" }, { id: "bash", label: "Commands" }, { id: "subagent", label: "Agents" }] }),
			n("bg-layout", columns < 100 ? "col" : "row", { gap: "lg", align: "stretch" }, [
				n("bg-list-scroll", "scroll", { basis: 0, grow: 1, max: { h: "18lines" } }, [n("bg-list", "table", { selectable: true, selected: this.selected, empty: "No matching work", cols: [{ id: "name", head: "Work", grow: 1, priority: 10 }], rows: rows.map((i) => ({ id: i.id, cells: { name: [{ t: label(i.label) }, { t: ` · ${i.status}`, s: i.status === "failed" ? "error" : "muted" }] } })) })]),
				n("bg-detail", "col", { basis: 0, grow: 2, gap: "sm" }, body),
			]),
			n("bg-footer", "text", { text: `${this.follow ? "Following live output" : "Viewing paused snapshot — work continues"} · Esc Close · ↑↓ Select · Tab View`, tone: "muted" }),
		])];
	}
}

function outputNodes(id: string, output: string, raw: boolean): TspNode[] {
	if (!output) return [n(id, "empty", { title: "No output captured yet", description: "Output appears as the runtime publishes it." })];
	const parsed = formatBackgroundOutput(output);
	return [
		...(parsed.note ? [n(`${id}-note`, "text", { text: parsed.note, tone: "warning" })] : []),
		...(!raw && parsed.diagnostics.length ? [n(`${id}-diagnostics`, "badge", { text: `${parsed.diagnostics.length} diagnostic line(s) in visible output`, tone: parsed.diagnostics.some((d) => d.tone === "error") ? "error" : "warning", title: parsed.diagnostics.map((d) => d.text).join("\n") })] : []),
		n(id, !raw && parsed.kind === "ansi" ? "ansi" : "code", { text: raw ? parsed.raw : parsed.text, wrap: true, ...(!raw && parsed.kind === "json" ? { lang: "json" } : {}) }),
	];
}
