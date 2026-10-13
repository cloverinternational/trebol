// Minimal Pi-to-TSP bridge. Projects Pi session events into TSP nodes on one inline surface:
// `main` holds the keyed transcript and tool cards, `dock` holds the composer and status.
// Tern submit/cancel/close actions and typed keys map back onto the Pi session.
// Pi remains the authority for prompts and tools; this module adds no grants. Extension UI prompts
// (select, confirm, input, editor, notify, text widgets) are answered by native Tern dialogs (ext-ui.ts),
// so every extension command works without per-command code. They resolve only from user action.
import {
	autocompleteCommands,
	EMPTY_COMMAND_SOURCE,
	buildCatalog,
	routeSubmission,
	type CommandSource,
} from "./commands.ts";
import type { Model } from "@earendil-works/pi-ai";
import { projectTranscript, type TspMessage, type TspNode, type TspWriter, TernInlineSurface } from "./tsp.ts";
import { composerNodes, modelDisplayName, type GitFacts } from "./composer-view.ts";
import { readGitFacts } from "./git-facts.ts";
import { PI_COMPOSER_CSS } from "./composer-style.ts";
import { IDLE_LOADING, loadingNode, reduceLoading, type LoadingState } from "./loading.ts";
import { projectTaskView, type TaskView, type TaskViewRow, type TaskViewSessionManager } from "./task-view.ts";
import { TernAskDialog, type AskEventBus } from "./ask-dialog.ts";
import { TernExtensionUI, UI_PROMPT_LIST_ID } from "./ext-ui.ts";
import { AUTOCOMPLETE_ID, SlashAutocomplete, type Edit } from "./autocomplete.ts";
import { getNativeClipboard } from "@earendil-works/pi-tui";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface PiEventLike {
	type: string;
	[key: string]: unknown;
}

export interface PiSessionLike {
	subscribe(listener: (event: PiEventLike) => void): () => void;
	prompt(text: string, options?: { streamingBehavior?: "steer" | "followUp" }): Promise<void>;
	clearQueue?(): { steering: string[]; followUp: string[] };
	abort(): Promise<void>;
	dispose(): void;
	readonly model?: unknown;
	readonly sessionManager?: {
		getSessionId?(): unknown;
		getEntries?(): unknown;
		getBranch?(): unknown;
		getTree?(): unknown;
		getLeafId?(): unknown;
		getCwd?(): string;
		getSessionName?(): string | undefined;
	};
	navigateTree?(targetId: string): Promise<{ cancelled: boolean; editorText?: string }>;
	getUserMessagesForForking?(): Array<{ entryId: string; text: string }>;
	getContextUsage?(): unknown;
	getSessionStats?(): { cost?: unknown };
	readonly thinkingLevel?: unknown;
	readonly modelRuntime?: { getAvailableSnapshot(): ReadonlyArray<Model<any>>; getAvailable?(): Promise<ReadonlyArray<Model<any>>> };
	setModel?(model: Model<any>): Promise<void>;
	supportsThinking?(): boolean;
	cycleThinkingLevel?(): unknown;
	getAvailableThinkingLevels?(): string[];
	setThinkingLevel?(level: string): void;
	setSessionName?(name: string): void;
	compact?(customInstructions?: string): Promise<{ tokensBefore: number }>;
	exportToHtml?(outputPath?: string): Promise<string>;
	exportToJsonl?(outputPath?: string): string;
	readonly settingsManager?: {
		getCompactionSettings?(model?: unknown): { enabled?: unknown; reserveTokens?: unknown };
		getDoubleEscapeAction?(): "fork" | "tree" | "none";
	};
}

type Role = "user" | "assistant" | "system" | "tool";

interface Item {
	id: string;
	role: Role;
	text: string;
	status?: "running" | "ok" | "error";
	name?: string;
	args?: unknown;
	output?: string;
}

const OUTPUT_LIMIT = 4000;

function taskGlyph(t: Pick<TaskViewRow, "status" | "active" | "blocked">): string {
	if (t.status === "completed") return "✓";
	if (t.blocked) return "⚠";
	return t.active || t.status === "in_progress" ? "●" : "○";
}

function taskTone(t: Pick<TaskViewRow, "status" | "active" | "blocked">): string {
	if (t.status === "completed") return "success";
	if (t.blocked) return "warning";
	return t.active ? "accent" : t.status === "in_progress" ? "info" : "muted";
}

function taskStatusLabel(t: TaskViewRow): string {
	if (t.status === "completed") return "completed";
	if (t.blocked) return "blocked";
	return t.active ? "focused" : t.status === "in_progress" ? "in progress" : "pending";
}

function messageText(message: unknown): string {
	if (typeof message !== "object" || message === null) return "";
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => (typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text" ? String((part as { text?: unknown }).text ?? "") : ""))
		.join("");
}

function roleOf(message: unknown): Role {
	const role = typeof message === "object" && message !== null ? (message as { role?: unknown }).role : undefined;
	return role === "user" || role === "assistant" ? role : "system";
}

function sessionIdOf(session: PiSessionLike): string | undefined {
	const id = session.sessionManager?.getSessionId?.();
	return typeof id === "string" && id ? id : undefined;
}

function modelIdentity(model: unknown): string | undefined {
	if (typeof model !== "object" || model === null) return undefined;
	const value = model as { provider?: unknown; id?: unknown };
	return typeof value.provider === "string" && typeof value.id === "string" ? `${value.provider}/${value.id}` : undefined;
}

// A stale Pi context can throw on access after session replacement; that reads as unknown, not a crash.
function contextUsageOf(session: PiSessionLike): unknown {
	try {
		return session.getContextUsage?.();
	} catch {
		return undefined;
	}
}

// Pi compacts once tokens exceed window - reserveTokens (compaction.js shouldCompact).
function compactionPercent(session: PiSessionLike, window: number): number | undefined {
	try {
		const c = session.settingsManager?.getCompactionSettings?.(session.model);
		if (!c || c.enabled !== true || typeof c.reserveTokens !== "number") return undefined;
		const pct = ((window - c.reserveTokens) / window) * 100;
		return pct > 0 && pct <= 100 ? pct : undefined;
	} catch {
		return undefined;
	}
}

function costOf(session: PiSessionLike): number | undefined {
	try {
		const cost = session.getSessionStats?.().cost;
		return typeof cost === "number" && Number.isFinite(cost) ? cost : undefined;
	} catch {
		return undefined;
	}
}

// OMP shows the level only for thinking-capable models.
function thinkingOf(session: PiSessionLike): string | undefined {
	try {
		if (!session.supportsThinking?.()) return undefined;
		return typeof session.thinkingLevel === "string" ? session.thinkingLevel : undefined;
	} catch {
		return undefined;
	}
}

// The first recognisable argument, shown as the tool card's target. Commands keep their shell syntax.
function toolTarget(args: unknown): { target?: string; targetKind?: "command" | "path" | "text" } {
	if (typeof args !== "object" || args === null) return {};
	const a = args as Record<string, unknown>;
	if (typeof a.command === "string") return { target: a.command, targetKind: "command" };
	for (const key of ["path", "file_path", "filePath"]) {
		if (typeof a[key] === "string") return { target: a[key] as string, targetKind: "path" };
	}
	for (const key of ["pattern", "query", "url"]) {
		if (typeof a[key] === "string") return { target: a[key] as string, targetKind: "text" };
	}
	return {};
}

function resultText(result: unknown): string {
	const text = typeof result === "string" ? result : messageText(result);
	return text.length > OUTPUT_LIMIT ? `${text.slice(0, OUTPUT_LIMIT)}\n… (truncated)` : text;
}

// Pure projection of Pi events into an ordered transcript. Keeps stable ids per message and tool call.
export class TranscriptProjector {
	#items: Item[] = [];
	#current: Item | null = null;
	#localUserPending = false;
	#seq = 0;

	get items(): readonly Item[] {
		return this.#items;
	}

	replaceFromSessionBranch(entries: readonly unknown[]): void {
		this.#items = [];
		this.#current = null;
		this.#localUserPending = false;
		for (const raw of entries) {
			if (typeof raw !== "object" || raw === null) continue;
			const entry = raw as { id?: unknown; type?: unknown; message?: unknown };
			if (entry.type !== "message" || typeof entry.id !== "string") continue;
			const role = roleOf(entry.message);
			if (role !== "user" && role !== "assistant") continue;
			this.#items.push({ id: entry.id, role, text: messageText(entry.message) });
		}
	}

	apply(event: PiEventLike): boolean {
		switch (event.type) {
			case "message_start": {
				const role = roleOf(event.message);
				// Tool results already belong to their tool_execution_* card.
				if ((event.message as { role?: unknown } | null)?.role === "toolResult") return false;
				if (role === "user" && this.#localUserPending) {
					this.#localUserPending = false;
					return false;
				}
				const item: Item = { id: `m${++this.#seq}`, role, text: messageText(event.message) };
				this.#items.push(item);
				this.#current = item;
				return true;
			}
			case "message_update": {
				const delta = event.assistantMessageEvent as { type?: unknown; delta?: unknown } | undefined;
				if (this.#current && delta?.type === "text_delta" && typeof delta.delta === "string") {
					this.#current.text += delta.delta;
					return true;
				}
				return false;
			}
			case "message_end": {
				if ((event.message as { role?: unknown } | null)?.role === "toolResult") return false;
				const role = roleOf(event.message);
				const text = messageText(event.message);
				const target = this.#current && this.#current.role === role ? this.#current : null;
				if (target && text) target.text = text;
				this.#current = null;
				return true;
			}
			case "tool_execution_start": {
				this.#items.push({
					id: `t-${String(event.toolCallId)}`,
					role: "tool",
					text: `tool ${String(event.toolName)}`,
					status: "running",
					name: String(event.toolName),
					args: event.args,
				});
				return true;
			}
			case "tool_execution_update": {
				const item = this.#items.find((i) => i.id === `t-${String(event.toolCallId)}`);
				if (!item) return false;
				const output = resultText(event.partialResult);
				if (output === item.output) return false;
				item.output = output;
				return true;
			}
			case "tool_execution_end": {
				const item = this.#items.find((i) => i.id === `t-${String(event.toolCallId)}`);
				if (item) {
					item.status = event.isError ? "error" : "ok";
					item.text = `tool ${String(event.toolName)} ${item.status}`;
					item.output = resultText(event.result);
				}
				return true;
			}
			default:
				return false;
		}
	}

	add(role: Exclude<Role, "tool">, text: string): void {
		if (role === "user") this.#localUserPending = true;
		this.#items.push({ id: `n${++this.#seq}`, role, text });
	}

	nodes(): TspNode[] {
		const out: TspNode[] = [];
		for (const item of this.#items) {
			if (item.role === "tool") out.push(toolNode(item));
			else out.push(...projectTranscript([{ id: item.id, role: item.role, text: item.text }]));
		}
		return out;
	}
}

function toolNode(item: Item): TspNode {
	const status = item.status === "ok" ? "done" : item.status === "error" ? "error" : "running";
	const { target, targetKind } = toolTarget(item.args);
	const node: TspNode = {
		id: item.id,
		k: "tool",
		p: {
			name: item.name ?? "tool",
			title: item.name ?? "tool",
			status,
			collapsed: status !== "running",
			...(target !== undefined ? { target, targetKind } : {}),
		},
	};
	if (item.output) node.c = [{ id: `${item.id}-out`, k: "text", p: { text: item.output } }];
	return node;
}

export interface BridgeOptions {
	write: TspWriter;
	surfaceId: string;
	credits?: number;
	apc?: number;
	onClose?: () => void;
	// Live slash-command sources (extensions, templates, skills). Defaults to none: every `/x` is refused.
	commands?: CommandSource;
	// Pi event bus shared with the ask extension. Omitted: ask_user_question stays headless-denied.
	events?: AskEventBus;
	// Reload the active Pi session and return the current on-disk surface CSS.
	// JavaScript modules already loaded by Node cannot be replaced in place.
	reload?: () => Promise<{ css: string; pluginStatus: string }>;
	// Node kinds from Tern's hello reply; OMP folds the effort glyph into the model chip when `effort` exists.
	kinds?: readonly string[];
	// Pi's theme object, handed to extension component factories.
	theme?: unknown;
	clipboard?: { filePaths(): Promise<string[] | null | undefined>; image(): Promise<Uint8Array | null | undefined>; text(): Promise<string | null | undefined>; saveImage?(bytes: Uint8Array): string };
}


export class PiTernBridge {
	readonly #session: PiSessionLike;
	readonly #surface: TernInlineSurface;
	readonly #projector = new TranscriptProjector();
	readonly #onClose?: () => void;
	readonly #commands: CommandSource;
	readonly #complete: SlashAutocomplete;
	#sessionId: string | undefined;
	readonly #events?: AskEventBus;
	readonly #reload?: () => Promise<{ css: string; pluginStatus: string }>;
	#dialog: TernAskDialog | null = null;
	#reloading = false;
	#loading: LoadingState = IDLE_LOADING;
	#unsubscribe: (() => void) | null = null;
	#busy = false;
	#closed = false;
	#draft = "";
	#queuedSteering: string[] = [];
	#queuedFollowUp: string[] = [];
	#model: string | undefined;
	#modelPickerOpen = false;
	#treePickerOpen = false;
	#treePickerItems: Array<{ id: string; label: string; description?: string }> = [];
	#treePickerSelected: string | undefined;
	#lastEligibleEscapeAt = 0;
	#modelQuery = "";
	#modelSelected: string | undefined;
	#modelCatalog: ReadonlyArray<Model<any>> = [];
	#modelCatalogLoading = false;
	#modelCatalogError: string | undefined;
	#modelCatalogRequest = 0;
	#taskQuestionsCollapsed = false;
	readonly #kinds: readonly string[];
	#git: GitFacts | undefined;
	#columns = 100;
	readonly #ui: TernExtensionUI;
	readonly #clipboard: NonNullable<BridgeOptions["clipboard"]>;

	constructor(session: PiSessionLike, options: BridgeOptions) {
		this.#session = session;
		this.#clipboard = options.clipboard ?? {
			filePaths: async () => getNativeClipboard()?.getFilePaths?.(),
			image: async () => getNativeClipboard()?.getImage(),
			text: async () => getNativeClipboard()?.getText(),
			saveImage: (bytes) => {
				const path = join(tmpdir(), `pi-clipboard-${randomUUID()}.png`);
				writeFileSync(path, bytes);
				return path;
			},
		};
		this.#surface = new TernInlineSurface(options.write, options.surfaceId, options.credits, options.apc);
		this.#onClose = options.onClose;
		this.#commands = options.commands ?? EMPTY_COMMAND_SOURCE;
		this.#events = options.events;
		this.#reload = options.reload;
		this.#model = modelDisplayName(session.model);
		this.#kinds = options.kinds ?? [];
		this.#ui = new TernExtensionUI({
			render: () => this.#render(),
			notice: (text) => {
				if (this.#closed) return;
				this.#projector.add("system", text);
				this.#render();
			},
			getDraft: () => this.#draft,
			setDraft: (text) => this.setDraft(text),
			remoteFlowActive: () => this.#dialog?.active ?? false,
			columns: () => this.#columns,
		}, options.theme);
		this.#complete = new SlashAutocomplete({
			commands: () => autocompleteCommands(this.#commands),
			cwd: () => this.#session.sessionManager?.getCwd?.() ?? process.cwd(),
			draft: () => this.#draft,
			setDraft: (text) => this.#writeDraft(text, null),
			render: () => this.#render(),
		});
	}

	// Bind as Pi's ExtensionUIContext (session.bindExtensions({ uiContext })).
	uiContext(): Record<string, unknown> {
		return this.#ui.context();
	}

	get busy(): boolean {
		return this.#busy;
	}

	get closed(): boolean {
		return this.#closed;
	}

	get draft(): string {
		return this.#draft;
	}

	get items(): readonly Item[] {
		return this.#projector.items;
	}

	start(title = "pi"): void {
		this.#surface.open(title);
		this.#surface.stylesheet("composer", PI_COMPOSER_CSS);
		this.#unsubscribe = this.#session.subscribe((event) => this.#onEvent(event));
		if (this.#events) {
			this.#dialog = new TernAskDialog(this.#events, () => this.#render());
			this.#dialog.start();
		}
		this.#syncSession();
		this.#refreshGit();
		this.#render();
	}

	// Clears loading state when Pi's active session changes.
	#syncSession(): void {
		const id = sessionIdOf(this.#session);
		if (id === this.#sessionId) return;
		this.#sessionId = id;
		this.#loading = reduceLoading(this.#loading, { type: "session_switch", sessionId: id ?? null });
	}

	#onEvent(event: PiEventLike): void {
		if (this.#closed) return;
		if (event.type === "session_tree") {
			const branch = this.#session.sessionManager?.getBranch?.();
			if (Array.isArray(branch)) this.#projector.replaceFromSessionBranch(branch);
		}
		if (event.type === "queue_update") {
			this.#queuedSteering = Array.isArray(event.steering) ? event.steering.filter((text): text is string => typeof text === "string") : [];
			this.#queuedFollowUp = Array.isArray(event.followUp) ? event.followUp.filter((text): text is string => typeof text === "string") : [];
		}
		if (event.type === "agent_start") {
			this.#busy = true;
			this.#loading = reduceLoading(this.#loading, { type: "agent_start" });
		}
		if (event.type === "agent_settled" || event.type === "agent_end") {
			this.#busy = false;
			this.#loading = reduceLoading(this.#loading, { type: event.type });
			this.#refreshGit();
		}
		if (event.type === "model_select") {
			this.#model = modelDisplayName(event.model) ?? this.#model;
			this.#modelCatalog = this.#session.modelRuntime?.getAvailableSnapshot() ?? this.#modelCatalog;
		}
		if (this.#projector.apply(event) || event.type.startsWith("agent_") || event.type === "model_select" || event.type === "thinking_level_changed" || event.type === "queue_update" || event.type === "session_tree") this.#render();
	}

	// OMP's composer (composer-view.ts) fed by Pi: context window and compaction point, model, thinking
	// level, git status of Pi's cwd, session cost. OMP's tok/s, focus crumbs and shell mode have no Pi source.
	#dock(): TspNode[] {
		// An open ask flow takes over the input slot: its inline card replaces the composer.
		if (this.#dialog?.active) return [...this.#taskTop(), ...this.#dialog.nodes()];
		const usage = contextUsageOf(this.#session) as { tokens?: unknown; contextWindow?: unknown } | undefined;
		const window = typeof usage?.contextWindow === "number" && usage.contextWindow > 0 ? usage.contextWindow : undefined;
		const tokens = typeof usage?.tokens === "number" && Number.isFinite(usage.tokens) ? usage.tokens : null;
		const compactAt = window !== undefined ? compactionPercent(this.#session, window) : undefined;
		return [...this.#taskTop(), ...this.#ui.widgetNodes("aboveEditor"), ...composerNodes({
			draft: this.#draft,
			ghost: this.#complete.ghost,
			busy: this.#busy,
			queuedFollowUp: this.#queuedFollowUp.length,
			context: window !== undefined ? { tokens, window, ...(compactAt !== undefined ? { compactAt } : {}) } : undefined,
			model: modelDisplayName(this.#session.model) ?? this.#model,
			thinking: thinkingOf(this.#session),
			effortKind: this.#kinds.includes("effort"),
			git: this.#git,
			cost: costOf(this.#session),
		}, loadingNode(this.#loading) ?? undefined), ...this.#ui.widgetNodes("belowEditor")];
	}

	// The bar's facts are clickable in OMP (it opens panels). Pi has no such panels; a click states the
	// same real fact in the transcript instead.
	#statusFact(act: string): string | undefined {
		if (act === "status.model") return `model: ${modelDisplayName(this.#session.model) ?? this.#model ?? "none"} (use /model to switch)`;
		if (act === "status.cost") {
			const cost = costOf(this.#session);
			return cost === undefined ? "session cost unknown" : `session cost $${cost.toFixed(4)}`;
		}
		if (act === "status.context") {
			const u = contextUsageOf(this.#session) as { tokens?: unknown; contextWindow?: unknown } | undefined;
			if (typeof u?.contextWindow !== "number") return "context usage unknown";
			const used = typeof u.tokens === "number" ? `${u.tokens} of ${u.contextWindow} tokens` : `unknown of ${u.contextWindow} tokens`;
			const at = compactionPercent(this.#session, u.contextWindow);
			return `context: ${used}${at !== undefined ? `, auto-compact at ${Math.round(at)}%` : ""}`;
		}
		if (act === "status.git") {
			const g = this.#git;
			if (!g) return "not a git repository";
			return `git: ${g.branch ?? "detached"}, ${g.staged} staged, ${g.unstaged} unstaged, ${g.untracked} untracked`;
		}
		return undefined;
	}

	#refreshGit(): void {
		const cwd = this.#session.sessionManager?.getCwd?.();
		if (!cwd) return;
		void readGitFacts(cwd).then((git) => {
			if (this.#closed || JSON.stringify(git) === JSON.stringify(this.#git)) return;
			this.#git = git;
			this.#render();
		});
	}

	// Overlays float above `main` and `dock`. The ask flow is not here: it renders inline in `dock`.
	// The slash autocomplete is OMP's caret-anchored list; keys stay
	// in the editor and the bridge routes ↑/↓, Tab, Enter and Esc to it.
	#layer(): TspNode[] {
		if (this.#ui.active) return this.#ui.nodes();
		if (this.#treePickerOpen) return [this.#treePickerNode()];
		if (this.#modelPickerOpen) return [this.#modelPickerNode()];
		return this.#complete.nodes();
	}

	#treePickerNode(): TspNode {
		const items: Record<string, unknown> = {};
		const order: string[] = [];
		for (const item of this.#treePickerItems) {
			items[item.id] = { id: item.id, label: item.label, ...(item.description ? { detail: item.description } : {}) };
			order.push(item.id);
		}
		return {
			id: "session-tree-picker", k: "picker",
			p: { title: "Session tree", noun: "entries", size: "lg", layout: "rows", items, order, selected: this.#treePickerSelected ?? null, total: order.length, empty: "No session entries", actions: [{ id: "navigate", label: "Navigate", keys: ["enter"], primary: true, disabled: !this.#treePickerSelected }, { id: "close", label: "Cancel", keys: ["esc"] }] },
		};
	}

	#openSessionTree(): void {
		const manager = this.#session.sessionManager;
		const getTree = manager?.getTree;
		if (!getTree || !this.#session.navigateTree) {
			this.#projector.add("system", "Session tree navigation is unavailable in this Pi session");
			this.#render();
			return;
		}
		let tree: unknown;
		try { tree = getTree.call(manager); }
		catch (error) {
			this.#projector.add("system", `Could not read session tree: ${error instanceof Error ? error.message : String(error)}`);
			this.#render();
			return;
		}
		const rows: Array<{ id: string; label: string; description?: string }> = [];
		const visit = (nodes: unknown, depth: number): void => {
			if (!Array.isArray(nodes)) return;
			for (const raw of nodes) {
				if (!raw || typeof raw !== "object") continue;
				const node = raw as { entry?: { id?: unknown; type?: unknown; message?: unknown; timestamp?: unknown }; children?: unknown; label?: unknown };
				const entry = node.entry;
				if (entry && typeof entry.id === "string") {
					const content = messageText(entry.message);
					const role = roleOf(entry.message);
					const label = typeof node.label === "string" && node.label ? node.label : content || String(entry.type ?? "entry");
					rows.push({ id: entry.id, label: `${"  ".repeat(Math.min(depth, 8))}${role === "user" ? "You" : role === "assistant" ? "Pi" : ""} ${label}`.trim(), description: typeof entry.timestamp === "string" ? entry.timestamp : undefined });
				}
				visit(node.children, depth + 1);
			}
		};
		visit(tree, 0);
		if (!rows.length) {
			this.#projector.add("system", "No entries in session");
			this.#render();
			return;
		}
		this.#treePickerItems = rows;
		const leaf = manager?.getLeafId?.();
		this.#treePickerSelected = typeof leaf === "string" && rows.some((row) => row.id === leaf) ? leaf : rows.at(-1)?.id;
		this.#treePickerOpen = true;
		this.#render();
	}

	async #navigateSessionTree(): Promise<void> {
		const target = this.#treePickerSelected;
		this.#treePickerOpen = false;
		if (!target || !this.#session.navigateTree) { this.#render(); return; }
		try {
			const result = await this.#session.navigateTree(target);
			if (result.cancelled) this.#projector.add("system", "Session navigation cancelled");
			else {
				if (result.editorText && !this.#draft.trim()) this.setDraft(result.editorText);
				this.#projector.add("system", "Navigated to selected session point");
			}
		} catch (error) {
			this.#projector.add("system", `Session navigation failed: ${error instanceof Error ? error.message : String(error)}`);
		}
		this.#render();
	}

	#modelPickerNode(): TspNode {
		const models = this.#modelCatalog;
		const query = this.#modelQuery.trim().toLowerCase();
		const visible = models.filter((m) => `${m.provider}/${m.id} ${m.name}`.toLowerCase().includes(query));
		const providers = [...new Set(visible.map((m) => m.provider))];
		const order: (string | { group: string; label: string; count: number })[] = [];
		const pickerItems: Record<string, unknown> = {};
		for (const provider of providers) {
			const group = visible.filter((m) => m.provider === provider);
			order.push({ group: `provider:${provider}`, label: provider, count: group.length });
			for (const model of group) {
				const id = `${model.provider}/${model.id}`;
				order.push(id);
				pickerItems[id] = { id, label: model.id, detail: model.name, mono: true, facts: { ctx: model.contextWindow ?? 0, price: `$${model.cost?.input ?? 0}/$${model.cost?.output ?? 0}` }, title: id };
			}
		}
		const selected = visible.some((m) => `${m.provider}/${m.id}` === this.#modelSelected) ? this.#modelSelected : visible[0] ? `${visible[0].provider}/${visible[0].id}` : null;
		this.#modelSelected = selected ?? undefined;
		const current = modelIdentity(this.#session.model);
		const currentIds = current && models.some((m) => `${m.provider}/${m.id}` === current) ? [current] : [];
		const preview = visible.find((m) => `${m.provider}/${m.id}` === selected);
		return {
			id: "model-picker-sheet", k: "picker",
			p: { title: "Model", subtitle: this.#modelCatalogLoading ? "Loading available models…" : this.#modelCatalogError, state: this.#modelCatalogError ? "error" : this.#modelCatalogLoading ? "loading" : "ready", ...(this.#modelCatalogError ? { message: this.#modelCatalogError } : {}), icon: "cpu", noun: "models", size: "md", layout: "rows", preview: "below", query: this.#modelQuery, cursor: this.#modelQuery.length, placeholder: "Search models…", items: pickerItems, order, selected, current: currentIds, total: models.length, empty: query ? "No matching models" : "No models available", actions: [{ id: "use", label: "Use", keys: ["enter"], primary: true, disabled: !selected || this.#modelCatalogLoading }, { id: "close", label: "Cancel", keys: ["esc"] }] },
			c: preview ? [{ id: "model-preview", k: "col", c: [
				{ id: "preview-name", k: "text", p: { text: preview.name, role: "omp.picker.title" } },
				{ id: "preview-id", k: "text", p: { text: `${preview.provider}/${preview.id}` } },
				{ id: "preview-facts", k: "text", p: { text: `${preview.contextWindow} context · ${preview.maxTokens} max output · ${preview.reasoning ? "reasoning" : "no reasoning"}${preview.input.includes("image") ? " · vision" : ""}` } },
			] }] : [],
		};
	}

	#taskView(): TaskView | undefined {
		const manager = this.#session.sessionManager;
		if (!manager || typeof manager.getEntries !== "function") return undefined;
		return projectTaskView(manager as TaskViewSessionManager, { questionRows: 12 });
	}

	// Pi's task header (one focused task, its acceptance questions, the next task) as a compact block.
	// Hovering it reveals every task in a popover drawn above it; leaving hides it. Hover is Tern's own
	// view state and never reaches the program, so the popover is always in the tree and shown purely
	// by the stylesheet's :hover rule (composer-style.ts). Clicking a task puts "task #N" in the draft;
	// right-click folds the questions. Read-only: nothing here answers, approves or mutates a task.
	#taskTop(): TspNode[] {
		const view = this.#taskView();
		if (!view || view.status !== "ready" || !view.focus) return [];
		const focus = view.focus;
		const q = focus.questions;
		const fold = this.#taskQuestionsCollapsed ? "tasks.expand" : "tasks.collapse";
		const ref = (id: string) => ({ click: `tasks.reference=${id}`, menu: [`tasks.reference=${id}`, fold, "copy"] });
		const questionRows: TspNode[] = this.#taskQuestionsCollapsed ? [] : q.state === "missing"
			? [{ id: "task-question-missing", k: "text", p: { role: "pi.tasks.question", tone: "warning", text: "  ! Acceptance questions missing — repair required" } }]
			: q.rows.map((row, i) => ({ id: `task-question-${i}`, k: "text", p: {
				role: "pi.tasks.question", tone: row.answered ? "success" : "warning",
				text: `  ${row.answered ? "✓" : "?"} ${row.id}: ${row.text}`,
				title: `${row.id} · ${row.answered ? "answered" : "unanswered"}\n${row.text}`,
			} }));
		const tasks = view.tasks ?? [];
		const popRows: TspNode[] = tasks.flatMap((t) => [
			{ id: `task-pop-${t.id}`, k: "text", p: {
				role: "pi.tasks.row", tone: taskTone(t),
				text: `${taskGlyph(t)} #${t.id} ${t.subject}${t.questions.total ? `  Q ${t.questions.answered}/${t.questions.total}` : ""}`,
				title: `#${t.id} ${t.subject} · ${taskStatusLabel(t)} · click to reference in the prompt`,
				actions: ref(t.id),
			} },
			...(t.status === "completed" || t.active ? [] : t.questions.rows.filter((r) => !r.answered).map((r, i) => ({
				id: `task-pop-${t.id}-q${i}`, k: "text", p: { role: "pi.tasks.pq", text: `    ? ${r.text}`, title: r.text },
			}))),
		]);
		const open = tasks.filter((t) => t.status !== "completed").length;
		return [{ id: "task-top", k: "col", p: { role: "pi.tasks", actions: { menu: [fold] } }, c: [
			{ id: "task-pop", k: "col", p: { role: "pi.tasks.pop" }, c: [
				{ id: "task-pop-head", k: "text", p: { role: "pi.tasks.head", text: `All tasks · ${open} open · ${tasks.length - open} done` } },
				...popRows,
			] },
			{ id: "task-head", k: "text", p: { role: "pi.tasks.head", text: `Tasks  ${view.summary.completed}/${view.summary.completed + view.summary.open} done${view.summary.blocked ? ` · ${view.summary.blocked} blocked` : ""}  ·  hover for all` } },
			{ id: "task-focus", k: "text", p: {
				role: "pi.tasks.focus", tone: "accent",
				text: `● #${focus.id} ${focus.subject}  Q ${q.answered}/${q.total}${this.#taskQuestionsCollapsed && q.total ? " ▸" : ""}`,
				title: `#${focus.id} ${focus.subject}\n${q.answered} of ${q.total} acceptance questions answered`,
				actions: ref(focus.id),
			} },
			...questionRows,
			view.next
				? { id: "task-next", k: "text", p: { role: "pi.tasks.next", text: `  ↳ Next #${view.next.id} ${view.next.subject}`, actions: ref(view.next.id) } }
				: { id: "task-next", k: "text", p: { role: "pi.tasks.next", text: "  ↳ No unblocked next task" } },
		] }];
	}

	// Puts a reference to a task into the draft; never sends it.
	#referenceTask(id: string): void {
		const sep = this.#draft && !this.#draft.endsWith(" ") ? " " : "";
		this.setDraft(`${this.#draft}${sep}task #${id} `);
	}

	#render(): void {
		if (this.#closed) return;
		this.#syncSession();
		const focus = this.#ui.focusId ?? (this.#treePickerOpen ? "session-tree-picker" : this.#modelPickerOpen ? "model-picker-sheet" : "composer");
		this.#surface.render(this.#projector.nodes(), this.#dock(), focus, this.#layer(), this.#complete.selectedId);
	}

	// A programmatic draft change (extension setEditorText, pasteToEditor) closes the autocomplete, as
	// pi-tui's Editor.setText does.
	setDraft(text: string): void {
		this.#writeDraft(text, { kind: "set" });
	}

	#writeDraft(text: string, edit: Edit | null): void {
		if (this.#closed || text === this.#draft) return;
		this.#draft = text;
		this.#render();
		if (edit) void this.#complete.edited(edit);
	}

	// Tab: next question tab in the ask dialog; otherwise pi-tui's editor Tab (apply the selected completion,
	// or open the slash list / path completion).
	tab(): Promise<void> {
		if (this.#closed || this.#ui.active || this.#modelPickerOpen || this.#treePickerOpen) return Promise.resolve();
		if (this.#dialog?.active) {
			this.#dialog.moveTab(1);
			return Promise.resolve();
		}
		return this.#complete.tab();
	}

	// Up/down move the open prompt, dialog, menu or autocomplete selection; otherwise they have no effect.
	movePicker(delta: number): void {
		if (this.#closed) return;
		if (this.#treePickerOpen) {
			if (!this.#treePickerItems.length) return;
			const index = this.#treePickerItems.findIndex((item) => item.id === this.#treePickerSelected);
			this.#treePickerSelected = this.#treePickerItems[(index + delta + this.#treePickerItems.length) % this.#treePickerItems.length]?.id;
			this.#render();
			return;
		}
		if (this.#modelPickerOpen) { this.#moveModelSelection(delta); this.#render(); return; }
		if (this.#ui.active) return this.#ui.move(delta);
		if (this.#dialog?.active) {
			this.#dialog.moveOption(delta);
			return;
		}
		this.#complete.move(delta);
	}

	// Left/right and tab switch the ask dialog's question tabs; they have no effect elsewhere.
	moveDialogTab(delta: number): void {
		if (this.#closed || !this.#dialog?.active) return;
		this.#dialog.moveTab(delta);
	}

	appendDraft(text: string): void {
		if (this.#treePickerOpen) return;
		if (this.#modelPickerOpen) {
			this.#modelQuery += text.replace(/[\r\n]/g, "");
			this.#modelSelected = undefined;
			this.#render();
			return;
		}
		if (this.#ui.active) return this.#ui.type(text);
		if (this.#dialog?.active) {
			this.#dialog.input(text);
			return;
		}
		this.#writeDraft(this.#draft + text, { kind: "type", text });
	}

	// Read clipboard text through Pi's cross-platform clipboard helper.
	async pasteClipboard(): Promise<void> {
		if (this.#closed || this.#ui.active || this.#dialog?.active || this.#modelPickerOpen || this.#treePickerOpen) return;
		const paths = await this.#clipboard.filePaths().catch(() => null);
		if (paths?.length) {
			this.appendDraft(paths.join(" "));
			return;
		}
		const image = await this.#clipboard.image().catch(() => null);
		if (image?.length) {
			const path = this.#clipboard.saveImage?.(image);
			if (!path) return;
			this.appendDraft(path);
			return;
		}
		const text = await this.#clipboard.text().catch(() => null);
		if (text && !this.#closed && !this.#ui.active && !this.#dialog?.active && !this.#modelPickerOpen) {
			this.appendDraft(text.replace(/\r\n?|\n/g, " "));
		}
	}

	// Shift+Enter: a newline in an open multi-line prompt; the composer is single-line.
	newline(): void {
		if (this.#ui.active) this.#ui.newline();
	}

	backspaceDraft(): void {
		if (this.#treePickerOpen) return;
		if (this.#modelPickerOpen) {
			this.#modelQuery = [...this.#modelQuery].slice(0, -1).join("");
			this.#render();
			return;
		}
		if (this.#ui.active) return this.#ui.backspace();
		if (this.#dialog?.active) return this.#dialog.backspace();
		if (!this.#draft) return;
		this.#writeDraft([...this.#draft].slice(0, -1).join(""), { kind: "backspace" });
	}

	// Pi's app.clear (Ctrl+C) clears only the editor; it does not cancel a turn.
	clearDraft(): void {
		if (this.#draft) this.setDraft("");
	}

	// Escape: dismiss transient UI, cancel a running turn, or clear non-empty input before idle double-Escape.
	// Returns true only when the configured `none` action closes the Tern surface.
	escape(): boolean {
		if (this.#treePickerOpen) {
			this.#treePickerOpen = false;
			this.#treePickerSelected = undefined;
			this.#lastEligibleEscapeAt = 0;
			this.#render();
			return false;
		}
		if (this.#modelPickerOpen) {
			this.#lastEligibleEscapeAt = 0;
			if (this.#modelQuery) this.#modelQuery = "";
			else this.#modelPickerOpen = false;
			this.#render();
			return false;
		}
		if (this.#ui.active) {
			this.#lastEligibleEscapeAt = 0;
			this.#ui.cancel();
			return false;
		}
		if (this.#dialog?.active) {
			this.#lastEligibleEscapeAt = 0;
			this.#dialog.cancel();
			return false;
		}
		if (this.#complete.active) {
			this.#lastEligibleEscapeAt = 0;
			this.#complete.close();
			return false;
		}
		if (this.#busy) {
			this.#lastEligibleEscapeAt = 0;
			void this.cancel();
			return false;
		}
		if (this.#draft.trim()) {
			this.#lastEligibleEscapeAt = 0;
			this.setDraft("");
			return false;
		}
		const action = this.#session.settingsManager?.getDoubleEscapeAction?.() ?? "tree";
		if (action !== "none") {
			const now = Date.now();
			if (now - this.#lastEligibleEscapeAt < 500) {
				this.#lastEligibleEscapeAt = 0;
				if (action === "tree") this.#openSessionTree();
				else {
					this.#projector.add("system", "Double-Escape fork selection is not available in the Tern session bridge");
					this.#render();
				}
			} else {
				this.#lastEligibleEscapeAt = now;
			}
			return false;
		}
		this.close();
		return true;
	}

	// Routes one parsed TSP message. Returns the promise of any submitted prompt, for tests.
	handle(msg: TspMessage): Promise<void> | undefined {
		if (this.#closed) return undefined;
		if (msg.verb === "e" && msg.body.ev === "resize" && typeof msg.body.cols === "number" && msg.body.cols > 0) this.#columns = msg.body.cols;
		if (msg.verb === "e" && (msg.body.ev === "select" || msg.body.ev === "activate") && msg.body.id === UI_PROMPT_LIST_ID) {
			this.#ui.pick(msg.body.item, msg.body.ev === "activate");
			return undefined;
		}
		if (msg.verb === "e" && this.#treePickerOpen && msg.body.id === "session-tree-picker") {
			if ((msg.body.ev === "select" || msg.body.ev === "activate") && typeof msg.body.item === "string" && this.#treePickerItems.some((item) => item.id === msg.body.item)) {
				this.#treePickerSelected = msg.body.item;
				if (msg.body.ev === "activate") return this.#navigateSessionTree();
			}
			if (msg.body.ev === "action") {
				if (msg.body.act === "navigate") return this.#navigateSessionTree();
				if (msg.body.act === "close") { this.#treePickerOpen = false; this.#treePickerSelected = undefined; }
			}
			this.#render();
			return undefined;
		}
		if (msg.verb === "e" && msg.body.ev === "key" && this.#treePickerOpen) {
			const key = typeof msg.body.key === "string" ? msg.body.key : "";
			if (key === "up") this.movePicker(-1);
			else if (key === "down") this.movePicker(1);
			else if (key === "enter") return this.#navigateSessionTree();
			else if (key === "escape") this.escape();
			this.#render();
			return undefined;
		}
		if (msg.verb === "e" && msg.body.ev === "action" && typeof msg.body.id === "string" && this.#dialog?.handleAction(msg.body.id)) return undefined;
		if (msg.verb === "e" && (msg.body.ev === "select" || msg.body.ev === "activate") && typeof msg.body.id === "string" && msg.body.id.startsWith(`${AUTOCOMPLETE_ID}.`)) {
			if (typeof msg.body.item === "string") this.#complete.select(msg.body.item, msg.body.ev === "activate");
			return undefined;
		}
		if (msg.verb === "e" && this.#modelPickerOpen && msg.body.id === "model-picker-sheet") {
			if (msg.body.ev === "select" && typeof msg.body.item === "string") this.#modelSelected = msg.body.item;
			if (msg.body.ev === "activate" && typeof msg.body.item === "string") { this.#modelSelected = msg.body.item; return this.#applyModelSelection(); }
			if (msg.body.ev === "action") {
				if (msg.body.act === "use") return this.#applyModelSelection();
				if (msg.body.act === "close") this.#modelPickerOpen = false;
			}
			this.#render();
			return undefined;
		}
		if (msg.verb === "e" && msg.body.ev === "key" && this.#modelPickerOpen) {
			const key = typeof msg.body.key === "string" ? msg.body.key : "";
			if (key === "up") this.#moveModelSelection(-1);
			else if (key === "down") this.#moveModelSelection(1);
			else if (key === "enter") return this.#applyModelSelection();
			else if (key === "escape") { this.#modelPickerOpen = false; }
			else if (key === "backspace") this.#modelQuery = [...this.#modelQuery].slice(0, -1).join("");
			else if (key && !key.startsWith("\x1b")) { this.#modelQuery += key; this.#modelSelected = undefined; }
			this.#render();
			return undefined;
		}
		if (msg.verb === "e" && msg.body.ev === "ack") {
			this.#surface.handleEvent(msg);
			return undefined;
		}
		if (msg.verb !== "e" || msg.body.ev !== "action") return undefined;
		const act = msg.body.act;
		if (act === "submit") return this.submit(submittedText(msg.body));
		if (act === "submit.followUp") return this.submitFollowUp(submittedText(msg.body));
		if (act === "cancel") {
			void this.cancel();
			return undefined;
		}
		if (act === "close") this.close();
		if (act === "interrupt") void this.cancel();
		if (act === "tasks.reference" && typeof msg.body.value === "string") this.#referenceTask(msg.body.value);
		if (act === "tasks.collapse" || act === "tasks.expand") {
			this.#taskQuestionsCollapsed = act === "tasks.collapse";
			this.#render();
		}
		if (typeof act === "string" && act.startsWith("status.")) {
			const fact = this.#statusFact(act);
			if (fact) {
				this.#projector.add("system", fact);
				this.#render();
			}
		}
		if (act === "thinking.cycle") {
			this.#session.cycleThinkingLevel?.();
			this.#render();
		}
		if (act === "model.select") {
			void this.#selectModel();
		}
		return undefined;
	}

	async #selectModel(): Promise<void> {
		const runtime = this.#session.modelRuntime;
		if (!runtime || !this.#session.setModel) {
			this.#projector.add("system", "model selection unavailable in this Pi session");
			this.#render();
			return;
		}
		this.#modelQuery = "";
		this.#modelSelected = modelIdentity(this.#session.model);
		this.#modelCatalog = runtime.getAvailableSnapshot();
		this.#modelCatalogError = undefined;
		this.#modelPickerOpen = true;
		this.#modelCatalogLoading = true;
		this.#render();
		const request = ++this.#modelCatalogRequest;
		try {
			const available = runtime.getAvailable ? await runtime.getAvailable() : runtime.getAvailableSnapshot();
			if (request !== this.#modelCatalogRequest || this.#closed || !this.#modelPickerOpen) return;
			this.#modelCatalog = [...available];
			this.#modelCatalogError = undefined;
		} catch (error) {
			if (request !== this.#modelCatalogRequest || this.#closed) return;
			this.#modelCatalogError = `Could not load available models: ${error instanceof Error ? error.message : String(error)}`;
		} finally {
			if (request === this.#modelCatalogRequest && !this.#closed) {
				this.#modelCatalogLoading = false;
				this.#render();
			}
		}
	}

	#moveModelSelection(delta: number): void {
		const models = this.#modelCatalog.filter((m) => `${m.provider}/${m.id} ${m.name}`.toLowerCase().includes(this.#modelQuery.trim().toLowerCase()));
		if (!models.length) { this.#modelSelected = undefined; return; }
		const index = models.findIndex((m) => `${m.provider}/${m.id}` === this.#modelSelected);
		const next = models[(index + delta + models.length) % models.length];
		this.#modelSelected = `${next.provider}/${next.id}`;
	}

	async #applyModelSelection(): Promise<void> {
		const [provider, id] = (this.#modelSelected ?? "").split("/");
		const model = this.#modelCatalog.find((m) => m.provider === provider && m.id === id);
		this.#modelPickerOpen = false;
		if (model && this.#session.setModel) {
			try { await this.#session.setModel(model); this.#model = modelDisplayName(model) ?? model.id; }
			catch (error) { this.#projector.add("system", `model selection failed: ${error instanceof Error ? error.message : String(error)}`); }
		}
		this.#render();
	}

	async #modelCommand(argument: string): Promise<void> {
		const runtime = this.#session.modelRuntime;
		if (!runtime || !this.#session.setModel) {
			this.#projector.add("system", "model selection unavailable in this Pi session");
			this.#render();
			return;
		}
		if (!argument) {
			await this.#selectModel();
			return;
		}
		try {
			const models = runtime.getAvailable ? await runtime.getAvailable() : runtime.getAvailableSnapshot();
			let model: (typeof models)[number] | undefined;
			if (argument) {
				const [provider, id, ...extra] = argument.split("/");
				if (extra.length) throw new Error("usage: /model [provider/model-id]");
				model = id ? models.find((m) => m.provider === provider && m.id === id) : models.find((m) => m.id === provider);
				if (!model) throw new Error(`model not available: ${argument}`);
			} else {
				const choices = models.map((m) => `${m.name || m.id} (${m.provider}/${m.id})`);
				const select = this.#ui.context().select as (title: string, choices: string[]) => Promise<string | undefined>;
				const choice = await select("Select model", choices);
				if (choice === undefined) return;
				const index = choices.indexOf(choice);
				if (index < 0) throw new Error("model selection is no longer available");
				model = models[index];
			}
			await this.#session.setModel(model);
			this.#model = modelDisplayName(model) ?? model.id;
			this.#projector.add("system", `model selected: ${this.#model}`);
		} catch (error) {
			this.#projector.add("system", `model selection failed: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			if (!this.#closed) this.#render();
		}
	}

	submit(text: string): Promise<void> {
		if (this.#closed) return Promise.resolve();
		if (this.#modelPickerOpen) return this.#applyModelSelection();
		// An open prompt or ask dialog owns Enter; the composer must not send a prompt underneath it.
		if (this.#ui.active) {
			this.#ui.submit();
			return Promise.resolve();
		}
		if (this.#dialog?.active) {
			this.#dialog.confirmCurrent();
			return Promise.resolve();
		}
		const prompt = text.trim();
		if (!prompt) return Promise.resolve();
		if (prompt === "/reload") {
			if (this.#busy || this.#dialog?.active || this.#reloading) {
				this.#projector.add("system", "reload unavailable during a turn, question, or another reload");
				this.#render();
				return Promise.resolve();
			}
			if (!this.#reload) {
				this.#projector.add("system", "reload unavailable: no reload handler bound");
				this.#render();
				return Promise.resolve();
			}
			this.#draft = "";
			this.#reloading = true;
			this.#projector.add("system", "Reloading Pi resources and Tern surface stylesheet…");
			this.#render();
		return this.#reload().then(({ css, pluginStatus }) => {
				if (this.#closed) return;
				this.#surface.stylesheet("composer", css);
			this.#projector.add("system", `Reloaded Pi resources and live Tern surface stylesheet. ${pluginStatus} Runner JavaScript changes require restarting this pane.`);
			}).catch((error: unknown) => {
				if (!this.#closed) this.#projector.add("system", `reload failed: ${error instanceof Error ? error.message : String(error)}`);
		}).finally(() => { this.#reloading = false; if (!this.#closed) this.#render(); });
		}
		if (this.#reloading) {
			this.#projector.add("system", "reload in progress: prompt not sent");
			this.#render();
			return Promise.resolve();
		}
		let catalog: ReturnType<typeof buildCatalog>;
		try { catalog = buildCatalog(this.#commands); }
		catch (error) {
			this.#projector.add("system", `commands unavailable: ${error instanceof Error ? error.message : String(error)}; not sent to the model`);
			this.#render();
			return Promise.resolve();
		}
		const route = routeSubmission(prompt, catalog, this.#busy);
		if (route.kind === "builtin") {
			this.#draft = "";
			return this.#runBuiltin(route.name, route.args);
		}
		if (route.kind === "refuse") {
			this.#projector.add("system", route.reason);
			this.#render();
			return Promise.resolve();
		}
		if (route.kind === "dispatch" && route.immediate) {
			// Extension commands run inside Pi before its busy check, so they are not queued behind a turn.
			this.#draft = "";
			return this.#session.prompt(prompt).catch((error: unknown) => {
				this.#projector.add("system", `error: ${error instanceof Error ? error.message : String(error)}`);
				this.#render();
			});
		}
		if (this.#busy) {
			// Plain Enter submissions during an active turn follow Pi's native queued-message path.
			return this.submitFollowUp(prompt);
		}
		this.#draft = "";
		this.#projector.add("user", prompt);
		this.#busy = true;
		this.#loading = reduceLoading(this.#loading, { type: "prompt_start" });
		this.#render();
		return this.#session.prompt(prompt).catch((error: unknown) => {
			this.#busy = false;
			this.#loading = reduceLoading(this.#loading, { type: "failure" });
			this.#projector.add("system", `error: ${error instanceof Error ? error.message : String(error)}`);
			this.#render();
		});
	}

	// Pi's Alt+Enter queues a follow-up while streaming and submits normally while idle.
	submitFollowUp(text: string): Promise<void> {
		const prompt = text.trim();
		if (!prompt) return Promise.resolve();
		if (!this.#busy) return this.submit(prompt);
		this.#draft = "";
		this.#queuedFollowUp = [...this.#queuedFollowUp, prompt];
		this.#projector.add("system", `Follow-up queued (${this.#queuedFollowUp.length})`);
		this.#render();
		return this.#session.prompt(prompt, { streamingBehavior: "followUp" }).catch((error: unknown) => {
			const queuedIndex = this.#queuedFollowUp.lastIndexOf(prompt);
			if (queuedIndex >= 0) this.#queuedFollowUp.splice(queuedIndex, 1);
			this.#projector.add("system", `error queueing follow-up: ${error instanceof Error ? error.message : String(error)}`);
			this.#render();
		});
	}

	restoreQueuedMessages(): void {
		if (this.#closed) return;
		const restored = this.#session.clearQueue?.();
		const queued = restored ? [...restored.steering, ...restored.followUp] : [...this.#queuedSteering, ...this.#queuedFollowUp];
		this.#queuedSteering = [];
		this.#queuedFollowUp = [];
		if (queued.length) this.setDraft([queued.join("\n\n"), this.#draft].filter(Boolean).join("\n\n"));
		else { this.#projector.add("system", "No queued messages to restore"); this.#render(); }
	}

	// Enter with the autocomplete open applies the selection (pi-tui Editor); a command-name completion then
	// submits, an argument completion stays in the draft.
	submitDraft(): Promise<void> {
		if (this.#closed) return Promise.resolve();
		if (this.#treePickerOpen) return this.#navigateSessionTree();
		const owned = this.#ui.active || this.#dialog?.active || this.#modelPickerOpen;
		if (!owned && this.#complete.active && !this.#complete.enter()) return Promise.resolve();
		this.#complete.close();
		return this.submit(this.#draft);
	}

	// The builtins Pi's interactive mode runs that only need the live session (TERN_BUILTINS). /reload is
	// handled before routing.
	async #runBuiltin(name: string, args: string): Promise<void> {
		const say = (text: string) => {
			if (this.#closed) return;
			this.#projector.add("system", text);
			this.#render();
		};
		const s = this.#session;
		try {
			if (name === "model") return await this.#modelCommand(args);
			if (name === "quit") return void this.close();
			if (this.#busy && name !== "name") return say(`busy: /${name} runs when the current turn finishes or is cancelled`);
			if (name === "thinking") {
				const levels = s.getAvailableThinkingLevels?.() ?? [];
				let level: string | undefined = levels.find((l) => l.toLowerCase() === args.toLowerCase());
				if (!args) {
					const select = this.#ui.context().select as (title: string, choices: string[]) => Promise<string | undefined>;
					level = await select("Thinking level", levels);
					if (level === undefined) return;
				} else if (!level) return say(`Error: Unknown thinking level "${args}". Available levels: ${levels.join(", ")}.`);
				if (!s.setThinkingLevel) return say("thinking level unavailable in this Pi session");
				s.setThinkingLevel(level);
				return say(`Thinking level: ${level}`);
			}
			if (name === "name") {
				const manager = s.sessionManager;
				if (!args) {
					const current = manager?.getSessionName?.();
					return say(current ? `Session name: ${current}` : "Warning: Usage: /name <name>");
				}
				if (!s.setSessionName) return say("session naming unavailable in this Pi session");
				s.setSessionName(args);
				const stored = manager?.getSessionName?.();
				if (stored !== undefined && stored !== args) say(`Warning: Session name was normalized from ${JSON.stringify(args)} to ${JSON.stringify(stored)}`);
				return say(`Session name set: ${stored ?? args}`);
			}
			if (name === "compact") {
				if (!s.compact) return say("compaction unavailable in this Pi session");
				say("Compacting session context…");
				const result = await s.compact(args || undefined);
				return say(`Compacted: ${result.tokensBefore} tokens summarized.`);
			}
			if (name === "export") {
				if (!s.exportToHtml || !s.exportToJsonl) return say("export unavailable in this Pi session");
				const path = args || undefined;
				const file = path?.endsWith(".jsonl") ? s.exportToJsonl(path) : await s.exportToHtml(path);
				return say(`Session exported to: ${file}`);
			}
			say(`/${name} is unavailable in Tern`);
		} catch (error) {
			say(`Error: ${name === "export" ? "Failed to export session: " : ""}${error instanceof Error ? error.message : String(error)}`);
		}
	}

	async cancel(): Promise<void> {
		if (this.#closed || !this.#busy) return;
		await this.#session.abort();
		this.#busy = false;
	this.#loading = reduceLoading(this.#loading, { type: "abort" });
		this.#projector.add("system", "cancelled");
		this.#render();
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
	this.#loading = reduceLoading(this.#loading, { type: "close" });
		this.#unsubscribe?.();
		this.#unsubscribe = null;
		this.#ui.dispose();
		this.#dialog?.dispose();
		this.#surface.close(false);
		this.#session.dispose();
		this.#onClose?.();
	}
}

function submittedText(body: Record<string, unknown>): string {
	const values = body.values;
	if (typeof values === "object" && values !== null) {
		const text = (values as Record<string, unknown>).text;
		if (typeof text === "string") return text;
	}
	return typeof body.value === "string" ? body.value : "";
}
