// OMP's Tern composer (cli.js describeLayout / #S / describeComposerFacts), node for node, fed only by
// Pi data. Same roles and structure as OMP's dock frame so Tern's built-in omp-composer.css and
// omp-chat-reader.css (glass card, context hairline, chips, fold, caption, folder) render it 1:1.
// Elements OMP shows that Pi has no source for are omitted, never faked.
import type { TspNode } from "./tsp.ts";

export interface ContextFacts {
	tokens: number | null;
	window: number;
	// Auto-compaction threshold as a percent of the window (Pi: window - reserveTokens), when enabled.
	compactAt?: number;
}

export interface GitFacts {
	branch?: string;
	staged: number;
	unstaged: number;
	untracked: number;
}

export interface ComposerFacts {
	draft: string;
	cursor?: number;
	selection?: { start: number; end: number };
	ghost?: string;
	busy: boolean;
	/** Wall time of the running turn, drawn as a terminal-clocked timer beside Stop. */
	turnAgeMs?: number;
	queuedFollowUp?: number;
	context?: ContextFacts;
	model?: string;
	/** False when Pi has no model runtime here, so the chip is a label and not a dead click target. */
	modelSelectable?: boolean;
	thinking?: string;
	effortKind: boolean;
	git?: GitFacts;
	cost?: number;
}

export const PLACEHOLDER = "What are we cooking?";
const EFFORT_STEPS: Record<string, number> = { off: 0, minimal: 1, low: 1, medium: 2, high: 3, xhigh: 4, max: 4 };

// OMP's De(): 999, 1.5K, 200K, 1.2M ...
export function formatCount(n: number): string {
	const one = (v: number) => {
		const t = v.toFixed(1);
		return t.endsWith(".0") ? t.slice(0, -2) : t;
	};
	if (n < 1000) return String(n);
	if (n < 1e4) return `${one(n / 1000)}K`;
	if (n < 1e6) return `${Math.round(n / 1000)}K`;
	if (n < 1e7) return `${one(n / 1e6)}M`;
	if (n < 1e9) return `${Math.round(n / 1e6)}M`;
	return `${one(n / 1e9)}B`;
}

// OMP's uPn(): warn at 50% (or 150K), bad at 90% (or 500K), whichever comes first.
export function contextThresholds(window: number): { warn: number; bad: number } {
	const at = (pct: number, tokens: number) => (Number.isFinite(window) && window > 0 ? Math.min(pct, (tokens / window) * 100) : pct) / 100;
	return { warn: at(50, 150_000), bad: at(90, 500_000) };
}

// OMP's y6o(): the model's display name, "Claude " dropped.
export function modelDisplayName(model: unknown): string | undefined {
	if (typeof model === "string") return model || undefined;
	if (typeof model !== "object" || model === null) return undefined;
	const { name, id } = model as { name?: unknown; id?: unknown };
	const n = typeof name === "string" && name ? name : typeof id === "string" && id ? id : undefined;
	return n?.startsWith("Claude ") ? n.slice(7) : n;
}

function contextMeter(c: ContextFacts): TspNode {
	const pct = c.tokens === null || c.window <= 0 ? null : (c.tokens / c.window) * 100;
	const title = [
		pct === null ? "Context usage unknown" : `Context ${Math.round(pct)}% used`,
		c.window > 0 ? `${formatCount(c.tokens ?? 0)} of ${formatCount(c.window)} tokens` : "No context window",
	];
	if (c.compactAt !== undefined) title.push(`Auto-compact at ${Math.round(c.compactAt)}%`);
	return {
		id: "ctx",
		k: "meter",
		p: {
			role: "omp.composer.context",
			value: pct === null ? null : Math.min(1, pct / 100),
			style: "bar",
			thresholds: contextThresholds(c.window),
			...(c.compactAt !== undefined ? { marks: [{ at: Math.min(1, c.compactAt / 100), icon: "context.compaction", title: `Auto-compact at ${Math.round(c.compactAt)}%` }] } : {}),
			...(pct === null ? {} : { label: `${Math.round(pct)}%` }),
			...(c.window > 0 ? { total: formatCount(c.window) } : {}),
			title: title.join("\n"),
			actions: { click: "status.context" },
		},
	};
}

// OMP's git segment describe(): branch in clean/dirty tone, then *unstaged +staged ?untracked.
function gitSeg(g: GitFacts): TspNode | undefined {
	const dirty = g.staged > 0 || g.unstaged > 0 || g.untracked > 0;
	const spans: { t: string; s: string }[] = [];
	if (g.branch) spans.push({ t: g.branch, s: dirty ? "warning" : "success" });
	const push = (t: string, s: string) => spans.push({ t: spans.length > 0 ? ` ${t}` : t, s });
	if (g.unstaged > 0) push(`*${g.unstaged}`, "warning");
	if (g.staged > 0) push(`+${g.staged}`, "success");
	if (g.untracked > 0) push(`?${g.untracked}`, "info");
	if (spans.length === 0) return undefined;
	return { id: "git", k: "seg", p: { role: "omp.composer.fact", priority: 1004, actions: { click: "git.open" }, spans, icon: g.branch ? "branch" : "git", ...(dirty ? { tone: "warning" } : {}) } };
}

export function composerNodes(f: ComposerFacts, above: TspNode[] = []): TspNode[] {
	const level = f.thinking;
	const effortInModel = level !== undefined && f.effortKind;
	const model: TspNode | undefined = f.model
		? {
			id: "model",
			k: "row",
			p: {
				role: "omp.composer.model", gap: "xs", align: "center", title: "Model",
				...(f.modelSelectable === false ? {} : { actions: { click: "model.select" } }),
			},
			c: [
				effortInModel
					? { id: "model-effort", k: "effort", p: { level, role: "omp.composer.model.effort", title: `Thinking effort: ${level}`, actions: { click: "thinking.cycle" } } }
					: { id: "model-icon", k: "icon", p: { name: "model" } },
				{ id: "model-name", k: "text", p: { spans: [{ t: f.model, s: "accent" }], wrap: "none" } },
				{ id: "model-chev", k: "icon", p: { name: "chev" } },
			],
		}
		: undefined;
	const effort: TspNode | undefined = level !== undefined && !effortInModel
		? {
			id: "effort",
			k: "row",
			p: { role: "omp.composer.effort", gap: "xs", align: "center", title: "Thinking effort", actions: { click: "thinking.cycle" } },
			c: [
				{ id: "effort-meter", k: "meter", p: { value: EFFORT_STEPS[level] === undefined ? null : EFFORT_STEPS[level] / 4, style: "blocks", steps: 4 } },
				{ id: "effort-level", k: "text", p: { text: level, wrap: "none" } },
			],
		}
		: undefined;
	const git = f.git ? gitSeg(f.git) : undefined;
	const usage = f.cost !== undefined && f.cost > 0 ? `$${f.cost.toFixed(2)}` : "";
	// The turn's own clock while it runs: Tern counts it, so an idle or busy bar costs the same frames.
	const turn: TspNode | undefined = f.busy && f.turnAgeMs !== undefined
		? { id: "composer-turn", k: "elapsed", p: { role: "omp.composer.turn", age: Math.max(0, Math.round(f.turnAgeMs)), format: "short", title: "This turn’s wall time" } }
		: undefined;
	const submit: TspNode = f.busy
		? { id: "stop", k: "text", p: { role: "omp.composer.stop", text: `Stop${f.queuedFollowUp ? ` · ${f.queuedFollowUp} queued` : ""}`, tone: "error", title: `Stop  esc · Alt+Enter queues follow-up${f.queuedFollowUp ? ` · ${f.queuedFollowUp} queued` : ""}`, actions: { click: "interrupt" } } }
		: { id: "send", k: "kbd", p: { role: "omp.composer.send", keys: ["enter"], title: "Send  ⏎", actions: { click: "submit" } } };
	const bar: TspNode = {
		id: "composer-bar",
		k: "row",
		p: { role: "omp.composer.bar", gap: "sm", align: "center" },
		c: [
			...(model ? [model] : []),
			...(effort ? [effort] : []),
			{ id: "extras", k: "status", p: { role: "omp.composer.extras", transparent: true, grow: 1 }, c: git ? [git] : [] },
			...(turn ? [turn] : []),
			{ id: "usage", k: "text", p: { role: "omp.composer.usage", text: usage, wrap: "none", ...(usage ? { title: `Session cost ${usage}` } : {}), actions: { click: "status.cost" } } },
			submit,
		],
	};
	const line: TspNode = {
		id: "composer-line",
		k: "row",
		p: { role: "omp.composer.line", align: "start", gap: "sm" },
		c: [{ id: "composer", k: "editor", p: { text: f.draft, cursor: f.cursor ?? f.draft.length, ...(f.selection ? { selection: f.selection } : {}), ...(f.ghost ? { ghost: f.ghost } : {}), sendable: false, placeholder: PLACEHOLDER } }],
	};
	return [
		{
			id: "composer-col",
			k: "col",
			p: { role: "omp.editor", ...(f.busy ? { tone: "pending" } : {}) },
			c: [...above, ...(f.context ? [contextMeter(f.context)] : []), line, bar],
		},
	];
}
