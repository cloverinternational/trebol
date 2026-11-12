// OMP's Tern composer (cli.js describeLayout / #S / describeComposerFacts), node for node, fed only by
// Pi data. Same roles and structure as OMP's dock frame so Tern's built-in omp-composer.css and
// omp-chat-reader.css (glass card, context hairline, chips, fold, caption, folder) render it 1:1.
// Elements OMP shows that Pi has no source for are omitted, never faked.
import type { TspNode } from "./tsp.ts";
import { DRAWING_ACTION, DRAWING_DISCARD, DRAWING_SEND } from "./drawing.ts";

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

/**
 * Live background work as the composer bar sees it. Absent when nothing is queued or running, so the bar
 * spends no space and draws no chrome for finished work.
 */
export interface WorkFacts {
	running: number;
	queued: number;
	/** The newest live job's name, revealed while the pointer or the keyboard is on the pulse. */
	newest?: string;
}

export interface ComposerFacts {
	draft: string;
	cursor?: number;
	/** Selection anchor; TSP's `editor` draws `anchor`..`cursor` as the selection. */
	anchor?: number | null;
	/** True once the composer can take Tern's atomic `send` event through the normal submit path. */
	sendable?: boolean;
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
	/**
	 * Live background jobs. Rendered as one inline pulse next to the git facts: a spinner Tern clocks itself,
	 * a count, and a card that the stylesheet reveals on hover or keyboard focus. Clicking it opens the work
	 * sheet, which is also where a finished job is inspected (`/work`).
	 */
	work?: WorkFacts;
	cost?: number;
	/** Attachment chips (attachments.ts), drawn above the editor line. */
	chips?: TspNode;
	/**
	 * The live whiteboard preview (drawing.ts): drawn while a focused canvas holds ink. The row carries
	 * the drawing itself as a thumbnail, its shape count, and the one control that sends it.
	 */
	drawing?: DrawingPreviewFacts;
	/**
	 * A live microphone take (Pi Voice). The amplitude history becomes one native `chart` bar each,
	 * drawn as a strip directly on top of the editor. Absent when nothing is recording.
	 */
	wave?: MeterFacts;
	/**
	 * A phone-width composer bar. Keeps the primary action as a labelled touch target instead of a
	 * keycap, and drops secondary facts that would push Send off the row.
	 */
	compact?: boolean;
	/**
	 * True only while Ctrl+B would really move work to the background: a live foreground call exists and a
	 * writer published its detach (running-work.ts `hasRunningWorkDetach`). The button is a projection of that
	 * state, never a second way to start it, so it cannot offer a click that does nothing.
	 */
	backgroundable?: boolean;
}

export interface DrawingPreviewFacts {
	/** Shape count on the canvas when the preview was captured. */
	shapes: number;
	/** The cropped canvas as a blob Tern already holds (sent before the frame that references it). */
	image: { blob: string; width: number; height: number };
}

export interface MeterFacts {
	/** Amplitude history, oldest to newest, each 0–1. */
	levels: readonly number[];
	elapsedMs: number;
	modelState: "loading" | "ready" | "failed";
	microphoneStopped?: boolean;
}

function formatMeterTime(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	return `${Math.floor(total / 60)}:${(total % 60).toString().padStart(2, "0")}`;
}

/**
 * A phone-width composer cannot give 96 columns distinguishable pixels; collapse buckets by peak so
 * the envelope keeps its shape while every bar stays wide enough to read as a bar, not a dotted line.
 */
function waveSeries(levels: readonly number[], compact: boolean | undefined): Array<{ value: number }> {
	const target = compact ? 48 : levels.length;
	if (levels.length <= target) return levels.map((value) => ({ value }));
	const out: Array<{ value: number }> = [];
	for (let column = 0; column < target; column += 1) {
		const from = Math.floor((column * levels.length) / target);
		const to = Math.max(from + 1, Math.floor(((column + 1) * levels.length) / target));
		let peak = 0;
		for (let index = from; index < to; index += 1) peak = Math.max(peak, levels[index] ?? 0);
		out.push({ value: peak });
	}
	return out;
}

function waveMeta(wave: MeterFacts, compact: boolean | undefined): string {
	const model = compact ? "" : wave.modelState === "loading" ? "loading model" : wave.modelState === "failed" ? "model failed" : "";
	return [formatMeterTime(wave.elapsedMs), model, wave.microphoneStopped ? "mic stopped" : ""].filter(Boolean).join(" · ");
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

/**
 * The running-work pulse: one spinner, the count, and — only while hovered or focused — the newest job's
 * name.
 *
 * Tern animates the `spinner` itself, so Pi sends one node and no frames for it. Visibility of the name is
 * the stylesheet's business and it is `display: none` at rest, never faded, so it is gone the instant the
 * pointer leaves. There is deliberately no floating card: the composer bar's status band clips its own
 * children (measured — an absolutely positioned panel inside it paints only the 18px that fit the band),
 * so a hover panel there would be a promise the surface cannot keep. The sheet behind the click is the
 * place for the list, per-job output and stop; `/work` is its keyboard route.
 */
function workChip(w: WorkFacts): TspNode {
	const count = w.running + w.queued;
	const summary = `${count} ${count === 1 ? "job" : "jobs"} running${w.queued ? ` · ${w.queued} queued` : ""}`;
	return {
		id: "work", k: "row",
		p: {
			role: "pi.composer.work", gap: "xs", align: "center",
			title: `${summary}${w.newest ? ` · ${w.newest}` : ""}\nClick to inspect, or /work`,
			aria: summary,
			actions: { click: "bg.open=all" },
		},
		c: [
			{ id: "work-pulse", k: "spinner", p: { role: "pi.composer.work.pulse", style: "orbit", tone: "info", aria: summary } },
			{ id: "work-count", k: "text", p: { role: "pi.composer.work.count", text: String(count), tone: "muted", wrap: "none" } },
			// The separator is part of the label: Tern lays adjacent text nodes flush, so a flex gap would
			// put the name on top of the count.
			...(w.newest ? [{ id: "work-now", k: "text", p: { role: "pi.composer.work.now", text: ` · ${w.newest}`, tone: "muted", wrap: "none" } }] : []),
		],
	};
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
	const git = f.git && !f.compact ? gitSeg(f.git) : undefined;
	// The pulse sits immediately after the git facts in the same growing slot, so it reads as one status
	// line and never pushes Stop or the cost around.
	const work = f.work && !f.compact ? workChip(f.work) : undefined;
	const usage = f.cost !== undefined && f.cost > 0 ? `$${f.cost.toFixed(2)}` : "";
	// The turn's own clock while it runs: Tern counts it, so an idle or busy bar costs the same frames.
	const turn: TspNode | undefined = f.busy && f.turnAgeMs !== undefined
		? { id: "composer-turn", k: "elapsed", p: { role: "omp.composer.turn", age: Math.max(0, Math.round(f.turnAgeMs)), format: "short", title: "This turn’s wall time" } }
		: undefined;
	const submit: TspNode = f.busy
		? { id: "stop", k: "text", p: { role: "omp.composer.stop", text: `Stop${f.queuedFollowUp ? ` · ${f.queuedFollowUp} queued` : ""}`, tone: "error", title: `Stop  esc · Alt+Enter queues follow-up${f.queuedFollowUp ? ` · ${f.queuedFollowUp} queued` : ""}`, actions: { click: "interrupt" } } }
		// A phone has no Enter keycap to aim at. The same action becomes a labelled touch target; the
		// desktop keeps OMP's keycap so its visual contract does not change.
		: f.compact
			? { id: "send", k: "text", p: { role: "pi.composer.send", text: "Send", tone: "accent", title: "Send message", actions: { click: "submit" } } }
			: { id: "send", k: "kbd", p: { role: "omp.composer.send", keys: ["enter"], title: "Send  ⏎", actions: { click: "submit" } } };
	// Tern-only affordance for the chord no terminal draws: while Ctrl+B would detach the work blocking the
	// turn, the bar shows the key it stands for and takes a click on it. Same dispatch as the key
	// (`bg.background` → bridge.backgroundForegroundWork), so the two can never drift.
	const background: TspNode | undefined = f.backgroundable && !f.compact
		? {
			id: "composer-background", k: "row",
			p: { role: "omp.composer.background", gap: "xs", align: "center", title: "Move the running work to the background  ctrl+b", actions: { click: "bg.background" } },
			c: [
				{ id: "composer-background-label", k: "text", p: { role: "omp.composer.background.label", spans: [{ t: "Background", s: "muted" }], wrap: "none", actions: { click: "bg.background" } } },
				{ id: "composer-background-keys", k: "kbd", p: { keys: ["ctrl", "b"], actions: { click: "bg.background" } } },
			],
		}
		: undefined;
	const bar: TspNode = {
		id: "composer-bar",
		k: "row",
		p: { role: "omp.composer.bar", gap: "sm", align: "center" },
		c: [
			...(model ? [model] : []),
			...(effort ? [effort] : []),
			{ id: "extras", k: "status", p: { role: "omp.composer.extras", transparent: true, grow: 1 }, c: [...(git ? [git] : []), ...(work ? [work] : [])] },
			...(turn ? [turn] : []),
			...(!f.compact ? [{ id: "usage", k: "text", p: { role: "omp.composer.usage", text: usage, wrap: "none", ...(usage ? { title: `Session cost ${usage}` } : {}), actions: { click: "status.cost" } } }] : []),
			...(background ? [background] : []),
			submit,
		],
	};
	const line: TspNode = {
		id: "composer-line",
		k: "row",
		p: { role: "omp.composer.line", align: "start", gap: "sm" },
		c: [
			// Tern's own plus: opens the native whiteboard beside this pane, then attaches the drawing.
			{ id: "composer-add", k: "icon", p: { name: "plus", role: "pi.composer.drawing", title: "Draw or diagram  /drawing", tone: "muted", actions: { click: DRAWING_ACTION } } },
			{ id: "composer", k: "editor", p: { text: f.draft, cursor: f.cursor ?? f.draft.length, anchor: f.anchor ?? null, ...(f.ghost ? { ghost: f.ghost } : {}), sendable: f.sendable === true, placeholder: PLACEHOLDER } },
		],
	};
	// The live whiteboard: the drawing itself as a thumbnail, its live facts, and its send path. One quiet
	// row; the primary control is the only accent in it, because it is the one thing the row is for.
	const drawing = f.drawing ? {
		id: "drawing-preview",
		k: "row",
		p: { role: "pi.composer.drawing-preview", gap: "sm", align: "center" },
		c: [
			{ id: "drawing-preview.img", k: "image", p: { role: "pi.composer.drawing.image", blob: f.drawing.image.blob, alt: "Whiteboard drawing", w: f.drawing.image.width, h: f.drawing.image.height, max: { w: "24ch", h: "6lines" } } },
			{ id: "drawing-preview.facts", k: "text", p: { role: "pi.composer.drawing-facts", text: `${f.drawing.shapes} ${f.drawing.shapes === 1 ? "shape" : "shapes"} · live`, tone: "muted", wrap: "none" } },
			{ id: "drawing-preview.send", k: "button", p: { role: "pi.composer.drawing-send", text: "Attach drawing", variant: "primary", size: "sm", title: "Attach the whiteboard drawing to this message", actions: { click: DRAWING_SEND } } },
			{ id: "drawing-preview.hide", k: "button", p: { role: "pi.composer.drawing-hide", text: "Hide", variant: "quiet", size: "sm", title: "Hide the preview; the next stroke brings it back", actions: { click: DRAWING_DISCARD } } },
		],
	} as TspNode : undefined;
	// A live take: one bar per amplitude column, sized by Tern from the series, and the take's own facts
	// beside it. Rendered only while a meter is published, so the composer spends no row when idle.
	const wave = f.wave ? {
		id: "composer-wave",
		k: "row",
		p: { role: "pi.composer.wave", gap: "sm", align: "center" },
		c: [
			{
				id: "composer-wave-chart",
				k: "chart",
				p: {
					role: "pi.composer.wave.chart",
					kind: "bars",
					size: "sm",
					token: "accent",
					grow: 1,
					aria: "Live microphone waveform",
					series: waveSeries(f.wave.levels, f.compact),
				},
			},
			{
				id: "composer-wave-meta",
				k: "text",
				p: {
					role: "pi.composer.wave.meta",
					tone: "muted",
					wrap: "none",
					text: waveMeta(f.wave, f.compact),
				},
			},
		],
	} as TspNode : undefined;
	return [
		{
			id: "composer-col",
			k: "col",
			p: { role: "omp.editor", ...(f.busy ? { tone: "pending" } : {}) },
			c: [...above, ...(f.context ? [contextMeter(f.context)] : []), ...(drawing ? [drawing] : []), ...(f.chips ? [f.chips] : []), ...(wave ? [wave] : []), line, bar],
		},
	];
}
