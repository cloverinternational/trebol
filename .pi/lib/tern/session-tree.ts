// The /tree modal's model: Pi's session tree flattened and filtered the way Pi's own tree selector does
// (node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/tree-selector.js), then shaped
// as a Tern `picker`. Measured on real sessions, ~90% of entries are `custom` hook state and a session is one
// linear chain of ~1k entries with forks in under 1 in 10 sessions, so the view leads with turns, only indents at a
// fork, keeps the active path first and marked, and shows bookkeeping only under "All".
import type { TspNode } from "./tsp.ts";

export type TreeFilter = "default" | "no-tools" | "user" | "labeled" | "all";
// Ids are Pi's filter modes. The default view is Pi's "no-tools": on real sessions Pi's own default still shows
// 240-1500 rows, mostly tool output, against 30-600 without tools. "Labeled" appears only when a label exists, which
// keeps the tab row within Tern's 4-tab segmented control.
export const TREE_FILTERS: readonly { id: TreeFilter; label: string }[] = [
	{ id: "no-tools", label: "Conversation" },
	{ id: "user", label: "Prompts" },
	{ id: "default", label: "With tools" },
	{ id: "labeled", label: "Labeled" },
	{ id: "all", label: "All" },
];
export const DEFAULT_TREE_FILTER: TreeFilter = "no-tools";
export const SESSION_TREE_PICKER_ID = "session-tree-picker";

type Kind = "user" | "assistant" | "tool" | "notice" | "meta";
export interface TreeRow {
	id: string;
	kind: Kind;
	/** Indent: only grows at a fork, as in Pi's selector. */
	depth: number;
	text: string;
	title: string;
	timestamp?: string;
	label?: string;
	onActivePath: boolean;
	/** Children count when this entry is a fork point. */
	forks: number;
	/** Bookkeeping entry (hook state, model/thinking changes, labels, session info, context edits). */
	settings: boolean;
	/** Assistant message with only tool calls (no text, no error): shown only under "All". */
	toolOnly: boolean;
	/** Navigating here reopens the text in the composer and moves the leaf to the parent (agent-session.js navigateTree). */
	rewinds: boolean;
	badges: { text: string; tone?: string; title?: string }[];
	/** Full text for the preview pane. */
	body: string;
	/** Hook-state payload, stringified only when previewed (it dominates session size). */
	data?: unknown;
	facts: { k: string; v: string }[];
}
export interface TreeModel { rows: TreeRow[]; leafId?: string; forkCount: number; turnCount: number }

interface RawNode { entry?: Record<string, unknown>; children?: unknown; label?: unknown }
const SETTINGS = new Set(["label", "context_edit", "custom", "model_change", "thinking_level_change", "session_info"]);

function partsText(content: unknown, type = "text"): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((p) => (p && typeof p === "object" && (p as { type?: unknown }).type === type ? String((p as Record<string, unknown>)[type === "thinking" ? "thinking" : "text"] ?? "") : "")).join("");
}
const oneLine = (text: string, max = 160): string => {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};
// A row reads like prose: markdown headings give way to the first line of body text (replies here often open
// with a "# Mode: …" heading), and emphasis, code ticks, quotes and bullets lose their markers.
export function summarize(text: string, max = 160): string {
	const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
	const body = lines.filter((l) => !/^#{1,6}\s/.test(l) && !/^(```|---+$|\|)/.test(l));
	const pick = (body.length ? body : lines).join(" ");
	return oneLine(pick.replace(/^#{1,6}\s+/gm, "").replace(/(\*\*|__|`+)/g, "").replace(/(^|\s)[>*-]\s+/g, "$1").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1"), max);
}
function toolCalls(content: unknown): { name: string; args: unknown }[] {
	if (!Array.isArray(content)) return [];
	return content.filter((p) => p && typeof p === "object" && (p as { type?: unknown }).type === "toolCall").map((p) => ({ name: String((p as { name?: unknown }).name ?? "tool"), args: (p as { arguments?: unknown }).arguments }));
}
function argHint(args: unknown): string {
	if (!args || typeof args !== "object") return "";
	const a = args as Record<string, unknown>;
	const v = a.command ?? a.path ?? a.file_path ?? a.pattern ?? a.query ?? a.url ?? a.prompt ?? a.task;
	return typeof v === "string" ? oneLine(v, 80) : "";
}

// Text and badges for one entry, in Pi's vocabulary (tree-selector.js getEntryDisplay / renderEntry).
function describe(entry: Record<string, unknown>, label: string | undefined): Pick<TreeRow, "kind" | "text" | "title" | "badges" | "body" | "data" | "facts" | "toolOnly"> & { hidden?: boolean } {
	const type = String(entry.type ?? "entry");
	const badges: TreeRow["badges"] = [];
	const facts: TreeRow["facts"] = [];
	if (label) badges.push({ text: label, tone: "accent", title: "Label" });
	if (type === "message") {
		const m = (entry.message ?? {}) as Record<string, unknown>;
		const role = String(m.role ?? "");
		if (role === "user") {
			const text = partsText(m.content);
			const images = Array.isArray(m.content) ? m.content.filter((p) => (p as { type?: unknown })?.type === "image").length : 0;
			if (images) badges.push({ text: `${images} image${images > 1 ? "s" : ""}`, tone: "info" });
			return { kind: "user", text: summarize(text) || "(empty prompt)", title: "You", badges, body: text, facts, toolOnly: false };
		}
		if (role === "assistant") {
			const text = partsText(m.content);
			const calls = toolCalls(m.content);
			const stop = typeof m.stopReason === "string" ? m.stopReason : undefined;
			if (stop === "error") badges.push({ text: "error", tone: "error", title: typeof m.errorMessage === "string" ? m.errorMessage : undefined });
			else if (stop === "aborted") badges.push({ text: "stopped", tone: "warning" });
			if (calls.length) badges.push({ text: calls.length === 1 ? calls[0]!.name : `${calls.length} tools`, tone: "muted", title: calls.map((c) => c.name).join(", ") });
			if (typeof m.model === "string") facts.push({ k: "Model", v: m.model });
			const usage = m.usage as { totalTokens?: unknown } | undefined;
			if (typeof usage?.totalTokens === "number") facts.push({ k: "Tokens", v: usage.totalTokens.toLocaleString("en-US") });
			const summary = text.trim() ? summarize(text) : calls.length ? calls.map((c) => [c.name, argHint(c.args)].filter(Boolean).join(" ")).join(" · ") : typeof m.errorMessage === "string" ? m.errorMessage : "(no text)";
			const body = text.trim() ? text : calls.map((c) => `${c.name} ${argHint(c.args)}`.trim()).join("\n");
			return { kind: "assistant", text: oneLine(summary), title: "Pi", badges, body, facts, toolOnly: !text.trim() && stop !== "error" && stop !== "aborted" };
		}
		if (role === "toolResult") {
			const text = partsText(m.content);
			const name = typeof m.toolName === "string" ? m.toolName : "tool";
			if (m.isError === true) badges.push({ text: "failed", tone: "error" });
			return { kind: "tool", text: oneLine(text) || "(no output)", title: name, badges, body: text, facts, toolOnly: false };
		}
		const text = partsText(m.content);
		// 70 of these in 50 real sessions, all role "system" with no content: bookkeeping, not conversation.
		return { kind: "notice", text: summarize(text) || role, title: role || "message", badges, body: text, facts, toolOnly: false, hidden: !text.trim() };
	}
	if (type === "custom_message") {
		const text = partsText(entry.content);
		// display:false is hook context the transcript never shows (240 of 350 in real sessions).
		return { kind: "notice", text: summarize(text) || String(entry.customType ?? ""), title: String(entry.customType ?? "notice"), badges, body: text, facts, toolOnly: false, hidden: entry.display === false };
	}
	if (type === "compaction" || type === "branch_summary") {
		const summary = typeof entry.summary === "string" ? entry.summary : "";
		const tokens = typeof entry.tokensBefore === "number" ? `${Math.round(entry.tokensBefore / 1000)}k tokens` : "";
		return { kind: "notice", text: oneLine(summary) || (type === "compaction" ? "Context compacted" : "Branch summary"), title: type === "compaction" ? "Compaction" : "Branch summary", badges: [...badges, ...(tokens ? [{ text: tokens, tone: "muted" }] : [])], body: summary, facts, toolOnly: false };
	}
	const meta: Record<string, () => string> = {
		model_change: () => `Model → ${entry.provider ?? ""}/${entry.modelId ?? ""}`,
		thinking_level_change: () => `Thinking → ${entry.thinkingLevel ?? ""}`,
		session_info: () => `Session named “${entry.name ?? ""}”`,
		custom: () => String(entry.customType ?? "custom"),
		context_edit: () => "Context edited",
		label: () => `Label ${entry.label ?? ""}`,
	};
	const text = meta[type]?.() ?? type;
	return { kind: "meta", text, title: type.replace(/_/g, " "), badges, body: text, ...(type === "custom" ? { data: entry.data } : {}), facts, toolOnly: false };
}

// Iterative pre-order walk with Pi's rules: the branch holding the leaf comes first, indent grows only at a fork
// (and once more for the first child after it), so a 1k-entry linear chain stays flat.
export function buildTreeModel(roots: unknown, leafId: string | null | undefined): TreeModel {
	const list = Array.isArray(roots) ? (roots as RawNode[]) : [];
	const parentOf = new Map<RawNode, RawNode | undefined>();
	const order: RawNode[] = [];
	const pre = [...list].reverse();
	while (pre.length) {
		const n = pre.pop()!;
		order.push(n);
		const kids = Array.isArray(n.children) ? (n.children as RawNode[]) : [];
		for (let i = kids.length - 1; i >= 0; i--) { parentOf.set(kids[i]!, n); pre.push(kids[i]!); }
	}
	const onPath = new Set<RawNode>();
	const leaf = order.find((n) => n.entry?.id === leafId);
	for (let n = leaf; n; n = parentOf.get(n)) onPath.add(n);

	const rows: TreeRow[] = [];
	let forkCount = 0;
	let turnCount = 0;
	const multipleRoots = list.length > 1;
	const stack: Array<[RawNode, number, boolean]> = [];
	const sortActive = (nodes: RawNode[]) => [...nodes].sort((a, b) => Number(onPath.has(b)) - Number(onPath.has(a)));
	for (const r of sortActive(list).reverse()) stack.push([r, multipleRoots ? 1 : 0, multipleRoots]);
	while (stack.length) {
		const [node, indent, justBranched] = stack.pop()!;
		const kids = sortActive(Array.isArray(node.children) ? (node.children as RawNode[]) : []);
		const entry = node.entry;
		if (entry && typeof entry.id === "string") {
			const label = typeof node.label === "string" && node.label ? node.label : undefined;
			const d = describe(entry, label);
			if (kids.length > 1) { forkCount++; d.badges.push({ text: `${kids.length} branches`, tone: "warning", title: "Fork point" }); }
			if (d.kind === "user") turnCount++;
			const rewinds = (entry.type === "message" && d.kind === "user") || entry.type === "custom_message";
			const { hidden, ...shown } = d;
			rows.push({ id: entry.id, depth: indent, rewinds, timestamp: typeof entry.timestamp === "string" ? entry.timestamp : undefined, label, onActivePath: onPath.has(node), forks: kids.length > 1 ? kids.length : 0, settings: SETTINGS.has(String(entry.type)) || hidden === true, ...shown });
		}
		const childIndent = kids.length > 1 || (justBranched && indent > 0) ? indent + 1 : indent;
		for (let i = kids.length - 1; i >= 0; i--) stack.push([kids[i]!, childIndent, kids.length > 1]);
	}
	return { rows, leafId: leaf?.entry?.id as string | undefined, forkCount, turnCount };
}

export function filterRows(model: TreeModel, filter: TreeFilter, query = ""): TreeRow[] {
	const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
	return model.rows.filter((row) => {
		if (row.toolOnly && filter !== "all") return false;
		const pass = filter === "user" ? row.kind === "user"
			: filter === "labeled" ? row.label !== undefined
			: filter === "no-tools" ? !row.settings && row.kind !== "tool"
			: filter === "all" ? true
			: !row.settings;
		if (!pass) return false;
		if (!tokens.length) return true;
		const hay = `${row.title} ${row.text} ${row.label ?? ""} ${row.body}`.toLowerCase();
		return tokens.every((t) => hay.includes(t));
	});
}

const clock = (iso: string | undefined): string => {
	const t = iso ? Date.parse(iso) : NaN;
	return Number.isFinite(t) ? new Date(t).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : "";
};
const dayOf = (iso: string | undefined): string => (iso && Number.isFinite(Date.parse(iso)) ? new Date(Date.parse(iso)).toDateString() : "");
function dayLabel(iso: string, now: number): string {
	const d = new Date(Date.parse(iso));
	const today = new Date(now).toDateString();
	const yesterday = new Date(now - 86_400_000).toDateString();
	return d.toDateString() === today ? "Today" : d.toDateString() === yesterday ? "Yesterday" : d.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
}

function previewNodes(row: TreeRow): TspNode[] {
	const when = row.timestamp ? new Date(row.timestamp).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }) : "";
	const facts = [{ k: "From", v: row.title }, ...(when ? [{ k: "When", v: when }] : []), ...row.facts, ...(row.forks ? [{ k: "Branches", v: String(row.forks) }] : []), { k: "Entry", v: row.id }];
	const full = row.data !== undefined ? JSON.stringify(row.data, null, 2) ?? "" : row.body;
	const body = full.length > 4000 ? `${full.slice(0, 4000)}\n…` : full;
	return [{
		id: "session-tree-preview", k: "col", p: { role: "pi.tree.preview", gap: "sm" },
		c: [
			{ id: "session-tree-preview-facts", k: "kv", p: { items: facts.map(({ k, v }) => ({ k, v })) } },
			{ id: "session-tree-preview-body", k: row.kind === "assistant" || row.kind === "user" ? "md" : "text", p: { text: body || row.text, ...(row.kind === "tool" || row.kind === "meta" ? { mono: true, tone: "muted" } : {}) } },
			{ id: "session-tree-preview-note", k: "text", p: { tone: "muted", text: row.rewinds
				? "Enter reopens this prompt in the composer to edit and resend. Later turns stay in the tree as a branch."
				: row.onActivePath ? "On the current branch. Enter continues from here; later entries stay in the tree as a branch." : "On another branch. Enter switches to it." } },
		],
	}];
}

export interface TreePickerState { filter: TreeFilter; query: string; selected?: string; sessionName?: string; now: number }

export function sessionTreePickerNode(model: TreeModel, state: TreePickerState): { node: TspNode; visible: TreeRow[] } {
	const visible = filterRows(model, state.filter, state.query);
	const branched = model.forkCount > 0;
	// `items` is a list (Tern's `{ PickerItem }`); a map renders no rows.
	const items: Record<string, unknown>[] = [];
	// Type carries the role: your prompts strong, Pi's replies plain, tool output and bookkeeping quiet.
	const labelOf = (row: TreeRow): unknown =>
		row.kind === "user" ? [{ t: row.text, s: "strong" }]
		: row.kind === "assistant" ? row.text
		: row.kind === "notice" ? [{ t: `${row.title}  `, s: "dim" }, { t: row.text, s: "em" }]
		: [{ t: `${row.title}  `, s: "dim" }, { t: row.text, s: "muted" }];
	for (const row of visible) {
		const lead = row.kind === "user" ? { node: "user" } : row.kind === "tool" ? { node: "tool", icon: "terminal" } : row.kind === "meta" ? { node: "tool", icon: "sliders" } : {};
		items.push({
			id: row.id,
			label: labelOf(row),
			...(branched ? { depth: row.depth, ...(row.onActivePath ? { dot: "accent" } : {}) } : lead),
			...(row.badges.length ? { badges: row.badges } : {}),
			...(row.kind === "tool" || row.kind === "meta" ? { mono: true } : {}),
			...(row.onActivePath ? {} : { tone: "muted" }),
			facts: { when: clock(row.timestamp) },
			...(row.timestamp ? { title: row.timestamp } : {}),
		});
	}
	// Where you are: the leaf itself is usually hook bookkeeping, so the marker sits on the last visible entry of
	// the current branch.
	const here = visible.findLast((r) => r.onActivePath)?.id;
	const selected = visible.some((r) => r.id === state.selected) ? state.selected : here ?? visible.at(-1)?.id;
	const counts = Object.fromEntries(TREE_FILTERS.map((f) => [f.id, filterRows(model, f.id).length])) as Record<TreeFilter, number>;
	const tabs = TREE_FILTERS.filter((f) => f.id !== "labeled" || counts.labeled > 0 || state.filter === "labeled");
	const sub = [state.sessionName, `${model.turnCount} turn${model.turnCount === 1 ? "" : "s"}`, branched ? `${model.forkCount} fork${model.forkCount === 1 ? "" : "s"}` : "linear"].filter(Boolean).join(" · ");
	// Day headers only when the session spans days (8 of 51 real sessions); otherwise the clock column says enough.
	const days = new Set(visible.map((r) => dayOf(r.timestamp)).filter(Boolean));
	const order: unknown[] = [];
	let day = "";
	for (const r of visible) {
		const d = dayOf(r.timestamp);
		if (days.size > 1 && d && d !== day) {
			day = d;
			order.push({ group: d, label: dayLabel(r.timestamp!, state.now), count: visible.filter((x) => dayOf(x.timestamp) === d).length });
		}
		order.push(r.id);
	}
	const row = visible.find((r) => r.id === selected);
	const atLeaf = selected === model.leafId;
	const node: TspNode = {
		id: SESSION_TREE_PICKER_ID, k: "picker",
		p: {
			title: "Session tree", subtitle: sub, icon: "branch", noun: "entries", size: "lg",
			layout: branched ? "tree" : "timeline", preview: "side",
			query: state.query, cursor: state.query.length, placeholder: "Search this session…",
			tabs: tabs.map((f) => ({ id: f.id, label: f.label, count: counts[f.id] })), tab: state.filter,
			items, order, selected: selected ?? null,
			current: here && visible.some((r) => r.id === here) ? [here] : [],
			total: counts[state.filter],
			columns: [{ id: "when", format: "time", priority: 50 }],
			empty: state.filter === "labeled" ? "No labeled entries. Label one in Pi with Shift+L" : "No entries match this view",
			actions: [
				{ id: "filter", label: "Next view", keys: ["tab"] },
				{ id: "navigate", label: atLeaf ? "You are here" : row?.rewinds ? "Edit this prompt" : "Continue from here", keys: ["enter"], primary: true, disabled: !selected || atLeaf },
				{ id: "close", label: "Cancel", keys: ["esc"] },
			],
		},
		c: row ? previewNodes(row) : [],
	};
	return { node, visible };
}

export function nextFilter(filter: TreeFilter, delta: number, model?: TreeModel): TreeFilter {
	const ids = TREE_FILTERS.filter((f) => f.id !== "labeled" || !model || model.rows.some((r) => r.label)).map((f) => f.id);
	const i = ids.indexOf(filter);
	return ids[(i + delta + ids.length) % ids.length]!;
}
