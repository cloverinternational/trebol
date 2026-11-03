/**
 * OMP's `/context` report, for a Pi session.
 *
 * OMP computes this itself (`packages/tui/src/status-line/context-usage.ts`: `computeContextBreakdown`
 * feeding `describeContextFrame`): the parts of the window tokenized from the session's own system prompt,
 * tool roster, skills and messages, plus the auto-compaction reserve and the free space, drawn as a summary
 * row over one stacked `meter` ticked where compaction fires, then the same parts as rows under it. The same
 * card is what OMP's composer meter opens on click (`status.context`).
 *
 * Pi exposes no per-category number: `getContextUsage()` returns `{ tokens, contextWindow, percent }` only.
 * So the total and the window here are the provider's own figures for the last request, and the split is
 * estimated with the chars/4 rule Pi's own `estimateTokens` uses, anchored on that total — `messages` takes
 * the difference, since the conversation is the part that actually grows. When the provider has reported
 * nothing yet (right after a compaction) every part is estimated and the panel says so instead of implying a
 * real total. A category Pi cannot separate is not invented: OMP's `systemContext` has no Pi counterpart, so
 * what is not the skills block stays inside `System prompt`.
 */
import { formatCount, modelDisplayName } from "./composer-view.ts";
import type { TspNode } from "./tsp.ts";

export type ContextCategoryId = "systemPrompt" | "systemTools" | "skills" | "messages";

export interface ContextCategory {
	id: ContextCategoryId;
	label: string;
	tokens: number;
	/** Tern span/meter token: the bar part and the row swatch share it, so the legend is the bar. */
	token: string;
}

export interface ContextBreakdown {
	window: number;
	used: number;
	/** True when `used` is the provider's own count for the last request, false when it is all estimate. */
	exact: boolean;
	categories: ContextCategory[];
	autoCompactBufferTokens: number;
	freeTokens: number;
	/** Where auto-compaction fires, in tokens; undefined when compaction is off. */
	thresholdTokens?: number;
	model?: string;
}

/** Structural slice of the live Pi session this reads; every member is optional, so a bare fake still works. */
export interface ContextSessionLike {
	readonly model?: unknown;
	getContextUsage?(): unknown;
	readonly systemPrompt?: unknown;
	readonly agent?: {
		readonly state?: {
			readonly systemPrompt?: unknown;
			readonly tools?: unknown;
			readonly messages?: unknown;
		};
	};
}

export interface ContextPanelOptions {
	/** Auto-compaction threshold in tokens, as the caller's compaction settings resolve it. */
	thresholdTokens?: number;
}

// Pi's estimateTokens is chars/4 (`compaction/compaction.js`); bytes/4 is the same rule on UTF-8.
const CHARS_PER_TOKEN = 4;
// A picture costs tens of bytes of base64 but ~1.5k tokens: never divide its bytes.
const IMAGE_TOKENS = 1500;
// The skills list is a marked block inside the system prompt, so its tokens are subtracted from the prompt.
const SKILLS_BLOCK = /<available_skills>[\s\S]*?<\/available_skills>/g;
const META_KEYS = new Set(["usage", "timestamp", "id", "api", "provider", "model", "stopReason", "toolCallId", "signature"]);

/** ceil(bytes / 4), the rule Pi's own estimator uses. */
export function estimateContextTokens(text: string | undefined): number {
	if (!text) return 0;
	return Math.ceil(Buffer.byteLength(text, "utf8") / CHARS_PER_TOKEN);
}

function textChars(value: unknown, depth = 0): number {
	if (typeof value === "string") return value.length;
	if (depth > 3) return 0;
	if (Array.isArray(value)) {
		let total = 0;
		for (const part of value) total += textChars(part, depth + 1);
		return total;
	}
	if (!value || typeof value !== "object") return 0;
	const record = value as Record<string, unknown>;
	const type = typeof record.type === "string" ? record.type : "";
	if (type.includes("image")) return IMAGE_TOKENS * CHARS_PER_TOKEN;
	let total = 0;
	for (const [key, entry] of Object.entries(record)) {
		if (META_KEYS.has(key)) continue;
		// Tool arguments arrive as an object: its wire text is what the model reads.
		if (key === "arguments" || key === "input") {
			total += textChars(JSON.stringify(entry ?? {}), depth + 1);
			continue;
		}
		total += textChars(entry, depth + 1);
	}
	return total;
}

/** Everything a message puts on the wire, minus the accounting metadata around it. */
function messageChars(message: unknown): number {
	if (typeof message === "string") return message.length;
	if (!message || typeof message !== "object") return 0;
	const record = message as Record<string, unknown>;
	let chars = 0;
	if (typeof record.role === "string") chars += record.role.length;
	chars += textChars(record.content);
	// Older Pi messages carry calls beside the content, not inside it.
	if (record.toolCalls !== undefined) chars += textChars(record.toolCalls);
	return chars;
}

function toolTokens(tool: unknown): number {
	if (!tool || typeof tool !== "object") return 0;
	const { name, description, parameters } = tool as { name?: unknown; description?: unknown; parameters?: unknown };
	let chars = 0;
	if (typeof name === "string") chars += name.length;
	if (typeof description === "string") chars += description.length;
	try {
		const schema = JSON.stringify(parameters ?? {});
		if (typeof schema === "string") chars += schema.length;
	} catch {
		// A schema holding functions or cycles has no wire text to count.
	}
	return Math.ceil(chars / CHARS_PER_TOKEN);
}

function strings(value: unknown): string {
	return typeof value === "string" ? value : "";
}

/**
 * The window's parts, as OMP computes them, from the live session. Categories are proportional estimates
 * anchored on the provider's total (see the module comment); `exact` says whether that total exists.
 */
export function readContextBreakdown(session: ContextSessionLike, options: ContextPanelOptions = {}): ContextBreakdown {
	const usage = (() => {
		try {
			return session.getContextUsage?.();
		} catch {
			// A stale Pi context throws after session replacement; that reads as unknown, not a crash.
			return undefined;
		}
	})() as { tokens?: unknown; contextWindow?: unknown } | undefined;
	const window = typeof usage?.contextWindow === "number" && usage.contextWindow > 0 ? usage.contextWindow : 0;
	const reported = typeof usage?.tokens === "number" && Number.isFinite(usage.tokens) && usage.tokens > 0 ? usage.tokens : null;

	const state = session.agent?.state;
	const prompt = strings(session.systemPrompt) || strings(state?.systemPrompt);
	const blocks = prompt.match(SKILLS_BLOCK) ?? [];
	const skillsTokens = Math.min(estimateContextTokens(blocks.join("\n")), estimateContextTokens(prompt));
	const promptTokens = prompt ? estimateContextTokens(prompt) - skillsTokens : 0;
	const tools = Array.isArray(state?.tools) ? state.tools : [];
	const systemToolsTokens = tools.reduce((total: number, tool: unknown) => total + toolTokens(tool), 0);
	const messages = Array.isArray(state?.messages) ? state.messages : [];
	const messagesEstimate = Math.ceil(
		messages.reduce((chars: number, message: unknown) => chars + messageChars(message), 0) / CHARS_PER_TOKEN,
	);

	const estimated = promptTokens + systemToolsTokens + skillsTokens;
	// Anchor the split on the provider's total so the stacked bar ends exactly where the composer's meter
	// does; the conversation absorbs the estimation error because it is the part that changes.
	let systemPromptTokens = promptTokens;
	let systemContextTools = systemToolsTokens;
	let skills = skillsTokens;
	let messageTokens = messagesEstimate;
	let used = estimated + messagesEstimate;
	let exact = false;
	if (reported !== null) {
		exact = true;
		used = reported;
		if (estimated > reported) {
			// The estimates alone overshoot the real total (bytes/4 over-counts code): keep their proportions.
			const ratio = reported / estimated;
			systemPromptTokens = Math.floor(promptTokens * ratio);
			systemContextTools = Math.floor(systemToolsTokens * ratio);
			skills = Math.max(0, reported - systemPromptTokens - systemContextTools);
			messageTokens = 0;
		} else {
			messageTokens = reported - estimated;
		}
	}

	const categories: ContextCategory[] = [
		{ id: "systemPrompt", label: "System prompt", tokens: systemPromptTokens, token: "accent" },
		{ id: "systemTools", label: "System tools", tokens: systemContextTools, token: "info" },
		{ id: "skills", label: "Skills", tokens: skills, token: "success" },
		{ id: "messages", label: "Messages", tokens: messageTokens, token: "warning" },
	];

	// The reserve is the room between the compaction threshold and the window; it can never eat into the
	// tokens already used, so it is clamped before free space is.
	const thresholdTokens =
		typeof options.thresholdTokens === "number" && options.thresholdTokens > 0 && options.thresholdTokens <= window
			? options.thresholdTokens
			: undefined;
	const autoCompactBufferTokens = window > 0 && thresholdTokens !== undefined ? Math.min(window - thresholdTokens, Math.max(0, window - used)) : 0;
	const freeTokens = Math.max(0, window - used - autoCompactBufferTokens);

	const model = modelDisplayName(session.model);
	return { window, used, exact, categories, autoCompactBufferTokens, freeTokens, ...(thresholdTokens !== undefined ? { thresholdTokens } : {}), ...(model ? { model } : {}) };
}

function percent(tokens: number, window: number): string {
	return window > 0 ? `${Math.round((tokens / window) * 100)}%` : "—";
}

const UNKNOWN_TEXT = "Context usage is unavailable: no model is selected for this session.";

/**
 * The stacked bar's parts, in the rows' order: each category, free space as the empty track, then the
 * hatched reserve. Zero-token parts are dropped — an empty segment is not information.
 */
function meterParts(breakdown: ContextBreakdown): Array<Record<string, unknown>> {
	const { window } = breakdown;
	const parts = breakdown.categories
		.filter((category) => category.tokens > 0)
		.map((category) => ({
			value: category.tokens / window,
			token: category.token,
			label: `${category.label} · ${category.tokens.toLocaleString("en-US")} tokens (${percent(category.tokens, window)})`,
		}));
	parts.push({
		value: breakdown.freeTokens / window,
		token: "track",
		label: `Free space · ${breakdown.freeTokens.toLocaleString("en-US")} tokens (${percent(breakdown.freeTokens, window)})`,
	});
	if (breakdown.autoCompactBufferTokens > 0) {
		parts.push({
			value: breakdown.autoCompactBufferTokens / window,
			token: "error",
			hatch: true,
			label: `Autocompact buffer · ${breakdown.autoCompactBufferTokens.toLocaleString("en-US")} tokens (${percent(breakdown.autoCompactBufferTokens, window)})`,
		});
	}
	return parts as Array<Record<string, unknown>>;
}

/** One line of the breakdown: a swatch in the part's own bar color, its name, its tokens and its share. */
function shareRow(key: string, swatch: { t: string; s: string }, label: string, tokens: number, window: number): TspNode {
	return {
		id: `context-cat-${key}`,
		k: "row",
		p: { role: `pi.context.cat.${key}`, align: "center", gap: "sm", title: `${label} · ${tokens.toLocaleString("en-US")} tokens` },
		c: [
			{ id: `context-cat-${key}-swatch`, k: "text", p: { role: "pi.context.swatch", spans: [swatch], wrap: "none" } },
			{ id: `context-cat-${key}-label`, k: "text", p: { role: "pi.context.label", text: label, grow: 1, wrap: "none", truncate: "end" } },
			{ id: `context-cat-${key}-tokens`, k: "text", p: { role: "pi.context.tokens", spans: [{ t: formatCount(tokens), s: "num" }], wrap: "none", min: { w: "6ch" } } },
			{ id: `context-cat-${key}-share`, k: "text", p: { role: "pi.context.share", spans: [{ t: percent(tokens, window), s: "num dim" }], wrap: "none", min: { w: "5ch" } } },
		],
	};
}

// The card title names the model; the body leads with the window's own figure.
function head(breakdown: ContextBreakdown): string {
	return breakdown.model ? `Context · ${breakdown.model}` : "Context";
}

/**
 * The `/context` card: summary row, one stacked meter ticked at the compaction threshold, the same parts as
 * rows, then a note that says whether the total is the provider's or an estimate.
 */
export function contextPanelNodes(breakdown: ContextBreakdown): TspNode[] {
	const body: TspNode[] = [];
	if (breakdown.window <= 0) {
		body.push({ id: "context-unavailable", k: "text", p: { role: "pi.context.empty", spans: [{ t: UNKNOWN_TEXT, s: "muted" }] } });
	} else {
		const usedPct = Math.round((breakdown.used / breakdown.window) * 100);
		const threshold = breakdown.thresholdTokens;
		const room =
			threshold === undefined
				? `${formatCount(breakdown.freeTokens)} free`
				: breakdown.used >= threshold
					? `Past auto-compaction at ${percent(threshold, breakdown.window)}`
					: `${formatCount(threshold - breakdown.used)} left before auto-compaction at ${percent(threshold, breakdown.window)}`;
		body.push({
			id: "context-summary",
			k: "row",
			p: { role: "pi.context.summary", align: "baseline", wrap: true, gap: "sm" },
			c: [
				{
					id: "context-used",
					k: "text",
					p: {
						role: "pi.context.used",
						wrap: "none",
						spans: [
							{ t: formatCount(breakdown.used), s: "strong" },
							{ t: ` of ${formatCount(breakdown.window)} tokens · ${usedPct}%` + (breakdown.exact ? "" : " (estimate)"), s: "dim" },
						],
					},
				},
				// Neither part grows: the row wraps, so on a narrow card the room moves to its own line
				// instead of being cut short.
				{ id: "context-room", k: "text", p: { role: "pi.context.room", spans: [{ t: room, s: "muted" }], wrap: "none" } },
			],
		});
		const marks = threshold === undefined ? undefined : [
			{ at: threshold / breakdown.window, tone: "warning", title: `Auto-compaction at ${percent(threshold, breakdown.window)} · ${threshold.toLocaleString("en-US")} tokens` },
		];
		body.push({
			id: "context-bar",
			k: "meter",
			p: {
				role: "pi.context.bar",
				value: Math.min(1, breakdown.used / breakdown.window),
				style: "bar",
				size: "lg",
				parts: meterParts(breakdown),
				...(marks ? { marks } : {}),
				aria: "Context usage by category",
			},
		});
		const rows: TspNode[] = breakdown.categories.map((category) =>
			shareRow(category.id, { t: "■", s: category.token }, category.label, category.tokens, breakdown.window),
		);
		rows.push(shareRow("free", { t: "□", s: "dim" }, "Free space", breakdown.freeTokens, breakdown.window));
		if (breakdown.autoCompactBufferTokens > 0) {
			rows.push(shareRow("buffer", { t: "▨", s: "error" }, "Autocompact buffer", breakdown.autoCompactBufferTokens, breakdown.window));
		}
		body.push({ id: "context-cats", k: "col", p: { role: "pi.context.cats", gap: "xs" }, c: rows });
		body.push({
			id: "context-note",
			k: "text",
			p: {
				role: "pi.context.note",
				wrap: "word",
				spans: [{
					t: breakdown.exact
						? "Total from the provider's last request; the split is estimated from text size."
						: "Estimated from text size: no provider usage yet for this context.",
					s: "dim",
				}],
			},
		});
	}
	body.push({
		id: "context-hint",
		k: "text",
		p: {
			role: "pi.context.hint",
			wrap: "none",
			spans: [{ t: "Click the context meter any time · ", s: "dim" }, { t: "Close", s: "accent" }, { t: " · Esc", s: "dim" }],
			actions: { click: "context.close" },
		},
	});
	return [{ id: "context-panel", k: "overlay", p: { head: head(breakdown), role: "pi.context.overlay", size: "lg" }, c: [{ id: "context-body", k: "col", p: { role: "pi.context.body", gap: "sm" }, c: body }] }];
}

// A transparent full-layer node under the card: a click outside it closes the panel, as the git view does.
export function contextDismissNode(): TspNode {
	return { id: "context-dismiss", k: "text", p: { role: "pi.context.dismiss", text: "", grow: 1, min: { w: "100%", h: "100%" }, actions: { click: "context.close" } } };
}
