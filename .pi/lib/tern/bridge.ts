// Minimal Pi-to-TSP bridge. Projects Pi session events into TSP nodes on one inline surface:
// `main` holds the keyed transcript and tool cards, `dock` holds the composer and status.
// Tern submit/cancel/close actions and typed keys map back onto the Pi session.
// Pi remains the authority for prompts and tools; this module adds no grants. Extension UI prompts
// (select, confirm, input, editor, notify, text widgets) are answered by native Tern dialogs (ext-ui.ts),
// so every extension command works without per-command code. They resolve only from user action.
import { onRunningWorkChange, runningWorkSnapshot, type RunningWorkItem } from "../ui/running-work-store.ts";
import { detachRunningWork, hasRunningWorkDetach } from "../ui/running-work.ts";
import { readSubagentConversationCached } from "../ui/running-work-view.ts";
import { BackgroundPanel } from "./background-panel.ts";
import { safeWorkText } from "./background-format.ts";
import {
	autocompleteCommands,
	EMPTY_COMMAND_SOURCE,
	buildCatalog,
	routeSubmission,
	type CommandSource,
} from "./commands.ts";
import type { Model } from "@earendil-works/pi-ai";
import { editingBanner, imageAttachments, MESSAGE_EDIT, MESSAGE_EDIT_CANCEL, MESSAGE_FOCUS, MESSAGE_RESEND, messageActionRow, messageItemFromNode, resolveUserEntry, userEntriesOf, type EditState, type UserEntry } from "./message-actions.ts";
import { buildTreeModel, DEFAULT_TREE_FILTER, nextFilter, sessionTreePickerNode, TREE_FILTERS, type TreeFilter, type TreeModel, type TreeRow } from "./session-tree.ts";
import { encodeTspBlob, projectTranscript, type TspMessage, type TspNode, type TspView, type TspWriter, TernInlineSurface } from "./tsp.ts";
import { composerNodes, modelDisplayName, type GitFacts, type WorkFacts } from "./composer-view.ts";
import { ARTIFACT_ANNOTATE, artifactFromNodeId, artifactNodes, previewFile, type ArtifactPreview } from "./artifact-previews.ts";
import { ANNOTATE_ADD, ANNOTATE_CANCEL, ANNOTATE_CELL, ANNOTATE_NOTE_ID, ANNOTATE_PIN, ANNOTATE_REMOVE, ANNOTATE_SEND, addMark, annotateNodes, annotatePayload, annotatePng, annotateSession, annotateSheet, cellFromNodeId, cellPoint, editNote, nudgeCursor, pinFromNodeId, removeSelected, selectPin, type AnnotateSession } from "./annotate.ts";
import { readMcpStatus, subscribeMcpStatus } from "../tools/mcp-status.ts";
import type { McpToolDefinitionLike } from "../tools/mcp-inventory.ts";
import { McpController } from "./mcp-controller.ts";
import { readMcpHost } from "./mcp-host.ts";
import { mcpPanelNodes } from "./mcp-panel.ts";
import { filterWork, workCounts, workInspectorNodes, type WorkFilter } from "./work-inspector.ts";
import { gitDismissNode, readRepoStatus, startupBlob, startupNodes, trebolVersion, watchRepo, type RepoStatus } from "./startup-card.ts";
import { commitIndex, discardPaths, readCommitDiff, readFileDiff, stagePaths, unstagePaths, type GitSection } from "./git-status.ts";
import { PI_GIT_CSS, gitHelpNodes, gitPanelNodes, gitPanelRefs, type GitDiffMode, type GitPanelRef, type GitSidebarStyle } from "./git-panel.ts";
import { contextDismissNode, contextPanelNodes, readContextBreakdown } from "./context-panel.ts";
import { patchArtifactPaths } from "../tools/swarm-artifacts.ts";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { readGitFacts } from "./git-facts.ts";
import { PI_COMPOSER_CSS } from "./composer-style.ts";
import { PI_ASK_CSS } from "./ask-style.ts";
import { TERN_WORK_CSS } from "./work-style.ts";
import { PI_CONTEXT_CSS } from "./context-style.ts";
import { TERN_MARKDOWN_CSS } from "./markdown-style.ts";
import { projectTaskView, type TaskView, type TaskViewSessionManager } from "./task-view.ts";
import { buildTaskRows, taskRowCounts, TASK_LIVE_QUESTIONS, TASK_LIVE_ROWS } from "./task-rows.ts";
import { ASK_OPTIONS_ID, TernAskDialog, type AskEventBus } from "./ask-dialog.ts";
import { TernBtwCard } from "./btw-card.ts";
import { TernExtensionUI, UI_PROMPT_INPUT_ID, UI_PROMPT_LIST_ID } from "./ext-ui.ts";
import { createClipboard, imageExtension } from "./clipboard.ts";
import type { KeyEffect } from "./keys.ts";
import { AUTOCOMPLETE_ID, SlashAutocomplete, type Edit } from "./autocomplete.ts";
import { expandMentions } from "./mentions.ts";
import { bashLabel, currentTaskLine, stepHead, toolCallLabel, type CurrentTask } from "./work-summary.ts";
import { goalLine, isAbortedAssistant, isCancellationError, isFailedAssistant, isTurnBoundary, SETTLED_LABEL, segmentTranscript, summarizeToolGroup } from "./turn-groups.ts";
import { DraftEditor, isLargePaste, type HostEdit } from "./draft-edit.ts";
import { ATTACHMENT_LIMITS, ATTACHMENT_REMOVE, attachmentChips, attachmentFromNodeId, attachmentPayload, attachmentSummary, loadAttachment, parseDroppedPaths, type Attachment, type ImageContentLike } from "./attachments.ts";
import { getNativeClipboard } from "@earendil-works/pi-tui";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { extractBashDisplayText } from "../tools/swarm-bash.ts";
import { queueGroups, queueNodes } from "./queue-view.ts";
import { canvasControlAvailable, captureCanvas, capturePreview, DRAWING_ACTION, DRAWING_DISCARD, DRAWING_SEND, drawingAction, previewKey, resolveOwned, type CanvasOwner, type DrawingDeps } from "./drawing.ts";

export interface PiEventLike {
	type: string;
	[key: string]: unknown;
}

export interface PiSessionLike {
	subscribe(listener: (event: PiEventLike) => void): () => void;
	prompt(text: string, options?: { streamingBehavior?: "steer" | "followUp"; images?: ImageContentLike[] }): Promise<void>;
	clearQueue?(): { steering: string[]; followUp: string[] };
	readonly isStreaming?: boolean;
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
	/** Live Pi registry; MCP registrations can arrive after session_start. */
	getAllTools?(): McpToolDefinitionLike[];
	getActiveToolNames?(): string[];
	/** The effective system prompt as one string; the `/context` card splits it (context-panel.ts). */
	readonly systemPrompt?: unknown;
	/** The live agent state: the prompt, the tool roster and the transcript the `/context` card measures. */
	readonly agent?: {
		readonly state?: { readonly systemPrompt?: unknown; readonly tools?: unknown; readonly messages?: unknown };
	};
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

const GIT_STATUS_TTL_MS = 10_000;
// The whiteboard preview's poll cadence: fast while a drawn canvas exists, slow when there is nothing
// to watch, so an idle session pays one `ctl state` every few seconds and nothing else.
const DRAWING_ACTIVE_MS = 1500;
const DRAWING_IDLE_MS = 12_000;
const modelFavoritesPath = () => join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "tern-model-favorites.json");

function loadModelFavorites(): Set<string> {
	try {
		const value: unknown = JSON.parse(readFileSync(modelFavoritesPath(), "utf8"));
		return new Set(Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : []);
	} catch {
		return new Set();
	}
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
	/** Raw output length seen and newlines counted in what was dropped from it (see keepOutput). */
	outputSeen?: number;
	outputDropped?: number;
	outputScan?: number;
	startedAt?: number;
	took?: number;
	exit?: number;
	timedOut?: boolean;
	cancelled?: boolean;
	turnAborted?: boolean;
	turnFailed?: boolean;
	// A visible custom message (goal, monitor, schedule wakeup) that started its own agent turn.
	turnStart?: boolean;
	// A native chart validated out of a custom message's `details.tsp` (auto-graph). Draws instead of its text.
	chart?: TspNode;
	// An assistant message that calls tools: its text is narration of the work, folded with the steps.
	callsTools?: boolean;
	// Live only: an assistant message between message_start and message_end.
	streaming?: boolean;
	// The error text of a failed result, kept to tell an abort's "context canceled" from a real failure.
	errorText?: string;
	// TaskManage's structured batch from the final result, rendered as task rows (never as JSON).
	batch?: TaskManageBatch;
	// Picture previews for Read and apply_patch results; set after the result is known.
	artifacts?: ArtifactPreview[];
	// Repeated terminal callbacks must not erase the last foreground snapshot.
}

const OUTPUT_LIMIT = 4000;

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

// How a Pi message appears in the transcript, or null when it is not shown. Hidden custom messages
// (display:false: hook context, nudges, steering) and Pi's own system/toolResult messages never render; a
// visible custom message is a notice that starts its own turn (Pi sends it with triggerTurn). Live events and
// session restore both go through here, so they agree.
function transcriptEntry(message: unknown): { role: Exclude<Role, "tool">; turnStart?: boolean } | null {
	if (typeof message !== "object" || message === null) return null;
	const m = message as { role?: unknown; display?: unknown };
	if (m.role === "user" || m.role === "assistant") return { role: m.role };
	if (m.role === "custom") return m.display === true ? { role: "system", turnStart: true } : null;
	if (m.role === "system" || m.role === "toolResult") return null;
	return { role: "system" };
}

function sessionIdOf(session: PiSessionLike): string | undefined {
	const id = session.sessionManager?.getSessionId?.();
	return typeof id === "string" && id ? id : undefined;
}

const CHART_LABEL_LIMIT = 120;
// Auto-graph's planner caps a table at 24 rows; larger series are not a shape we draw.
const CHART_SERIES_LIMIT = 24;

function boundedLabel(value: unknown): string | undefined {
	return typeof value === "string" && value !== "" && value.length <= CHART_LABEL_LIMIT ? value : undefined;
}

// A custom message's `details` is arbitrary extension data, not a node tree to execute. Auto-graph puts its
// plan in `details.tsp`; accept only the documented `chart` element with a bars/spark series and no children,
// re-copying every prop, so nothing else in that payload can reach the surface. Anything else keeps the
// message's one-line notice.
function chartNodeOf(message: unknown, id: string): TspNode | null {
	const details = (message as { details?: unknown } | null)?.details;
	const payload = (details as { tsp?: unknown } | null)?.tsp;
	if (typeof payload !== "object" || payload === null) return null;
	const node = payload as { k?: unknown; p?: unknown; c?: unknown };
	if (node.k !== "chart" || (node.c !== undefined && (!Array.isArray(node.c) || node.c.length > 0))) return null;
	if (typeof node.p !== "object" || node.p === null) return null;
	const props = node.p as { kind?: unknown; size?: unknown; summary?: unknown; series?: unknown };
	if (props.kind !== "bars" && props.kind !== "spark") return null;
	if (!Array.isArray(props.series) || props.series.length === 0 || props.series.length > CHART_SERIES_LIMIT) return null;
	const series: Array<{ value: number; label?: string; title?: string }> = [];
	for (const entry of props.series) {
		if (typeof entry !== "object" || entry === null) return null;
		const point = entry as { value?: unknown; label?: unknown; title?: unknown };
		if (typeof point.value !== "number" || !Number.isFinite(point.value) || point.value < 0) return null;
		if (point.label !== undefined && boundedLabel(point.label) === undefined) return null;
		if (point.title !== undefined && boundedLabel(point.title) === undefined) return null;
		const label = boundedLabel(point.label);
		const title = boundedLabel(point.title);
		series.push({ value: point.value, ...(label !== undefined ? { label } : {}), ...(title !== undefined ? { title } : {}) });
	}
	const summary = boundedLabel(props.summary);
	const size = props.size === "sm" || props.size === "md" || props.size === "lg" ? props.size : undefined;
	return { id, k: "chart", p: { kind: props.kind, ...(size !== undefined ? { size } : {}), ...(summary !== undefined ? { summary } : {}), series } };
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

function resultText(result: unknown, limit = OUTPUT_LIMIT): string {
	const text = typeof result === "string" ? result : messageText(result);
	return text.length > limit ? `${text.slice(0, limit)}\n… (truncated)` : text;
}

// Output kept per step. A pane left running for hours sees every build and log tail; keeping each one whole
// grew the heap by about 140 KB per turn without end, and re-splitting a growing live stream made every update
// of a long-running command slower than the last. Past this size only the tail is kept, behind an honest count.
export const OUTPUT_KEEP_CHARS = 256 * 1024;

function countNewlines(text: string, from: number, to: number): number {
	let n = 0;
	for (let i = text.indexOf("\n", from); i >= 0 && i < to; i = text.indexOf("\n", i + 1)) n++;
	return n;
}

// Sets item.output to `text`, or to its last OUTPUT_KEEP_CHARS (from a line start) behind
// "… N earlier lines not kept". Live streams are append-only snapshots, so dropped lines are counted
// incrementally: each update scans only the bytes it added.
function keepOutput(item: Item, text: string, settled = false): void {
	item.outputSeen = text.length;
	if (text.length <= OUTPUT_KEEP_CHARS) {
		item.output = text;
		delete item.outputDropped;
		delete item.outputScan;
		return;
	}
	const nl = text.indexOf("\n", text.length - OUTPUT_KEEP_CHARS);
	const cut = nl < 0 ? text.length - OUTPUT_KEEP_CHARS : nl + 1;
	let scan = item.outputScan ?? 0, dropped = item.outputDropped ?? 0;
	if (scan > cut) { scan = 0; dropped = 0; }
	dropped += countNewlines(text, scan, cut);
	item.outputScan = cut;
	item.outputDropped = dropped;
	const tail = `… ${dropped} earlier ${dropped === 1 ? "line" : "lines"} not kept\n${text.slice(cut)}`;
	// A slice keeps its whole parent string alive; copy once settled so the full output can be collected.
	item.output = settled ? Buffer.from(tail, "utf8").toString("utf8") : tail;
}

// Same snapshot as last time? Exact for kept-whole output; for a bounded one, length plus the kept tail.
function sameOutput(item: Item, text: string): boolean {
	if (item.outputDropped === undefined) return text === item.output;
	return text.length === item.outputSeen && item.output!.endsWith(text.slice(-4096));
}

// Pure projection of Pi events into an ordered transcript. Keeps stable ids per message and tool call.
export class TranscriptProjector {
	#items: Item[] = [];
	#current: Item | null = null;
	#localUserPending = false;
	// Between agent_start and agent_end the turn's group stays a live line, even between tool calls.
	#turnOpen = false;
	// Items before this index belong to settled turns; only a group starting at or after it can be live.
	#turnStart = 0;
	#seq = 0;
	// Per-group presentation state set by native toggle, select and the group's bottom controls. Never part of the session.
	#groupViews = new Map<string, GroupView>();
	// Settled segments' nodes from the last projection, keyed by segment id. A keystroke re-renders the whole
	// surface, so rebuilding every settled turn made each input cost O(session length). An entry is reused only
	// when its inputs are identical (===) and every item is shallow-equal to the snapshot taken when it was built;
	// reused nodes are the same objects, so diffNode skips them by reference. Live groups are never cached: they
	// read Date.now() for their clocks.
	#segmentCache = new Map<string, { deps: readonly unknown[]; items: readonly Item[]; nodes: TspNode[] }>();
	// Render window: items before #windowStart (always a turn boundary) are summarized by one "earlier turns"
	// row. A resumed session would otherwise project, diff and ship every turn it ever had before the pane
	// appears (13 MB and 8 s at 3000 turns), and Tern would hold every node. The window grows with the live
	// session and is trimmed back once it holds TRANSCRIPT_TRIM_TURNS, unless the user asked for older turns.
	#windowStart = 0;
	#hiddenTurns = 0;
	#userExpanded = false;

	get items(): readonly Item[] {
		return this.#items;
	}

	// Tool call id -> the item id of its newest call. Some providers restart call ids in every message
	// (`call_0`, `call_1`, …), so one id can name several calls in a session; keying items by `t-<callId>` alone
	// showed restored repeats as interrupted, dropped live repeats entirely and put duplicate ids on the wire.
	#callItems = new Map<string, string>();
	#callRepeats = 0;

	/** The item for a tool call id (its newest call). */
	callItem(callId: string): Item | undefined {
		return this.item(this.#callItems.get(callId) ?? `t-${callId}`);
	}

	// A new call: the first use of an id keeps `t-<callId>`; a repeat gets a unique suffix.
	#newCallItemId(callId: string): string {
		const id = this.#callItems.has(callId) ? `t-${callId}~${++this.#callRepeats}` : `t-${callId}`;
		this.#callItems.set(callId, id);
		return id;
	}

	/** The item with this id, searched from the newest: a tool's result and live updates arrive right after its
	 * call, so a forward scan made restoring a session O(n²) and every streamed update O(history). */
	item(id: string): Item | undefined {
		for (let i = this.#items.length - 1; i >= 0; i--) if (this.#items[i]!.id === id) return this.#items[i];
		return undefined;
	}

	replaceFromSessionBranch(entries: readonly unknown[]): void {
		this.#items = [];
		this.#current = null;
		this.#localUserPending = false;
		this.#turnOpen = false;
		this.#turnStart = 0;
		this.#groupViews.clear();
		this.#segmentCache.clear();
		this.#callItems.clear();
		this.#userExpanded = false;
		this.#setWindowStart(0);
		for (const raw of entries) {
			if (typeof raw !== "object" || raw === null) continue;
			const entry = raw as { id?: unknown; type?: unknown; message?: unknown };
			if (typeof entry.id !== "string") continue;
			// Pi persists sendMessage() output as custom_message entries; live it arrives as a "custom" message.
			const message = entry.type === "custom_message" ? { ...(raw as object), role: "custom" } : entry.type === "message" ? entry.message : undefined;
			if (message === undefined) continue;
			if ((message as { role?: unknown } | null)?.role === "toolResult") {
				this.#settleRestoredTool(message as ToolResultLike);
				continue;
			}
			const shown = transcriptEntry(message);
			if (!shown) continue;
			const chart = shown.turnStart ? chartNodeOf(message, `chart-${entry.id}`) : null;
			this.#items.push({ id: entry.id, role: shown.role, text: messageText(message), ...(shown.turnStart ? { turnStart: true } : {}), ...(chart ? { chart } : {}), ...(toolCallsOf(message).length > 0 ? { callsTools: true } : {}) });
			if (isAbortedAssistant(message)) this.#markTurnAborted();
			if (isFailedAssistant(message)) this.#markTurn("turnFailed");
			// Persisted tool calls live in the assistant message; their results arrive later as toolResult entries.
			for (const call of toolCallsOf(message)) {
				this.#items.push({ id: this.#newCallItemId(String(call.id)), role: "tool", text: `tool ${call.name}`, status: "running", name: call.name, args: call.arguments });
			}
		}
		// A call with no persisted result was interrupted before the session was saved.
		for (const item of this.#items) {
			if (item.role === "tool" && item.status === "running") {
				item.status = "error";
				item.cancelled = true;
			}
		}
		// A resumed pane opens on its last turns; older ones are one click away.
		this.#setWindowStart(turnStartBefore(this.#items, this.#items.length, TRANSCRIPT_WINDOW_TURNS));
	}

	#settleRestoredTool(result: ToolResultLike): void {
		const item = this.callItem(String(result.toolCallId));
		if (!item || item.status !== "running") return;
		const details = result.details as { exit_code?: unknown; duration_ms?: unknown } | undefined;
		item.exit = typeof details?.exit_code === "number" && details.exit_code !== 0 ? details.exit_code : undefined;
		item.status = result.isError || item.exit !== undefined ? "error" : "ok";
		item.took = typeof details?.duration_ms === "number" ? details.duration_ms : undefined;
		const text = messageText(result);
		if (item.status === "error") item.errorText = text.length > OUTPUT_KEEP_CHARS ? `…${text.slice(-OUTPUT_KEEP_CHARS)}` : text;
		keepOutput(item, item.name?.toLowerCase() === "bash" && !result.isError ? extractBashDisplayText(text) : resultText(text), true);
		item.text = `tool ${item.name ?? "tool"} ${item.status}`;
	}

	// An aborted turn reads as interrupted. Its steps that were still running, or that failed only because of
	// the abort, read as cancelled; finished and genuinely failed steps keep their result. Used live and on
	// restore, so both agree.
	#markTurn(flag: "turnFailed"): void {
		for (let i = this.#items.length - 1; i >= 0; i--) {
			const item = this.#items[i]!;
			if (isTurnBoundary(item)) break;
			if (item.role === "tool") item[flag] = true;
		}
	}

	#markTurnAborted(): void {
		for (let i = this.#items.length - 1; i >= 0; i--) {
			const item = this.#items[i]!;
			if (isTurnBoundary(item)) break;
			if (item.role !== "tool") continue;
			item.turnAborted = true;
			if (item.cancelled) continue;
			if (item.status === "running" || (item.status === "error" && item.exit === undefined && isCancellationError(item.errorText))) {
				item.status = "error";
				item.cancelled = true;
			}
		}
	}

	apply(event: PiEventLike): boolean {
		switch (event.type) {
			case "agent_start": {
				this.#turnOpen = true;
				this.#turnStart = this.#items.length;
				return true;
			}
			case "message_start": {
				// Tool results already belong to their tool_execution_* card; hidden messages are never shown.
				const shown = transcriptEntry(event.message);
				if (!shown) return false;
				const role = shown.role;
				if (role === "user" && this.#localUserPending) {
					this.#localUserPending = false;
					return false;
				}
				const id = `m${++this.#seq}`;
				const chart = shown.turnStart ? chartNodeOf(event.message, `chart-${id}`) : null;
				const item: Item = { id, role, text: messageText(event.message), ...(shown.turnStart ? { turnStart: true } : {}), ...(chart ? { chart } : {}), ...(toolCallsOf(event.message).length > 0 ? { callsTools: true } : {}), ...(role === "assistant" ? { streaming: true } : {}) };
				this.#items.push(item);
				this.#current = item;
				return true;
			}
			case "message_update": {
				const delta = event.assistantMessageEvent as { type?: unknown; delta?: unknown } | undefined;
				// Once the message starts a tool call its text is narration: fold it before the call runs.
				if (this.#current && delta?.type === "toolcall_start" && !this.#current.callsTools) {
					this.#current.callsTools = true;
					return true;
				}
				if (this.#current && delta?.type === "text_delta" && typeof delta.delta === "string") {
					this.#current.text += delta.delta;
					return true;
				}
				return false;
			}
			case "message_end": {
				const shown = transcriptEntry(event.message);
				if (!shown) return false;
				const text = messageText(event.message);
				const target = this.#current && this.#current.role === shown.role ? this.#current : null;
				if (target && text) target.text = text;
				if (target && toolCallsOf(event.message).length > 0) target.callsTools = true;
				if (target) delete target.streaming;
				this.#current = null;
				if (isAbortedAssistant(event.message)) this.#markTurnAborted();
				if (isFailedAssistant(event.message)) this.#markTurn("turnFailed");
				return true;
			}
			case "tool_execution_start": {
				const prior = this.callItem(String(event.toolCallId));
				// A repeated start for the same call, or one already restored as interrupted, is the same call. A call
				// whose id was used by a call that finished is a new call (a provider reusing ids).
				if (prior && (prior.status === "running" || prior.cancelled === true)) return false;
				this.#items.push({
					id: this.#newCallItemId(String(event.toolCallId)),
					role: "tool",
					text: `tool ${String(event.toolName)}`,
					status: "running",
					name: String(event.toolName),
					args: event.args,
					startedAt: Date.now(),
				});
				return true;
			}
			case "tool_execution_update": {
				const item = this.callItem(String(event.toolCallId));
				if (!item || item.status !== "running") return false;
				const output = item.name?.toLowerCase() === "bash" ? messageText(event.partialResult) : resultText(event.partialResult);
				if (sameOutput(item, output)) return false;
				keepOutput(item, output);
				return true;
			}
			case "tool_execution_end": {
				const item = this.callItem(String(event.toolCallId));
				if (item) {
					if (item.cancelled || item.status !== "running") return false;
					const details = (event.result as { details?: { exit_code?: unknown; duration_ms?: unknown; timed_out?: unknown } } | null)?.details;
					const resultBody = messageText(event.result);
					item.took = typeof details?.duration_ms === "number" ? details.duration_ms : item.startedAt ? Date.now() - item.startedAt : undefined;
					// Pi turns thrown Bash errors into prose without retaining tool details.
					const bashFailure = item.name?.toLowerCase() === "bash" && event.isError === true && resultBody.startsWith("Error executing bash:");
					const failureExit = bashFailure ? /^Error executing bash: Command exited with code (-?\d+):/.exec(resultBody)?.[1] : undefined;
					item.exit = typeof details?.exit_code === "number" && details.exit_code !== 0 ? details.exit_code : failureExit ? Number(failureExit) : undefined;
					item.timedOut = details?.timed_out === true || (bashFailure && /^Error executing bash: command timed out after \d+s/.test(resultBody));
					item.status = event.isError || item.exit !== undefined ? "error" : "ok";
					if (item.status === "error") item.errorText = resultBody.length > OUTPUT_KEEP_CHARS ? `…${resultBody.slice(-OUTPUT_KEEP_CHARS)}` : resultBody;
					if (item.name === "TaskManage") item.batch = taskManageBatch(event.result);
					item.text = `tool ${String(event.toolName)} ${item.status}`;
					// A cancelled tool may have no final payload. Retain the last live snapshot.
					const final = item.name?.toLowerCase() === "bash" ? messageText(event.result) : resultText(event.result);
					// The final model envelope merges streams by channel, strips ANSI, and may
					// truncate. The last live snapshot is the full ordered terminal output;
					// only fall back to the envelope when no update ever arrived.
					if (!item.output && final) keepOutput(item, item.name?.toLowerCase() === "bash" && !event.isError ? extractBashDisplayText(final) : final, true);
					else if (item.output && item.outputDropped !== undefined) item.output = Buffer.from(item.output, "utf8").toString("utf8");
				}
				return true;
			}
			case "agent_end": {
				let changed = this.#turnOpen;
				this.#turnOpen = false;
				for (const item of this.#items) {
					// An aborted run can end without message_end; its partial text then settles like any other.
					if (item.streaming) { delete item.streaming; changed = true; }
				if (item.role !== "tool" || item.status !== "running") continue;
					// Pi's aborted turn can omit tool_execution_end; never leave a live spinner.
					item.cancelled = true;
					item.took = item.startedAt ? Date.now() - item.startedAt : undefined;
					item.status = "error";
					changed = true;
				}
				return changed;
			}
			default:
				return false;
		}
	}

	add(role: Exclude<Role, "tool">, text: string): void {
		if (role === "user") this.#localUserPending = true;
		this.#items.push({ id: `n${++this.#seq}`, role, text });
	}

	// Your messages on screen, in order: the bubbles Edit and Resend can resolve to Pi entries.
	userItemIds(): string[] {
		return this.#items.filter((item) => item.role === "user" && !item.turnStart).map((item) => item.id);
	}

	/** Turns before the render window, shown as one "earlier" row. */
	get hiddenTurns(): number {
		return this.#hiddenTurns;
	}

	/** Brings TRANSCRIPT_WINDOW_TURNS more earlier turns into the render window. */
	showEarlier(): void {
		if (this.#windowStart === 0) return;
		this.#userExpanded = true;
		this.#setWindowStart(turnStartBefore(this.#items, this.#windowStart, TRANSCRIPT_WINDOW_TURNS));
	}

	#setWindowStart(start: number): void {
		this.#windowStart = start;
		let hidden = 0;
		for (let i = 0; i < start; i++) if (isTurnBoundary(this.#items[i]!)) hidden++;
		this.#hiddenTurns = hidden;
	}

	// Keeps the window bounded: a resumed session opens on its last turns, and a long live one is trimmed back.
	#fitWindow(): void {
		if (this.#userExpanded) return;
		let turns = 0;
		for (let i = this.#windowStart; i < this.#items.length; i++) if (isTurnBoundary(this.#items[i]!)) turns++;
		if (turns > TRANSCRIPT_TRIM_TURNS) this.#setWindowStart(turnStartBefore(this.#items, this.#items.length, TRANSCRIPT_WINDOW_TURNS));
	}

	nodes(outputExpanded = false, options: { currentTask?: CurrentTask; messageFocus?: string; editing?: string; busy?: boolean } = {}): TspNode[] {
		const out: TspNode[] = [];
		this.#fitWindow();
		if (this.#hiddenTurns > 0) {
			const more = Math.min(this.#hiddenTurns, TRANSCRIPT_WINDOW_TURNS);
			out.push({ id: "transcript-earlier", k: "text", p: { role: "tern.earlier", tone: "muted", wrap: "none", text: `↑ ${this.#hiddenTurns} earlier ${this.#hiddenTurns === 1 ? "turn" : "turns"} · show ${more} more`, title: "Show earlier turns", actions: { click: TRANSCRIPT_EARLIER } } });
		}
		const cache = new Map<string, { deps: readonly unknown[]; items: readonly Item[]; nodes: TspNode[] }>();
		const memo = (key: string, items: readonly Item[], deps: readonly unknown[], build: () => TspNode[]) => {
			const hit = this.#segmentCache.get(key);
			if (hit && sameDeps(hit.deps, deps) && sameItems(hit.items, items)) {
				cache.set(key, hit);
				out.push(...hit.nodes);
				return;
			}
			const nodes = build();
			cache.set(key, { deps, items: items.map((item) => ({ ...item })), nodes });
			out.push(...nodes);
		};
		const visible = this.#windowStart === 0 ? this.#items : this.#items.slice(this.#windowStart);
		const segments = segmentTranscript(visible);
		// Only the newest turn can still be running; an earlier group is settled once a user message follows it.
		let openGroup = -1;
		if (this.#turnOpen) {
			for (let i = segments.length - 1; i >= 0; i--) {
				const s = segments[i]!;
				if (s.kind === "tools") {
					if (this.#windowStart + visible.indexOf(s.items[0]!) >= this.#turnStart) openGroup = i;
					break;
				}
				if (isTurnBoundary(s.item)) break;
			}
		}
		// What the running turn is saying right now: the last line of its newest assistant text, streamed.
		let tail = "";
		if (openGroup >= 0) {
			const said = this.#items.slice(this.#turnStart).findLast((item) => item.role === "assistant" && item.text.trim() !== "");
			tail = said ? (said.text.trim().split("\n").map((line) => line.trim()).filter(Boolean).at(-1) ?? "").replace(/\s+/g, " ") : "";
		}
		segments.forEach((segment, i) => {
			if (segment.kind === "tools") {
				const turnOpen = i === openGroup;
				const key = groupId(segment.items);
				const view = this.#groupViews.get(key);
				const ctx = { tail: turnOpen ? tail : "", outputExpanded, turnOpen, view, currentTask: options.currentTask };
				// toolGroupNode labels the current task only in the live (running) group.
				if (turnOpen || segment.items.some((item) => item.status === "running")) out.push(...toolGroupNode(segment.items, ctx));
				else memo(`g:${key}`, segment.items, [outputExpanded, view], () => toolGroupNode(segment.items, ctx));
				return;
			}
			const { item } = segment;
			// A message with no visible text (thinking or tool calls only) has nothing to show.
			if (item.role === "assistant" && item.text.trim() === "") return;
			const focused = options.messageFocus === item.id;
			memo(`m:${item.id}`, [item], [options.editing === item.id, focused, focused && options.busy === true], () => messageNodes(item, options));
		});
		this.#segmentCache = cache;
		return out;
	}

	setGroupCollapsed(groupId: string, collapsed: boolean): void {
		this.#groupViews.set(groupId, { ...this.#groupViews.get(groupId), minimized: collapsed });
	}

	groupItems(id: string): Item[] {
		const group = segmentTranscript(this.items).find((s) => s.kind === "tools" && groupId(s.items) === id);
		return group?.kind === "tools" ? group.items : [];
	}

	revealStep(id: string): string | undefined {
		const group = segmentTranscript(this.items).find((s) => s.kind === "tools" && s.items.some((i) => i.id === id));
		if (!group || group.kind !== "tools") return undefined;
		const key = groupId(group.items);
		const at = this.#items.indexOf(group.items[0]!);
		if (at < this.#windowStart) {
			this.#userExpanded = true;
			this.#setWindowStart(turnStartBefore(this.#items, at + 1, 1));
		}
		// Every step is always shown, so revealing one only means opening its card.
		this.setGroupCollapsed(key, false);
		return key;
	}

	clearGroupViews(): void {
		this.#groupViews.clear();
	}
}

// Turns a resumed transcript opens on, and the live size at which it is trimmed back to that.
export const TRANSCRIPT_WINDOW_TURNS = 50;
export const TRANSCRIPT_TRIM_TURNS = 150;
export const TRANSCRIPT_EARLIER = "transcript.earlier";

// Index of the boundary that starts the `turns`-th turn before `end` (0 when there are fewer).
function turnStartBefore(items: readonly Item[], end: number, turns: number): number {
	let seen = 0;
	for (let i = end - 1; i >= 0; i--) {
		if (!isTurnBoundary(items[i]!)) continue;
		if (++seen === turns) return i;
	}
	return 0;
}

function sameDeps(a: readonly unknown[], b: readonly unknown[]): boolean {
	return a.length === b.length && a.every((value, i) => value === b[i]);
}

// Items are flat records whose nested values (args, batch, chart, artifacts) are replaced, never mutated, so a
// shallow comparison sees every change. Unchanged strings keep their reference, so === is O(1) for them.
function sameItems(snapshots: readonly Item[], items: readonly Item[]): boolean {
	if (snapshots.length !== items.length) return false;
	for (let i = 0; i < items.length; i++) {
		const a = snapshots[i] as unknown as Record<string, unknown>;
		const b = items[i] as unknown as Record<string, unknown>;
		const keys = Object.keys(b);
		if (keys.length !== Object.keys(a).length) return false;
		for (const key of keys) if (a[key] !== b[key]) return false;
	}
	return true;
}

function messageNodes(item: Item, options: { messageFocus?: string; editing?: string; busy?: boolean }): TspNode[] {
	// A visible custom notice (agent completed, goal, monitor, schedule) is one muted line, never a block.
	if (item.turnStart) {
		// Auto-graph's planned chart draws natively; its ASCII text is the fallback for renderers without Tern.
		if (item.chart) return [item.chart];
		return [{ id: `msg-${item.id}`, k: "text", p: { role: "tern.notice", tone: "muted", wrap: "none", truncate: "end", text: goalLine(item.text) } }];
	}
	const [node] = projectTranscript([{ id: item.id, role: item.role as Exclude<Role, "tool">, text: item.text, streaming: item.streaming }]);
	if (node && item.role === "user") {
		// A click shows what you can do with it; a right-click offers the same.
		node.p = { ...node.p, actions: { click: MESSAGE_FOCUS, menu: [MESSAGE_EDIT, MESSAGE_RESEND, "copy"] }, title: "Click to edit or resend", ...(options.editing === item.id ? { tone: "accent" } : {}) };
		if (options.messageFocus === item.id) node.c = [...(node.c ?? []), messageActionRow(item.id, options.busy === true)];
	}
	return node ? [node] : [];
}

function toolRow(item: Item, outputExpanded: boolean): TspNode {
	const tool = toolNode(item, outputExpanded);
	const previews = artifactNodes(item.id, item.artifacts ?? []);
	return previews.length === 0 ? tool : { id: `${item.id}-group`, k: "col", p: { role: "tern.tool-group", gap: "none" }, c: [tool, ...previews] };
}

interface ToolResultLike {
	toolCallId: string;
	isError: boolean;
	content?: unknown;
	details?: unknown;
}

function toolCallsOf(message: unknown): Array<{ id: string; name: string; arguments: unknown }> {
	const content = (message as { content?: unknown } | null)?.content;
	if (!Array.isArray(content)) return [];
	return content.filter((part): part is { type: "toolCall"; id: string; name: string; arguments: unknown } => typeof part === "object" && part !== null && (part as { type?: unknown }).type === "toolCall" && typeof (part as { id?: unknown }).id === "string" && typeof (part as { name?: unknown }).name === "string");
}

// Live and settled: one card with the same id and kind. Its body holds one `tool` head per step (narration kept
// between runs) and the group's own controls. The fold is host-side: a native toggle or Collapse work sets this
// group's state; Ctrl+O clears it.
function groupId(items: readonly Item[]): string {
	return `g-${items[0]?.id ?? "empty"}`;
}

// The only group-local state left is the fold: the work is always the same step tree, live or settled.
interface GroupView { minimized?: boolean }

interface GroupContext {
	tail: string;
	outputExpanded: boolean;
	turnOpen: boolean;
	view: GroupView | undefined;
	currentTask: CurrentTask | undefined;
}

// The group's own clock: how long the turn has been working (live) or how long its steps took (settled).
// Tern counts a live `age` on from the value it last received, so no per-second frame is needed.
function liveAge(tools: readonly Item[]): number | undefined {
	let first: number | undefined;
	for (const item of tools) if (item.startedAt !== undefined) first = first === undefined ? item.startedAt : Math.min(first, item.startedAt);
	return first === undefined ? undefined : Math.max(0, Date.now() - first);
}

// A failure count is a badge, not a meta fact: it keeps its tone when the turn settles as Done.
function failureBadge(summary: { failedSteps: number; status: string }): Array<{ text: string; tone: string }> {
	if (summary.failedSteps === 0) return [];
	return [{ text: `${summary.failedSteps} failed`, tone: summary.status === "failed" ? "error" : "warning" }];
}

function toolGroupNode(items: Item[], ctx: GroupContext): TspNode[] {
	const tools = items.filter((item) => item.role === "tool");
	// Keyed by the group's first member, so the node keeps its id when the first tool starts after narration
	// (a changed id is a remove plus insert in Tern, which flickers).
	const id = groupId(items);
	const summary = summarizeToolGroup(tools);
	const live = summary.status === "running" || ctx.turnOpen;
	const minimized = ctx.view?.minimized ?? (!live && !ctx.outputExpanded);
	const steps = tools.length === 1 ? "1 step" : `${tools.length} steps`;
	// A failure count is the only badge worth keeping: "Done" already says the rest, and every step is visible.
	const badges = failureBadge(summary);
	const cancelledSteps = workCounts(tools).cancelled;
	if (cancelledSteps) badges.push({ text: `${cancelledSteps} cancelled`, tone: "muted" });
	// The head follows the work, not the prompt: the newest running call, else the last call in the group.
	const running = tools.findLast((item) => item.status === "running" && !item.cancelled);
	const headCall = running ?? tools.at(-1);
	const headLabel = headCall ? toolCallLabel(headCall.name, headCall.args) : undefined;
	const age = live ? liveAge(tools) : undefined;
	const took = live ? undefined : summary.durationMs;
	if (live) {
		const state = summary.active > 0 ? `${summary.active} running` : "working";
		const line = headLabel ? `${state} · ${headLabel}` : state;
		// The live header is the settled card's id, key and kind, so it keeps identity through streaming, expansion
		// and settlement.
		const card: TspNode = {
			id, k: "tool",
			p: {
				role: "tern.work-live", key: id, name: "work", title: state, status: "running", text: line,
				...(headLabel ? { target: headLabel, targetKind: "text" } : {}),
				...(age !== undefined ? { age } : {}),
				...(badges.length > 0 ? { badges } : {}),
				frame: "card", collapsible: true, collapsed: minimized, meta: [steps],
			},
			c: workBody(id, items, ctx.currentTask, ctx.outputExpanded),
		};
		// Only a minimized live group needs the narration tail; the head already names the current call.
		const tailText = ctx.tail;
		const tail: TspNode[] = minimized && tailText ? [{ id: `${id}-tail`, k: "text", p: { role: "tern.work-tail", tone: "muted", wrap: "none", truncate: "end", text: tailText } }] : [];
		return [card, ...tail];
	}
	// Narration whose tool calls never started (the turn ended first) is just what the agent said.
	if (tools.length === 0) return items.filter((item) => item.text.trim()).flatMap((item) => projectTranscript([{ id: item.id, role: "assistant", text: item.text, streaming: item.streaming }]));
	const status = summary.status === "done" ? "done" : summary.status === "failed" ? "error" : "cancelled";
	return [{
		id, k: "tool",
		p: {
			role: "tern.work", key: id, name: "work", title: SETTLED_LABEL[summary.status], status,
			...(headLabel ? { target: headLabel, targetKind: "text" } : {}),
			...(took !== undefined ? { took } : {}),
			...(badges.length > 0 ? { badges } : {}),
			frame: "card", collapsible: true, collapsed: minimized,
			meta: [steps],
		},
		c: workBody(id, items, undefined, ctx.outputExpanded),
	}];
}

const textNode = (id: string, role: string, text: string, tone: string, extra: Record<string, unknown> = {}): TspNode => ({ id, k: "text", p: { role, tone, wrap: "none", truncate: "end", text, ...extra } });

// The card body is one tree: the tracked task when there is one, every step in call order with narration left in
// place, then a single quiet Inspect action (the overlay already owns All/Active/Failed and search).
// One `col` wrapper also keeps Tern from drawing its kind-change hairline between a step and its neighbours, so
// the tree reads by indentation alone.
function workBody(groupId: string, items: readonly Item[], currentTask: CurrentTask | undefined, outputExpanded: boolean): TspNode[] {
	const children: TspNode[] = [];
	if (currentTask) children.push(textNode(`${groupId}-focus`, "tern.work-focus", currentTaskLine(currentTask), "accent"));
	for (const item of items) {
		if (item.role === "tool") {
			children.push(toolRow(item, outputExpanded));
			continue;
		}
		if (item.text.trim()) children.push({ id: `${item.id}-note`, k: "md", p: { role: "tern.work-note", text: item.text, stream: item.streaming === true } });
	}
	children.push({
		id: `${groupId}-inspect`, k: "text",
		p: {
			role: "tern.work-inspect", tone: "muted", wrap: "none", text: "Inspect steps",
			title: "Search and inspect these steps", actions: { click: `work.inspect=${groupId}` },
		},
	});
	return [{ id: `${groupId}-body`, k: "col", p: { role: "tern.work-body", gap: "sm" }, c: children }];
}

function toolNode(item: Item, outputExpanded: boolean): TspNode {
	const status = item.cancelled ? "cancelled" : item.status === "ok" ? "done" : item.status === "error" ? "error" : "running";
	if (item.name === "bash" || item.name === "Bash") return bashToolNode(item, status, outputExpanded);
	if (item.name === "TaskManage") return taskManageToolNode(item, status);
	if (item.name === "apply_patch") return patchToolNode(item, status, outputExpanded);
	return genericToolNode(item, status, outputExpanded);
}

// Any tool without a dedicated view: a head from `stepHead` and its own output as the body.
function genericToolNode(item: Item, status: "running" | "done" | "error" | "cancelled", outputExpanded: boolean): TspNode {
	const head = stepHead(item.name, item.args);
	const running = status === "running";
	const note = item.timedOut ? "timed out" : undefined;
	const timing = running ? (item.startedAt === undefined ? {} : { age: Date.now() - item.startedAt }) : item.took !== undefined ? { took: item.took } : {};
	const body = item.output !== undefined && item.output !== "";
	const node: TspNode = {
		id: item.id,
		k: "tool",
		p: {
			name: head.name,
			title: head.verb,
			status,
			frame: "inline",
			// A running step stays open over a bounded live window; a settled one folds to its head (Ctrl+O opens all).
			collapsible: body,
			collapsed: body && !running && !outputExpanded,
			...(head.target !== undefined ? { target: head.target, targetKind: head.targetKind ?? "text" } : {}),
			...(head.intent !== undefined ? { intent: head.intent } : {}),
			...(timing as { age?: number; took?: number }),
			...(item.exit !== undefined ? { exit: item.exit } : {}),
			...(note !== undefined ? { note } : {}),
		},
	};
	if (item.output) node.c = [{ id: `${item.id}-out`, k: "text", p: { text: running ? tailWindow(item.output, STEP_LIVE_LINES, item.outputDropped) : item.output } }];
	return node;
}

/** One file's hunks from an `apply_patch` body: the path its header names and its `@@`/`+`/`-` lines. */
interface PatchSection {
	path: string;
	lines: string[];
	added: number;
	removed: number;
}

// Splits V4A `*** Update/Add/Delete File:` sections into Tern `diff` sources. Only hunk lines are kept, so the
// `***` markers never leak into the diff as context. Counts come from the same lines, never from the result text.
function patchSections(input: string | undefined): PatchSection[] {
	if (!input) return [];
	const out: PatchSection[] = [];
	let current: PatchSection | undefined;
	for (const line of input.split("\n")) {
		const header = /^\*\*\* (?:Update|Add|Delete) File: (.+)$/.exec(line);
		if (header) {
			current = { path: header[1]!.trim(), lines: [], added: 0, removed: 0 };
			out.push(current);
			continue;
		}
		if (line.startsWith("***")) continue;
		if (!current) continue;
		if (line.startsWith("+")) current.added += 1;
		else if (line.startsWith("-")) current.removed += 1;
		else if (!line.startsWith("@@") && !line.startsWith(" ")) continue;
		current.lines.push(line);
	}
	return out.filter((section) => section.lines.length > 0);
}

const patchStats = (sections: readonly PatchSection[]): string | undefined => {
	const added = sections.reduce((n, section) => n + section.added, 0);
	const removed = sections.reduce((n, section) => n + section.removed, 0);
	const parts = [added > 0 ? `+${added}` : "", removed > 0 ? `−${removed}` : ""].filter(Boolean);
	return parts.length > 0 ? parts.join(" ") : undefined;
};

interface TaskManageBatch {
	status?: string;
	results: Array<{ key?: string; op?: string; status?: string; error?: unknown; data?: { task?: { id?: string; subject?: string; status?: string } } }>;
}

const isBatch = (value: unknown): value is TaskManageBatch =>
	typeof value === "object" && value !== null && Array.isArray((value as { results?: unknown }).results);

// The structured batch is canonical; the model-facing JSON text is only a fallback.
function taskManageBatch(result: unknown): TaskManageBatch | undefined {
	const details = (result as { details?: { batch?: unknown } } | null)?.details;
	if (isBatch(details?.batch)) return details.batch;
	if (isBatch(details)) return details;
	try {
		const parsed: unknown = JSON.parse(messageText(result));
		return isBatch(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function taskErrorText(error: unknown): string {
	const message = typeof error === "object" && error !== null ? (error as { message?: unknown }).message : error;
	return typeof message === "string" && message ? message : "failed";
}

// A task status as a checklist item state: the terminal draws the ring, the strike and the `.fresh` check.
const TASK_ITEM_STATUS: Record<string, "pending" | "active" | "done" | "dropped" | "blocked"> = {
	pending: "pending",
	in_progress: "active",
	completed: "done",
	deleted: "dropped",
};

// The task batch as one checklist: a phase per call with a progress ring and one item per operation.
// A failed operation is `blocked` with its error as the item note. The raw JSON is never rendered.
function taskManageToolNode(item: Item, status: "running" | "done" | "error" | "cancelled"): TspNode {
	const args = item.args as { operations?: unknown } | undefined;
	const ops = Array.isArray(args?.operations) ? (args.operations as Array<Record<string, unknown>>) : [];
	const results = item.batch?.results ?? [];
	const byKey = new Map(results.filter((r) => typeof r.key === "string").map((r) => [r.key as string, r]));
	const items = ops.map((op, i) => {
		const key = typeof op.key === "string" ? op.key : `op${i}`;
		const result = byKey.get(key);
		const task = result?.data?.task;
		const failed = result?.status === "failed" || result?.status === "error" || result?.error !== undefined;
		const taskStatus = task?.status ?? (typeof op.status === "string" ? op.status : undefined);
		const id = task?.id ?? (typeof op.taskId === "string" ? op.taskId : undefined);
		const subject = task?.subject ?? (typeof op.subject === "string" ? op.subject : "");
		const verb = `${typeof op.op === "string" ? op.op : "op"}${id ? ` #${id}` : ""}`;
		return {
			id: `${item.id}-op-${i}`,
			text: subject ? `${verb} · ${subject}` : verb,
			status: failed ? "blocked" : TASK_ITEM_STATUS[taskStatus ?? ""] ?? "pending",
			...(failed ? { note: taskErrorText(result?.error) } : {}),
		};
	});
	const elapsed = status === "running" ? Date.now() - (item.startedAt ?? Date.now()) : item.took ?? 0;
	return {
		id: item.id, k: "tool",
		p: {
			role: "tasks.call", name: "todo", title: "Tasks", status, frame: "inline", collapsible: true, collapsed: false,
			target: `${ops.length} op${ops.length === 1 ? "" : "s"}`, targetKind: "text",
			...(status === "running" ? { age: elapsed } : { took: elapsed }),
		},
		c: [{ id: `${item.id}-body`, k: "col", p: { role: "tasks.body", gap: "none" }, c: [
			{
				id: `${item.id}-list`, k: "checklist",
				p: {
					role: "tasks.list",
					// No phase title: the step head already says "N ops", and a single untitled phase drops its row.
					phases: [{ id: `${item.id}-phase`, title: "", items: items.length ? items : [{ id: `${item.id}-empty`, text: "No operations", status: "pending" }] }],
				},
			},
		] }],
	};
}

// A Bash step reads as the model's description, never as "Bash <command>". The command is what the step opens to:
// the body puts it before the output, unless the label already is the command whole. Status, exit and the clock
// stay in the head; the exact command stays copyable through `command`.
function bashToolNode(item: Item, status: "running" | "done" | "error" | "cancelled", outputExpanded: boolean): TspNode {
	const args = item.args as { command?: unknown; description?: unknown; name?: unknown } | undefined;
	const command = typeof args?.command === "string" && args.command ? args.command : "…";
	const description = typeof args?.description === "string" ? args.description.trim() : "";
	const name = typeof args?.name === "string" ? args.name.trim() : "";
	const label = bashLabel(item.args) ?? "Bash";
	const flat = command.replace(/\s+/g, " ").trim();
	// With a description (or a caller name) the label is intent, so the exact command belongs in the body. Without
	// one the label is the command; repeat it only when the label could not carry it whole.
	const needsCommandBody = description !== "" || name !== "" || flat !== command.trim() || flat.length > 400;
	const elapsed = status === "running" ? Date.now() - (item.startedAt ?? Date.now()) : item.took ?? 0;
	const output = item.output?.trim() ? item.output : undefined;
	const body: TspNode[] = [
		...(needsCommandBody ? [{ id: `${item.id}-cmd`, k: "code", p: { role: "omp.tool.bash.command", lang: "bash", wrap: true, text: command.trimEnd() } }] : []),
		...(output === undefined ? [] : [{ id: `${item.id}-out`, k: "ansi", p: { role: "omp.tool.bash.output", text: status === "running" ? tailWindow(output, STEP_LIVE_LINES, item.outputDropped) : output, follow: true } }]),
	];
	return {
		id: item.id, k: "tool",
		p: {
			role: "omp.tool.bash", key: item.id.slice(2), name: "bash", title: "",
			target: label, targetKind: description !== "" || name !== "" ? "text" : "command",
			// Open while it runs, so the tail of its output is visible; folded once settled. Ctrl+O opens every step.
			command, status, frame: "inline",
			collapsible: body.length > 0,
			collapsed: body.length > 0 && status !== "running" && !outputExpanded,
			...(status === "running" ? { age: elapsed } : { took: elapsed }),
			...(item.exit !== undefined ? { exit: item.exit } : {}),
			...(item.timedOut ? { note: "timed out" } : {}),
		},
		...(body.length > 0 ? { c: body } : {}),
	};
}

// A patch is a diff, not a status word: the head names the files and their `+a −d`, the body draws the hunks with
// Tern's own diff element (word-level emphasis, indent guides, the user's unified/split setting). Folded once it
// settles, so a long turn keeps one head line per edit until it is opened.
function patchToolNode(item: Item, status: "running" | "done" | "error" | "cancelled", outputExpanded: boolean): TspNode {
	const args = item.args as { input?: unknown; patch?: unknown } | undefined;
	const input = typeof args?.input === "string" ? args.input : typeof args?.patch === "string" ? args.patch : undefined;
	const sections = patchSections(input);
	const head = stepHead("apply_patch", item.args);
	if (sections.length === 0) return genericToolNode(item, status, outputExpanded);
	const files = sections.map((section) => section.path);
	const shown = files.slice(0, MAX_PATCH_FILES_SHOWN).join(", ");
	const more = files.length > MAX_PATCH_FILES_SHOWN ? ` +${files.length - MAX_PATCH_FILES_SHOWN} more` : "";
	const stats = patchStats(sections);
	const elapsed = status === "running" ? Date.now() - (item.startedAt ?? Date.now()) : item.took ?? 0;
	return {
		id: item.id,
		k: "tool",
		p: {
			name: "edit",
			title: head.verb,
			target: `${shown}${more}`,
			targetKind: files.length === 1 ? "path" : "text",
			...(head.intent !== undefined ? { intent: head.intent } : {}),
			...(stats !== undefined ? { meta: [stats] } : {}),
			status,
			frame: "inline",
			collapsible: true,
			collapsed: status !== "running" && !outputExpanded,
			...(status === "running" ? { age: elapsed } : { took: elapsed }),
			...(item.exit !== undefined ? { exit: item.exit } : {}),
			...(item.timedOut ? { note: "timed out" } : {}),
		},
		// One diff per file, in call order; same-kind children draw no divider, so the tree needs no wrapper.
		c: sections.slice(0, MAX_PATCH_FILES_SHOWN).map((section, i) => ({
			id: `${item.id}-diff-${i}`, k: "diff",
			p: { role: "tern.work-patch.diff", text: section.lines.join("\n"), path: section.path },
		})),
	};
}

export interface BridgeOptions {
	write: TspWriter;
	surfaceId: string;
	credits?: number;
	apc?: number;
	onClose?: () => void;
	// Observes every Pi session event before projection (run.ts records them when PI_TERN_EVENT_LOG is set).
	onEvent?: (event: PiEventLike) => void;
	// Observes every render: the transcript nodes, what triggered it (an event type or "ui"), and whether the agent is busy.
	onRender?: (nodes: readonly TspNode[], trigger: string, busy: boolean) => void;
	// Live slash-command sources (extensions, templates, skills). Defaults to none: every `/x` is refused.
	commands?: CommandSource;
	// Pi event bus shared with the ask extension. Omitted: ask_user_question stays headless-denied.
	events?: AskEventBus;
	// Reload the active Pi session and return the current on-disk surface CSS.
	// JavaScript modules already loaded by Node cannot be replaced in place.
	reload?: () => Promise<{ css: string; pluginStatus: string }>;
	// Starts a new Pi session through the runtime, the same path /new takes natively. Omitted: /new is refused.
	newSession?: () => Promise<{ cancelled?: boolean } | void>;
	// Node kinds from Tern's hello reply; OMP folds the effort glyph into the model chip when `effort` exists.
	kinds?: readonly string[];
	// Pi's theme object, handed to extension component factories.
	theme?: unknown;
	// Native Tern drawing (canvas control + cropped capture). Omitted: /drawing and + explain that the
	// bridge is not running in the desktop Tern app instead of pretending to draw.
	drawing?: DrawingDeps;
	clipboard?: { filePaths(): Promise<string[] | null | undefined>; image(): Promise<Uint8Array | null | undefined>; text(): Promise<string | null | undefined>; saveImage?(bytes: Uint8Array): string };
}


// A running step stays open, so its body is a bounded tail of what it printed: Tern's own `preview` gives way
// inside an open tool, and an unbounded body would push the rest of the turn off screen.
const STEP_LIVE_LINES = 12;
const MAX_PATCH_FILES_SHOWN = 3;

// The last `lines` lines of a live stream, with an explicit count of what is held back (never silently cut).
function tailWindow(text: string, lines: number, dropped = 0): string {
	const body = dropped > 0 ? text.slice(text.indexOf("\n") + 1) : text;
	const all = body.trimEnd().split("\n");
	if (all.length <= lines && dropped === 0) return text;
	const hidden = Math.max(0, all.length - lines) + dropped;
	return `… ${hidden} earlier ${hidden === 1 ? "line" : "lines"}\n${all.slice(-lines).join("\n")}`;
}
const BACKGROUND_WORK_LABEL_CHARS = 80;
const boundedChars = (value: string, limit: number) => { const chars = Array.from(value.replace(/\s+/g, " ").trim()); return chars.length > limit ? `${chars.slice(0, limit - 1).join("")}…` : chars.join(""); };
/** Bash shows its command; a subagent shows its task. Full text stays in the row title. */
const backgroundWorkLabel = (item: RunningWorkItem) => boundedChars(safeWorkText((item.kind === "bash" ? item.detail : `${item.label} · ${item.detail}`).slice(0, 1000)), BACKGROUND_WORK_LABEL_CHARS);
const BACKGROUND_OUTPUT_LINES = 200;
const BACKGROUND_OUTPUT_STEPS = 8;
// While the output view is open its body is re-read on this cadence: output growth does not touch the store.
const BACKGROUND_OUTPUT_REFRESH_MS = 500;
const backgroundWorkLive = (item: RunningWorkItem) => item.status === "queued" || item.status === "running";
/** The output sheet for one background item: live bash output, or a subagent's recent conversation steps. */
export function backgroundWorkOutputNodes(item: RunningWorkItem | undefined): TspNode[] {
	const dismiss: TspNode = { id: "bg-output-dismiss", k: "text", p: { role: "pi.background.dismiss", text: "", grow: 1, min: { w: "100%", h: "100%" }, actions: { click: "bg.close" } } };
	if (!item) return [dismiss, { id: "bg-output", k: "overlay", p: { head: "Background work", size: "lg", role: "pi.background.output" }, c: [
		{ id: "bg-output-gone", k: "text", p: { text: "This work is no longer tracked.", tone: "muted" } },
	] }];
	const live = backgroundWorkLive(item);
	const controls: TspNode[] = [];
	if (live && item.stop) controls.push({ id: "bg-output-stop", k: "text", p: { role: "pi.background.stop", spans: [{ t: "■ Stop", s: "error" }], aria: `Stop ${item.label}`, actions: { click: `bg.stop=${item.id}` } } });
	controls.push({ id: "bg-output-close", k: "text", p: { role: "pi.background.close", spans: [{ t: "Close", s: "muted" }], actions: { click: "bg.close" } } });
	const body: TspNode[] = [
		{ id: "bg-output-controls", k: "row", p: { gap: "md", align: "center" }, c: controls },
		{ id: "bg-output-detail", k: "text", p: { text: item.detail, tone: "muted" } },
	];
	if (item.kind === "subagent") {
		const steps = item.transcriptPath ? readSubagentConversationCached(item.transcriptPath) : undefined;
		if (steps?.length) {
			const shown = steps.slice(-BACKGROUND_OUTPUT_STEPS);
			if (steps.length > shown.length) body.push({ id: "bg-output-earlier", k: "text", p: { text: `… ${steps.length - shown.length} earlier steps`, tone: "muted" } });
			shown.forEach((step, i) => {
				body.push({ id: `bg-output-step-${i}-title`, k: "text", p: { spans: [{ t: step.title, s: "accent" }] } });
				if (step.body) body.push({ id: `bg-output-step-${i}-body`, k: "code", p: { text: step.body, wrap: true } });
			});
		} else body.push({ id: "bg-output-text", k: "code", p: { text: item.output || (live ? "No conversation yet." : "No output."), wrap: true } });
	} else {
		let output = "";
		try { output = (live ? item.readOutput?.() : undefined) ?? item.output ?? ""; } catch { output = item.output ?? ""; }
		body.push({ id: "bg-output-text", k: "code", p: { text: output ? tailWindow(output, BACKGROUND_OUTPUT_LINES) : live ? "(no output yet)" : "(no output)", wrap: true } });
	}
	return [dismiss, { id: "bg-output", k: "overlay", p: { head: `${boundedChars(item.label, BACKGROUND_WORK_LABEL_CHARS)} · ${item.status}`, size: "lg", role: "pi.background.output" }, c: [
		{ id: "bg-output-body", k: "col", p: { gap: "sm" }, c: body },
	] }];
}

export class PiTernBridge {
	#session: PiSessionLike;
	readonly #surface: TernInlineSurface;
	readonly #write: TspWriter;
	readonly #projector = new TranscriptProjector();
	readonly #logo = startupBlob();
	readonly #version = trebolVersion();
	#repo: RepoStatus | undefined;
	#repoLoading = false;
	#repoDirty = false;
	#repoWatch: (() => void) | undefined;
	#repoWatchKey = "";
	#mcpUnsubscribe: (() => void) | undefined;
	readonly #mcpManager: McpController;
	#stepInspector?: { group: string; selected?: string; filter: WorkFilter; search: DraftEditor };
	#workReveal?: string;
	#gitView: { mode: "list" } | { mode: "diff"; ref: GitPanelRef; text: string } | undefined;
	// Bumped on every Git view navigation, session change and close; a diff read lands only if it is still the latest.
	#gitRequest = 0;
	#gitRefs: GitPanelRef[] = [];
	#gitDiffMode: GitDiffMode = "split";
	#gitStyle: GitSidebarStyle = "tree";
	#gitCollapsed = new Set<string>();
	#gitStatus: { text: string; tone: string } | undefined;
	#gitFocus: "summary" | "body" | undefined;
	readonly #gitSummary = new DraftEditor();
	readonly #gitBody = new DraftEditor({ multiline: true });
	#gitAmend = false;
	#gitBusy = false;
	#gitPendingDiscard: string | undefined;
	#gitHelp = false;
	#gitLoading: { section: GitPanelRef["section"]; path: string; promise: Promise<void> } | undefined;
	#gitStyled = false;
	// OMP's `/context` card, opened from the composer's context meter, `/context`, or a click on the panel's hint.
	#contextView = false;
	// The card's own sheet is sent with its first frame, so a session that never opens it pays no startup frame.
	#contextStyled = false;
	// Background item whose output sheet is open, and the timer that keeps its output fresh.
	#workViewId: string | undefined;
	#backgroundPanel = new BackgroundPanel();
	#workViewTimer: ReturnType<typeof setInterval> | undefined;
	readonly #onClose?: () => void;
	readonly #onEventTap?: (event: PiEventLike) => void;
	readonly #onRenderTap?: (nodes: readonly TspNode[], trigger: string, busy: boolean) => void;
	#trigger = "ui";
	readonly #commands: CommandSource;
	readonly #newSession?: () => Promise<{ cancelled?: boolean } | void>;
	readonly #complete: SlashAutocomplete;
	#sessionId: string | undefined;
	readonly #events?: AskEventBus;
	readonly #reload?: () => Promise<{ css: string; pluginStatus: string }>;
	#dialog: TernAskDialog | null = null;
	#btw: TernBtwCard | null = null;
	#reloading = false;
	#unsubscribe: (() => void) | null = null;
	#workUnsubscribe: (() => void) | null = null;
	#busy = false;
	// Wall time of the turn now running, for the composer's own clock; undefined while idle.
	#turnStartedAt: number | undefined;
	#closed = false;
	readonly #editor = new DraftEditor();
	#queuedSteering: string[] = [];
	#queuedFollowUp: string[] = [];
	// Pi's queue holds the mention-expanded text it was sent; the band and Edit show what was typed.
	#queuedTyped = new Map<string, string>();
	#model: string | undefined;
	#modelPickerOpen = false;
	#treePickerOpen = false;
	#treeModel: TreeModel | undefined;
	// The bubble showing its Edit/Resend row, and the edit in progress (nothing in the session changes until send).
	#messageFocus: string | undefined;
	#editing: EditState | undefined;
	#treeVisible: TreeRow[] = [];
	#treeFilter: TreeFilter = DEFAULT_TREE_FILTER;
	#treeQuery = "";
	#treePickerSelected: string | undefined;
	#lastEligibleEscapeAt = 0;
	#modelQuery = "";
	#modelFavorites = loadModelFavorites();
	#collapsedProviders = new Set<string>();
	#modelSelected: string | undefined;
	#modelCatalog: ReadonlyArray<Model<any>> = [];
	#modelCatalogLoading = false;
	#modelCatalogError: string | undefined;
	#modelCatalogRequest = 0;
	#toolOutputExpanded = false;
	readonly #kinds: readonly string[];
	#git: GitFacts | undefined;
	#gitRefreshing = false;
	#gitTimer: ReturnType<typeof setInterval> | undefined;
	#columns = 100;
	readonly #ui: TernExtensionUI;
	readonly #clipboard: NonNullable<BridgeOptions["clipboard"]>;
	readonly #drawing?: DrawingDeps;
	// The live whiteboard preview: the last good cropped canvas, the key it was captured under, and the
	// key after which it is hidden (a Hide click or an attach) until the canvas changes again.
	#drawingPreview?: { blob: { id: string; mime: string; base64: string }; width: number; height: number; shapes: number };
	#drawingKey?: string;
	#drawingHiddenKey?: string;
	#drawingTimer: ReturnType<typeof setTimeout> | undefined;
	#drawingPolling = false;
	// The whiteboard this Pi instance opened, by canvas hash. Another tab's canvas is never adopted: the
	// focused one is only sometimes ours, and with several panes "focused" always names exactly one.
	#drawingOwner?: CanvasOwner;
	// A picture being marked up: the stage occupies the composer slot until it is sent or discarded. The
	// generated sheet places every pin, so it is re-sent only when a mark or the crosshair moves.
	#annotate?: AnnotateSession;
	#annotateCss?: string;
	// Images and files waiting above the composer for the next submit (attachments.ts).
	#attachments: Attachment[] = [];
	#attachmentSeq = 0;

	constructor(session: PiSessionLike, options: BridgeOptions) {
		this.#session = session;
		this.#mcpManager = new McpController({
			host: () => readMcpHost(String(this.#session.sessionManager?.getSessionId?.() ?? "")),
			snapshot: () => ({ tools: this.#session.getAllTools?.() ?? [], active: this.#session.getActiveToolNames?.() ?? [], connected: readMcpStatus(this.#session.sessionManager?.getSessionId?.() as string | undefined)?.connected }),
			reload: async () => {
				if (this.#busy) throw new Error("Wait for the current turn before reloading");
				if (!this.#reload) throw new Error("No reload handler bound");
				const draft = this.#draft;
				this.#mcpManager.close();
				try { await this.submit("/reload"); }
				finally { if (!this.#closed) this.setDraft(draft); }
			},
		}, () => this.#render());
		this.#write = options.write;
		this.#drawing = options.drawing;
		this.#clipboard = options.clipboard ?? {
			...createClipboard({ platform: process.platform, env: process.env, native: getNativeClipboard }),
			saveImage: (bytes) => {
				const path = join(tmpdir(), `pi-clipboard-${randomUUID()}.${imageExtension(bytes)}`);
				writeFileSync(path, bytes);
				return path;
			},
		};
		this.#surface = new TernInlineSurface(options.write, options.surfaceId, options.credits, options.apc);
		this.#onClose = options.onClose;
		this.#onEventTap = options.onEvent;
		this.#onRenderTap = options.onRender;
		this.#commands = options.commands ?? EMPTY_COMMAND_SOURCE;
		this.#newSession = options.newSession;
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
			getDraft: () => this.#editor.expandedText,
			setDraft: (text) => this.setDraft(text),
			// Both native flows own the screen: /btw keeps its custom() alive the same way ask-user does.
			remoteFlowActive: () => Boolean(this.#dialog?.active || this.#btw?.active),
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

	/** One line in the transcript, as an extension `ui.notify` renders; used for shortcut failures. */
	notice(text: string): void {
		if (this.closed) return;
		this.#projector.add("system", text);
		this.#render();
	}

	// One path for the composer's + and /drawing: open the native whiteboard, or attach what is drawn on
	// it. The screenshot is cropped to the canvas pane before it becomes an attachment.
	async #openDrawing(): Promise<void> {
		if (!this.#drawing) {
			this.notice("Drawing needs Tern's desktop whiteboard; this frontend has no canvas control");
			return;
		}
		try {
			const result = await drawingAction(this.#drawing, this.#drawingOwner);
			if (result.owner) this.#drawingOwner = result.owner;
			// A canvas now exists: leave the idle cadence so the preview appears as soon as ink does.
			this.#scheduleDrawingPoll(DRAWING_ACTIVE_MS);
			if (result.status === "attached") {
				this.attachPaths([result.path]);
				this.notice(`Attached drawing (${result.width}×${result.height}, ${result.shapes} ${result.shapes === 1 ? "shape" : "shapes"})${result.source === "document" ? " rendered from the canvas document (screenshot unavailable)" : " from the whiteboard"}${result.textOmitted ? "; text labels are outlined, not lettered" : ""}`);
			} else if (result.status === "opened") {
				this.notice("Whiteboard opened beside this pane — sketch away; a live preview with an Attach drawing button appears in the composer.");
			} else {
				this.notice("Whiteboard ready — sketch something and the composer preview attaches it.");
			}
		} catch (error) {
			this.notice(`drawing failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	#scheduleDrawingPoll(ms: number): void {
		clearTimeout(this.#drawingTimer);
		this.#drawingTimer = setTimeout(() => void this.#pollDrawing(), ms);
	}

	/**
	 * The newest previewable picture in the transcript becomes the annotation stage. The bytes are read
	 * from its path: restored previews keep their blob id but drop the base64 payload, and the original
	 * file is the only honest source for the overlay copy.
	 */
	#openAnnotate(ref?: { itemId: string; index: number }): void {
		// A card's Mark up action names its own preview; the command takes the newest one.
		if (ref) {
			const preview = this.#projector.item(ref.itemId)?.artifacts?.[ref.index];
			if (preview && this.#startAnnotate(preview)) return;
		}
		const items = [...this.#projector.items];
		for (let i = items.length - 1; i >= 0; i--) {
			const previews = items[i].artifacts ?? [];
			for (let j = previews.length - 1; j >= 0; j--) {
				if (this.#startAnnotate(previews[j])) return;
			}
		}
		this.notice("No previewable picture in this session yet — ask the agent for a PNG or SVG first");
	}

	/** Opens one preview on the stage. False when the file or the blob is gone, so the caller can try another. */
	#startAnnotate(preview: ArtifactPreview): boolean {
		if (!preview.blob || !preview.blob.mime.startsWith("image/")) return false;
		let bytes: Buffer;
		try {
			bytes = readFileSync(preview.path);
		} catch {
			return false;
		}
		this.#annotate = annotateSession(preview.blob.id, preview.name, preview.path, preview.blob.mime, bytes);
		this.#annotateCss = undefined;
		this.#render();
		this.notice("Mark the picture: click or use the arrows, Enter pins, type the note, then Send.");
		return true;
	}

	/**
	 * Sends the marks the two ways they are useful: a copy of the picture with numbered discs (what the
	 * model sees) and the coordinate/note payload (what it can act on). The copy is attached, not sent, so
	 * the user still owns the message. A format this machine cannot decode still gets its coordinates and
	 * says so instead of pretending an unmarked picture carries the marks.
	 */
	async #sendAnnotate(): Promise<void> {
		const session = this.#annotate;
		if (!session || this.#closed) return;
		if (session.marks.length === 0) {
			this.notice("No marks yet — place a pin, then send");
			return;
		}
		const count = session.marks.length;
		let attached: string | undefined;
		if (session.source.decodable) {
			try {
				const png = annotatePng(readFileSync(session.source.path), session.marks);
				if (png) {
					// The session's workspace is where the annotated copies belong; the drawing workspace is
					// only a second opinion when the frontend did not provide the session cwd.
					const workspace = this.#session.sessionManager?.getCwd?.() ?? this.#drawing?.workspace ?? process.cwd();
					const dir = join(workspace, "artifacts", "annotations");
					mkdirSync(dir, { recursive: true });
					const file = join(dir, `${session.source.name.replace(/\.[^.]+$/, "")}-annotated-${Date.now().toString(36)}.png`);
					writeFileSync(file, png);
					this.attachPaths([file]);
					attached = file;
				}
			} catch (error) {
				this.notice(`marked copy failed, sending coordinates only: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		// The path travels in the text as well as the chip, so a model that cannot take the image (or a
		// chip whose blob never connected) can still open the marked copy by path.
		const payload = annotatePayload(session, attached ? this.#shownPath(attached) : undefined);
		// Close the card first, so the composer that receives the payload is the one on screen.
		this.#annotate = undefined;
		this.#annotateCss = undefined;
		const body = this.#draft.trimEnd();
		this.setDraft(`${body}${body ? "\n\n" : ""}${payload}\n`);
		this.#render();
		this.notice(attached
			? `Attached the marked picture and ${count} mark${count === 1 ? "" : "s"} with coordinates`
			: `Added ${count} mark${count === 1 ? "" : "s"} with coordinates; ${session.source.mime} has no overlay copy here`);
	}

	/** A Mermaid diagram is text: its source is the editable form, and the composer is the editor. */
	#openDiagram(): void {
		const fence = /```mermaid[ \t]*\r?\n([\s\S]*?)```/i;
		const items = [...this.#projector.items];
		for (let i = items.length - 1; i >= 0; i--) {
			const item = items[i];
			if (item.role !== "assistant") continue;
			const match = fence.exec(item.text);
			if (!match) continue;
			this.setDraft(`Revise this Mermaid diagram. Keep everything I did not touch, and say what changed in one line.\n\n\`\`\`mermaid\n${match[1].trim()}\n\`\`\`\n\nChange: `);
			this.notice("The diagram source is in the composer — edit it, then send");
			return;
		}
		this.notice("No Mermaid diagram in the transcript yet");
	}

	/**
	 * The composer's live whiteboard preview: re-captured only when *our* canvas's ink or camera changes
	 * (previewKey), cropped to that canvas pane, never stealing focus. Another pane's canvas is never
	 * previewed, and a capture that fails keeps the last good frame; the next poll retries.
	 */
	async #pollDrawing(): Promise<void> {
		if (!this.#drawing || this.#drawingPolling || this.#closed) return;
		this.#drawingPolling = true;
		try {
			const state = await this.#drawing.ctl(["state"]);
			// Our canvas only. If it is gone the user closed that tab; clear rather than preview another.
			const canvas = canvasControlAvailable(state) ? resolveOwned(state, this.#drawingOwner) : undefined;
			if (canvas === undefined && this.#drawingOwner !== undefined) {
				this.#drawingOwner = undefined;
				this.#drawingPreview = undefined;
				this.#drawingKey = undefined;
				this.#drawingHiddenKey = undefined;
				this.#render();
			}
			const drawn = canvas !== undefined && Number(canvas.shapes ?? 0) > 0 ? canvas : undefined;
			const key = previewKey(drawn);
			if (key === undefined) {
				// Nothing drawn anywhere: idle. Clear on the transition only, so an idle poll never repaints.
				this.#scheduleDrawingPoll(DRAWING_IDLE_MS);
				if (this.#drawingPreview !== undefined || this.#drawingKey !== undefined) {
					this.#drawingPreview = undefined;
					this.#drawingKey = undefined;
					this.#drawingHiddenKey = undefined;
					this.#render();
				}
				return;
			}
			this.#scheduleDrawingPoll(DRAWING_ACTIVE_MS);
			if (this.#drawingHiddenKey !== undefined) {
				if (key === this.#drawingHiddenKey) return; // hidden after Hide or Attach; the next stroke brings it back
				this.#drawingHiddenKey = undefined;
			}
			if (key === this.#drawingKey && this.#drawingPreview !== undefined) return; // settled canvas
			const preview = await capturePreview(this.#drawing, drawn);
			if (!preview.ok) return;
			const blob = { id: createHash("sha256").update(preview.bytes).digest("hex"), mime: "image/png", base64: preview.bytes.toString("base64") };
			// The blob precedes the frame that references it, as with artifact previews.
			for (const chunk of encodeTspBlob(blob.id, blob.mime, blob.base64)) this.#write(chunk);
			this.#drawingKey = key;
			this.#drawingPreview = { blob, width: preview.width, height: preview.height, shapes: preview.shapes };
			this.#render();
		} catch {
			// A failed poll (Tern restarting, a control error) retries on the next tick, quietly.
			this.#scheduleDrawingPoll(DRAWING_ACTIVE_MS);
		} finally {
			this.#drawingPolling = false;
		}
	}

	/** Hides the preview until the canvas changes again; the next stroke brings it back. */
	#hideDrawingPreview(): void {
		if (this.#drawingPreview === undefined && this.#drawingKey === undefined) return;
		this.#drawingHiddenKey = this.#drawingKey;
		this.#drawingPreview = undefined;
		this.#render();
	}

	/** The preview's Attach control: capture the focused canvas and add it as a normal image attachment. */
	async #sendDrawing(): Promise<void> {
		if (!this.#drawing || this.#closed) return;
		try {
			const state = await this.#drawing.ctl(["state"]);
			const canvas = canvasControlAvailable(state) ? resolveOwned(state, this.#drawingOwner) : undefined;
			if (!canvas || Number(canvas.shapes ?? 0) < 1) {
				this.notice(this.#drawingOwner === undefined
					? "Nothing is drawn yet — sketch on the whiteboard, then attach"
					: "That whiteboard is gone (its tab was closed) — run /drawing to open a new one");
				return;
			}
			if (this.#attachments.length >= ATTACHMENT_LIMITS.maxAttachments) {
				this.notice(`Attachment limit reached (${ATTACHMENT_LIMITS.maxAttachments}); remove one first`);
				return;
			}
			const result = await captureCanvas(this.#drawing, canvas);
			if (result.status !== "attached") {
				this.notice(result.status === "empty" ? "The whiteboard is empty — nothing to attach" : "The whiteboard is not focused; click its pane, then attach");
				return;
			}
			// Write the file's path into the composer before anything can fail to attach: the drawing is on
			// disk either way, and a path the agent can read is the fallback when the image does not connect.
			this.#appendPath("Drawing", result.path);
			const attachment = loadAttachment(result.path, this.#attachmentSeq + 1);
			if (!attachment) {
				this.notice("The drawing capture could not be attached; its path is in the composer so the agent can still read it");
				return;
			}
			this.#attachmentSeq++;
			if (attachment.blob) for (const chunk of encodeTspBlob(attachment.blob.id, attachment.blob.mime, attachment.blob.base64)) this.#write(chunk);
			this.#attachments.push(attachment);
			// The chip now carries the drawing; the preview yields until the next stroke changes it.
			this.#drawingHiddenKey = this.#drawingKey;
			this.#drawingPreview = undefined;
			this.notice(`Attached drawing (${result.width}×${result.height}, ${result.shapes} ${result.shapes === 1 ? "shape" : "shapes"})${result.source === "document" ? ", rendered from the canvas document" : ""} — it goes with your next message${result.textOmitted ? " (text labels are outlined)" : ""}`);
			this.#render();
		} catch (error) {
			this.notice(`drawing failed: ${error instanceof Error ? error.message : String(error)}`);
		}
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

	// The draft with large-paste markers expanded; this is what a submit sends.
	get expandedDraft(): string {
		return this.#editor.expandedText;
	}

	get #draft(): string {
		return this.#editor.text;
	}

	set #draft(text: string) {
		this.#editor.setText(text);
	}

	get items(): readonly Item[] {
		return this.#projector.items;
	}

	// Pi replaces the session on resume and similar switches; the bridge follows the replacement.
	rebind(session: PiSessionLike): void {
		if (this.#workViewId !== undefined) this.#closeWorkView();
		this.#stepInspector = undefined;
		if (this.#mcpManager.open) this.#mcpManager.close();
		this.#unsubscribe?.();
		this.#session = session;
		this.#unsubscribe = session.subscribe((event) => this.#onEvent(event));
		// The transcript follows the session: a resumed one is rebuilt from its persisted branch (JSONL),
		// a new one starts empty.
		const branch = session.sessionManager?.getBranch?.();
		this.#projector.replaceFromSessionBranch(Array.isArray(branch) ? branch : []);
		this.#busy = false;
		this.#syncSession();
		this.#refreshGit();
		this.#render();
	}

	start(title = "pi"): void {
		this.#surface.open(title);
		this.#surface.stylesheet("composer", PI_COMPOSER_CSS);
		this.#surface.stylesheet("work", TERN_WORK_CSS);
		this.#surface.stylesheet("markdown", TERN_MARKDOWN_CSS);
		// An ask flow can open before any panel does, so its sheet is up front: the card must be solid on the
		// first frame it draws, not after some later feature registers a sheet (ask-style.ts).
		this.#surface.stylesheet("ask", PI_ASK_CSS);
		// The blob precedes any frame that references it, as with artifact previews.
		for (const chunk of encodeTspBlob(this.#logo.id, this.#logo.mime, this.#logo.base64)) this.#write(chunk);
		this.#loadRepo();
		// A runner that reopened an existing session starts on a persisted branch: seed the transcript
		// before the first frame, or a resumed pane would come back with an empty main region. A fresh
		// session has an empty branch, so this costs nothing there.
		const branch = this.#session.sessionManager?.getBranch?.();
		this.#projector.replaceFromSessionBranch(Array.isArray(branch) ? branch : []);
		this.#unsubscribe = this.#session.subscribe((event) => this.#onEvent(event));
		this.#workUnsubscribe?.();
		this.#workUnsubscribe = onRunningWorkChange(() => this.#render());
		this.#mcpUnsubscribe?.();
		this.#mcpUnsubscribe = subscribeMcpStatus(() => this.#render());
		if (this.#events) {
			this.#dialog = new TernAskDialog(this.#events, () => this.#render());
			this.#dialog.start();
			// /btw publishes snapshots on the same bus; the card takes the composer slot while it is open.
			this.#btw = new TernBtwCard(this.#events, () => this.#render());
		}
		this.#syncSession();
		this.#refreshGit();
		this.#gitTimer = setInterval(() => this.#refreshGit(), GIT_STATUS_TTL_MS);
		// The whiteboard preview follows the live canvas on its own cadence: the first poll is eager, so a
		// canvas already drawn in this window surfaces promptly; nothing left to watch idles down to slow.
		if (this.#drawing) this.#scheduleDrawingPoll(DRAWING_ACTIVE_MS);
		this.#render();
	}

	// Resets per-session state when Pi's active session changes.
	#syncSession(): void {
		const id = sessionIdOf(this.#session);
		if (id === this.#sessionId) return;
		this.#sessionId = id;
		this.#gitRequest++;
		if (this.#workViewId !== undefined) this.#closeWorkView();
		if (this.#mcpManager.open) this.#mcpManager.close();
	}

	// Sends picture blobs before re-rendering, so no frame references a blob Tern has not received.
	async #previewArtifacts(event: PiEventLike): Promise<void> {
		const name = String(event.toolName);
		const args = (this.#projector.callItem(String(event.toolCallId))?.args ?? {}) as Record<string, unknown>;
		const cwd = this.#session.sessionManager?.getCwd?.() ?? process.cwd();
		const paths = name === "Read"
			? [typeof args.file_path === "string" ? args.file_path : undefined]
			: name === "apply_patch" ? patchArtifactPaths(args.input) : [];
		const previews: ArtifactPreview[] = [];
		for (const raw of paths) {
			if (!raw) continue;
			const preview = await previewFile(isAbsolute(raw) ? raw : resolve(cwd, raw), cwd);
			if (preview) previews.push(preview);
		}
		if (previews.length === 0 || this.#closed) return;
		const item = this.#projector.callItem(String(event.toolCallId));
		if (!item) return;
		for (const preview of previews) {
			if (!preview.blob) continue;
			for (const chunk of encodeTspBlob(preview.blob.id, preview.blob.mime, preview.blob.base64)) this.#write(chunk);
		}
		// Tern holds each blob once sent; nodes reference it by id, so the bytes need not stay on the item.
		item.artifacts = previews.map((preview) => (preview.blob ? { ...preview, blob: { ...preview.blob, base64: "" } } : preview));
		this.#render();
	}

	#onEvent(event: PiEventLike): void {
		if (this.#closed) return;
		this.#onEventTap?.(event);
		if (event.type === "session_tree") {
			const branch = this.#session.sessionManager?.getBranch?.();
			if (Array.isArray(branch)) this.#projector.replaceFromSessionBranch(branch);
			this.#messageFocus = undefined;
		}
		if (event.type === "queue_update") {
			this.#queuedSteering = Array.isArray(event.steering) ? event.steering.filter((text): text is string => typeof text === "string") : [];
			this.#queuedFollowUp = Array.isArray(event.followUp) ? event.followUp.filter((text): text is string => typeof text === "string") : [];
			if (!this.#queuedSteering.length && !this.#queuedFollowUp.length) this.#queuedTyped.clear();
		}
		if (event.type === "agent_start") {
			this.#busy = true;
			this.#turnStartedAt = Date.now();
		}
		if (event.type === "agent_settled" || event.type === "agent_end") {
			// agent_end ends an attempt, not the session's retry/compaction/settlement work.
			this.#busy = event.type === "agent_settled" ? false : (this.#session.isStreaming ?? false);
			this.#refreshGit();
		}
		if (event.type === "model_select") {
			this.#model = modelDisplayName(event.model) ?? this.#model;
			this.#modelCatalog = this.#session.modelRuntime?.getAvailableSnapshot() ?? this.#modelCatalog;
		}
		if (event.type === "tool_execution_end" && event.isError !== true) void this.#previewArtifacts(event);
		if (this.#projector.apply(event) || event.type.startsWith("agent_") || event.type === "model_select" || event.type === "thinking_level_changed" || event.type === "queue_update" || event.type === "session_tree") {
			this.#trigger = event.type;
			this.#render();
			this.#trigger = "ui";
		}
	}

	// OMP's composer (composer-view.ts) fed by Pi: context window and compaction point, model, thinking
	// level, git status of Pi's cwd, session cost. OMP's tok/s, focus crumbs and shell mode have no Pi source.
	#dock(): TspNode[] {
		// An open ask or /btw flow takes over the input slot: its inline card replaces the composer.
		if (this.#annotate) return annotateNodes(this.#annotate);
		if (this.#dialog?.active) return this.#dialog.nodes(this.#columns);
		if (this.#btw?.active) return this.#btw.nodes();
		// Tern-only affordance: the bar draws ctrl+b as a button only while that chord would really move work
		// off the turn — one foreground item is live and a writer published its detach.
		const backgroundable = hasRunningWorkDetach()
			&& runningWorkSnapshot().some((item) => (item.status === "queued" || item.status === "running") && item.foreground === true);
		const usage = contextUsageOf(this.#session) as { tokens?: unknown; contextWindow?: unknown } | undefined;
		const window = typeof usage?.contextWindow === "number" && usage.contextWindow > 0 ? usage.contextWindow : undefined;
		const tokens = typeof usage?.tokens === "number" && Number.isFinite(usage.tokens) ? usage.tokens : null;
		const compactAt = window !== undefined ? compactionPercent(this.#session, window) : undefined;
		const typed = (text: string) => this.#queuedTyped.get(text) ?? text;
		const queue = queueNodes(queueGroups(this.#queuedSteering.map(typed), this.#queuedFollowUp.map(typed)));
		return [...queue, ...this.#ui.widgetNodes("aboveEditor"), ...composerNodes({
			draft: this.#draft,
			cursor: this.#editor.cursor,
			anchor: this.#editor.anchor,
			sendable: this.#composerSendable(),
			ghost: this.#complete.ghost,
			busy: this.#busy,
			// Tern counts this on from the value it receives, so the turn clock needs no frame per second.
			...(this.#busy && this.#turnStartedAt !== undefined ? { turnAgeMs: Math.max(0, Date.now() - this.#turnStartedAt) } : {}),
			queuedFollowUp: this.#queuedFollowUp.length,
			context: window !== undefined ? { tokens, window, ...(compactAt !== undefined ? { compactAt } : {}) } : undefined,
			model: modelDisplayName(this.#session.model) ?? this.#model,
			modelSelectable: Boolean(this.#session.modelRuntime && this.#session.setModel),
			thinking: thinkingOf(this.#session),
			effortKind: this.#kinds.includes("effort"),
			git: this.#git,
			work: this.#workFacts(),
			cost: costOf(this.#session),
			backgroundable,
			// A phone-width bar gives Send a real touch target and keeps secondary facts from crowding it.
			compact: this.#columns < 56,
			...(this.#attachments.length ? { chips: attachmentChips(this.#attachments) } : {}),
			// The live whiteboard row sits above the chips; hidden after an attach or a Hide until the canvas changes.
			...(this.#drawingPreview && this.#drawingHiddenKey === undefined
				? { drawing: { shapes: this.#drawingPreview.shapes, image: { blob: this.#drawingPreview.blob.id, width: this.#drawingPreview.width, height: this.#drawingPreview.height } } }
				: {}),
			// A live Pi Voice take publishes an amplitude meter; the composer draws it on the editor.
			wave: this.#ui.meterFacts(),
		}, this.#editing ? [editingBanner(this.#editing)] : []), ...this.#ui.widgetNodes("belowEditor")];
	}

	// The bar's facts are clickable in OMP (it opens panels). The context meter opens OMP's own context card
	// (`#openContextView`); the rest state the same real fact in the transcript, since Pi has no such panel.
	#statusFact(act: string): string | undefined {
		if (act === "status.model") return `model: ${modelDisplayName(this.#session.model) ?? this.#model ?? "none"} (use /model to switch)`;
		if (act === "status.cost") {
			const cost = costOf(this.#session);
			return cost === undefined ? "session cost unknown" : `session cost $${cost.toFixed(4)}`;
		}
		return undefined;
	}

	// OMP's git segment re-reads status on a 10 s TTL and after turns, so edits made outside Pi show up too.
	// The startup card shows the directory as it was when the bridge started.
	// Re-reads the startup card's git state when the watcher fires. A change that arrives during a read is re-read after it.
	#loadRepo(): void {
		if (this.#closed) return;
		if (this.#repoLoading) { this.#repoDirty = true; return; }
		this.#repoLoading = true;
		const cwd = this.#session.sessionManager?.getCwd?.() ?? process.cwd();
		void readRepoStatus(cwd).then((repo) => {
			this.#repoLoading = false;
			if (this.#closed) return;
			this.#watchRepo(repo);
			if (JSON.stringify(repo) !== JSON.stringify(this.#repo)) {
				this.#repo = repo;
				if (this.#gitView?.mode === "diff") void this.#showGitDiff(this.#gitView.ref.section, this.#gitView.ref.entry.path);
				this.#render();
			}
			if (this.#repoDirty) {
				this.#repoDirty = false;
				this.#loadRepo();
			}
		});
	}

	#watchRepo(repo: RepoStatus): void {
		const key = repo.git ? `${repo.root}|${repo.gitDir ?? ""}` : "";
		if (key === this.#repoWatchKey) return;
		this.#repoWatch?.();
		this.#repoWatch = repo.git ? watchRepo(repo.root, repo.gitDir, () => this.#loadRepo()) : undefined;
		this.#repoWatchKey = key;
	}

	// The status overlay: a list of changed files, then one file's diff. Clicks carry indexes into the list last rendered.
	#openWorkView(id: string): void {
		if (id !== "all" && !runningWorkSnapshot().some((item) => item.id === id)) return;
		this.#workViewId = id;
		this.#backgroundPanel.select(id === "all" ? undefined : id);
		clearInterval(this.#workViewTimer);
		this.#workViewTimer = setInterval(() => {
			if (this.#backgroundPanel.follow) this.#render();
		}, BACKGROUND_OUTPUT_REFRESH_MS);
		this.#workViewTimer.unref?.();
		this.#render();
	}

	#closeWorkView(): void {
		clearInterval(this.#workViewTimer);
		this.#workViewTimer = undefined;
		this.#workViewId = undefined;
		this.#backgroundPanel = new BackgroundPanel();
		this.#render();
	}

	// Stops only work that is still running and still offers a stop; the writer then settles the item in the store.
	#stopWork(id: string): void {
		const item = runningWorkSnapshot().find((entry) => entry.id === id);
		if (!item || !backgroundWorkLive(item) || !item.stop) return;
		if (this.#backgroundPanel.stopping.has(id)) return;
		this.#backgroundPanel.stopping.add(id);
		try { item.stop(); } catch (error) {
			this.#backgroundPanel.stopping.delete(id);
			this.#backgroundPanel.stopError = "Could not request stop. The work may still be running; retry or inspect its runtime status.";
		}
		this.#render();
	}

	#openGitView(): void {
		if (!this.#repo?.git) return;
		if (!this.#gitStyled) {
			this.#gitStyled = true;
			this.#surface.stylesheet("git", PI_GIT_CSS);
		}
		this.#gitRequest++;
		this.#gitView = { mode: "list" };
		this.#gitFocus = undefined;
		this.#gitStatus = undefined;
		this.#gitHelp = false;
		this.#gitAmend = false;
		this.#gitSummary.setText("");
		this.#gitBody.setText("");
		this.#gitRefs = gitPanelRefs(this.#repo);
		const first = this.#gitRefs[0];
		if (first) void this.#showGitDiff(first.section, first.entry.path);
		else this.#render();
	}

	#gitPanelRefs(): GitPanelRef[] {
		return this.#repo?.git ? gitPanelRefs(this.#repo) : [];
	}

	// OMP's `/context` card, off the same facts its composer meter draws: Pi's provider-reported total and
	// window, the live system prompt and tool roster, and Pi's own compaction reserve as the threshold.
	#openContextView(): void {
		if (!this.#contextStyled) {
			this.#contextStyled = true;
			this.#surface.stylesheet("context", PI_CONTEXT_CSS);
		}
		this.#contextView = true;
		this.#render();
	}

	#closeContextView(): void {
		if (!this.#contextView) return;
		this.#contextView = false;
		this.#render();
	}

	#contextNodes(): TspNode[] {
		const usage = contextUsageOf(this.#session) as { contextWindow?: unknown } | undefined;
		const window = typeof usage?.contextWindow === "number" ? usage.contextWindow : 0;
		const percentAt = window > 0 ? compactionPercent(this.#session, window) : undefined;
		const thresholdTokens = percentAt === undefined ? undefined : (window * percentAt) / 100;
		return [contextDismissNode(), ...contextPanelNodes(readContextBreakdown(this.#session, { thresholdTokens }))];
	}

	#showGitDiff(section: GitPanelRef["section"], path: string): Promise<void> {
		const repo = this.#repo;
		if (!repo?.git) return Promise.resolve();
		const refs = this.#gitPanelRefs();
		const ref = refs.find((r) => r.section === section && r.entry.path === path) ?? refs.find((r) => r.entry.path === path);
		if (!ref) {
			this.#gitRequest++;
			this.#gitView = { mode: "list" };
			this.#render();
			return Promise.resolve();
		}
		this.#gitRefs = refs;
		if (this.#gitLoading && this.#gitLoading.section === ref.section && this.#gitLoading.path === ref.entry.path) return this.#gitLoading.promise;
		const request = ++this.#gitRequest;
		const current = () => !this.#closed && request === this.#gitRequest;
		// The diff node is added only with its text: a later text update to an existing diff node is not applied by Tern.
		const read = ref.section === "commit" ? readCommitDiff(repo.root, ref.entry.path) : readFileDiff(repo.root, ref.entry, ref.section as GitSection);
		const promise = read.then(
			(text) => {
				if (this.#gitLoading?.promise === promise) this.#gitLoading = undefined;
				if (!current()) return;
				this.#gitView = { mode: "diff", ref, text };
				this.#render();
			},
			() => {
				if (this.#gitLoading?.promise === promise) this.#gitLoading = undefined;
				if (!current()) return;
				this.#gitView = { mode: "diff", ref, text: "Diff unavailable." };
				this.#render();
			},
		);
		this.#gitLoading = { section: ref.section, path: ref.entry.path, promise };
		return promise;
	}

	#gitSelected(): GitPanelRef | undefined {
		return this.#gitView?.mode === "diff" ? this.#gitView.ref : undefined;
	}

	#gitMoveSelection(delta: 1 | -1): undefined {
		const refs = this.#gitPanelRefs();
		if (!refs.length) return undefined;
		const current = this.#gitSelected();
		const at = current ? refs.findIndex((ref) => ref.section === current.section && ref.entry.path === current.entry.path) : -1;
		const next = at < 0 ? (delta > 0 ? 0 : refs.length - 1) : (at + delta + refs.length) % refs.length;
		void this.#showGitDiff(refs[next].section, refs[next].entry.path);
		return undefined;
	}

	#gitAct(act: string, value?: string): Promise<void> | undefined {
		const rest = act.slice("git.".length);
		const at = rest.indexOf("=");
		const name = at < 0 ? rest : rest.slice(0, at);
		const arg = at < 0 ? value : rest.slice(at + 1);
		switch (name) {
			case "file": {
				const index = Number(arg);
				const ref = this.#gitPanelRefs()[index];
				return ref ? this.#showGitDiff(ref.section, ref.entry.path) : undefined;
			}
			case "toggle": {
				if (!arg) return undefined;
				if (this.#gitCollapsed.has(arg)) this.#gitCollapsed.delete(arg);
				else this.#gitCollapsed.add(arg);
				this.#render();
				return undefined;
			}
			case "fold.unstaged":
			case "fold.staged":
				return this.#gitAct(`git.toggle=section:${name.slice(5)}`);
			case "mode":
				if (arg === "unified" || arg === "split") this.#gitDiffMode = arg;
				this.#render();
				return undefined;
			case "style":
				if (arg === "path" || arg === "tree") this.#gitStyle = arg;
				this.#render();
				return undefined;
			case "focus.summary":
				this.#gitFocus = "summary";
				this.#render();
				return undefined;
			case "focus.body":
				this.#gitFocus = "body";
				this.#render();
				return undefined;
			case "prev":
				this.#gitMoveSelection(-1);
				return undefined;
			case "next":
				this.#gitMoveSelection(1);
				return undefined;
			case "help":
				this.#gitHelp = !this.#gitHelp;
				this.#render();
				return undefined;
			case "back":
				this.#gitRequest++;
				this.#gitHelp = false;
				this.#gitFocus = undefined;
				this.#gitStatus = undefined;
				this.#gitView = { mode: "list" };
				this.#render();
				return undefined;
			case "close":
				this.#gitRequest++;
				this.#gitView = undefined;
				this.#gitHelp = false;
				this.#gitFocus = undefined;
				this.#gitStatus = undefined;
				this.#render();
				return undefined;
			case "stage":
			case "unstage": {
				const ref = this.#gitSelected();
				if (!ref || ref.section === "commit") return undefined;
				return this.#gitStageRef(ref, name === "stage");
			}
			case "stageAll":
				return this.#gitStageAll(true);
			case "unstageAll":
				return this.#gitStageAll(false);
			case "discard": {
				const ref = this.#gitSelected();
				return ref ? this.#gitDiscardRef(ref) : undefined;
			}
			case "amend":
				this.#gitAmend = !this.#gitAmend;
				if (this.#gitAmend && this.#repo?.git && this.#repo.head && !this.#gitSummary.text && !this.#gitBody.text) {
					this.#gitSummary.setText(this.#repo.head.subject);
					this.#gitBody.setText(this.#repo.head.body);
				}
				this.#render();
				return undefined;
			case "commit":
				return this.#gitCommit();
			default:
				return undefined;
		}
	}

	#gitStageRef(ref: GitPanelRef, stage: boolean): Promise<void> {
		const repo = this.#repo;
		if (!repo?.git) return Promise.resolve();
		this.#gitBusy = true;
		this.#render();
		const run = stage ? stagePaths(repo.root, [ref.entry.path]) : unstagePaths(repo.root, [ref.entry.path]);
		return run.then((error) => {
			this.#gitBusy = false;
			this.#gitStatus = error
				? { text: error.replace(/\s+/g, " ").trim(), tone: "error" }
				: { text: `${stage ? "Staged" : "Unstaged"} ${ref.entry.path}`, tone: "success" };
			this.#loadRepo();
			this.#render();
		});
	}

	#gitStageAll(stage: boolean): Promise<void> {
		const repo = this.#repo;
		if (!repo?.git) return Promise.resolve();
		const paths = repo.snapshot.entries.filter((entry) => (stage ? true : entry.staged)).map((entry) => entry.path);
		if (!paths.length) {
			this.#gitStatus = { text: stage ? "Nothing to stage" : "Nothing staged", tone: "warning" };
			this.#render();
			return Promise.resolve();
		}
		this.#gitBusy = true;
		this.#render();
		const run = stage ? stagePaths(repo.root, paths) : unstagePaths(repo.root, paths);
		return run.then((error) => {
			this.#gitBusy = false;
			this.#gitStatus = error
				? { text: error.replace(/\s+/g, " ").trim(), tone: "error" }
				: { text: stage ? "Staged all changes" : "Unstaged all changes", tone: "success" };
			this.#loadRepo();
			this.#render();
		});
	}

	#gitDiscardRef(ref: GitPanelRef): Promise<void> {
		const repo = this.#repo;
		if (!repo?.git || ref.section === "commit") return Promise.resolve();
		const key = `${ref.section}:${ref.entry.path}`;
		if (this.#gitPendingDiscard !== key) {
			this.#gitPendingDiscard = key;
			this.#gitStatus = { text: `Discard changes to ${ref.entry.path}? Click Discard again to confirm`, tone: "warning" };
			this.#render();
			return Promise.resolve();
		}
		this.#gitPendingDiscard = undefined;
		this.#gitBusy = true;
		this.#render();
		return discardPaths(repo.root, [ref.entry]).then((error) => {
			this.#gitBusy = false;
			this.#gitStatus = error
				? { text: error.replace(/\s+/g, " ").trim(), tone: "error" }
				: { text: `Discarded ${ref.entry.path}`, tone: "success" };
			this.#loadRepo();
			this.#render();
		});
	}

	#gitCommit(): Promise<void> {
		const repo = this.#repo;
		if (!repo?.git) return Promise.resolve();
		const summary = this.#gitSummary.text.trim();
		const body = this.#gitBody.expandedText.trim();
		if (!summary && body) {
			this.#gitStatus = { text: "Write a commit summary first", tone: "warning" };
			this.#render();
			return Promise.resolve();
		}
		const stageAll = repo.snapshot.entries.every((entry) => !entry.staged) && !this.#gitAmend;
		const message = body ? `${summary}\n\n${body}` : summary;
		if (!message && !this.#gitAmend) {
			this.#gitStatus = { text: "Nothing to commit", tone: "warning" };
			this.#render();
			return Promise.resolve();
		}
		this.#gitBusy = true;
		this.#render();
		return commitIndex(repo.root, message || repo.head?.subject || "Amend commit", { amend: this.#gitAmend, stageAll }).then((error) => {
			this.#gitBusy = false;
			if (error) this.#gitStatus = { text: error.replace(/\s+/g, " ").trim(), tone: "error" };
			else {
				this.#gitStatus = { text: this.#gitAmend ? "Amended commit" : "Created commit", tone: "success" };
				this.#gitSummary.setText("");
				this.#gitBody.setText("");
				this.#gitAmend = false;
				this.#gitFocus = undefined;
			}
			this.#loadRepo();
			this.#render();
		});
	}

	#refreshGit(): void {
		const cwd = this.#session.sessionManager?.getCwd?.();
		if (!cwd || this.#gitRefreshing) return;
		this.#gitRefreshing = true;
		void readGitFacts(cwd).then((git) => {
			this.#gitRefreshing = false;
			if (this.#closed || JSON.stringify(git) === JSON.stringify(this.#git)) return;
			this.#git = git;
			this.#render();
		}, () => {
			// A failed read must not leave the guard set, or git facts would freeze for the rest of the pane's life.
			this.#gitRefreshing = false;
		});
	}

	// Overlays float above `main` and `dock`. The ask flow is not here: it renders inline in `dock`.
	// The slash autocomplete is OMP's caret-anchored list; keys stay
	// in the editor and the bridge routes ↑/↓, Tab, Enter and Esc to it.
	#layer(): TspNode[] {
		if (this.#stepInspector) {
			const v = this.#stepInspector;
			return workInspectorNodes(v.group, this.#projector.groupItems(v.group), v.selected, v.search.text, v.search.cursor, v.filter, this.#columns);
		}
		if (this.#mcpManager.open) return [...mcpPanelNodes(this.#mcpManager, this.#columns), ...(this.#ui.active ? this.#ui.nodes() : [])];
		if (this.#workViewId !== undefined) return this.#backgroundPanel.nodes(this.#backgroundItems(), this.#columns);
		if (this.#contextView) return this.#contextNodes();
		if (this.#gitView && this.#repo?.git) {
			// The dismiss layer sits under the card, so a click outside the card closes the view.
			const dismiss = gitDismissNode();
			this.#gitRefs = gitPanelRefs(this.#repo);
			const panel = gitPanelNodes(
				this.#repo,
				{
					selected: this.#gitView.mode === "diff" ? this.#gitView.ref : undefined,
					diffText: this.#gitView.mode === "diff" ? this.#gitView.text : undefined,
					diffMode: this.#gitDiffMode,
					style: this.#gitStyle,
					collapsed: this.#gitCollapsed,
					status: this.#gitStatus,
					summary: this.#gitSummary.text,
					body: this.#gitBody.expandedText,
					amend: this.#gitAmend,
					focus: this.#gitFocus,
					busy: this.#gitBusy,
				},
				this.#columns,
			);
			return this.#gitHelp ? [dismiss, panel, gitHelpNodes()] : [dismiss, panel];
		}
		if (this.#ui.active) return this.#ui.nodes();
		if (this.#treePickerOpen) return [this.#treePickerNode()];
		if (this.#modelPickerOpen) return [this.#modelPickerNode()];
		return this.#complete.nodes();
	}

	#treePickerNode(): TspNode {
		const { node, visible } = sessionTreePickerNode(this.#treeModel ?? { rows: [], forkCount: 0, turnCount: 0 }, {
			filter: this.#treeFilter, query: this.#treeQuery, selected: this.#treePickerSelected,
			sessionName: this.#session.sessionManager?.getSessionName?.() ?? undefined, now: Date.now(),
		});
		this.#treeVisible = visible;
		this.#treePickerSelected = (node.p as { selected?: string | null }).selected ?? undefined;
		return node;
	}

	#closeSessionTree(): void {
		this.#treePickerOpen = false;
		this.#treePickerSelected = undefined;
		this.#treeModel = undefined;
		this.#treeVisible = [];
		this.#treeQuery = "";
	}

	#setTreeFilter(filter: TreeFilter): void {
		this.#treeFilter = filter;
		this.#render();
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
		const leaf = manager?.getLeafId?.();
		const model = buildTreeModel(tree, typeof leaf === "string" ? leaf : undefined);
		if (!model.rows.length) {
			this.#projector.add("system", "No entries in session");
			this.#render();
			return;
		}
		this.#treeModel = model;
		this.#treeQuery = "";
		this.#treePickerSelected = model.leafId;
		this.#treePickerOpen = true;
		this.#render();
	}

	async #navigateSessionTree(): Promise<void> {
		const target = this.#treePickerSelected;
		const leaf = this.#treeModel?.leafId;
		this.#closeSessionTree();
		if (!target || target === leaf || !this.#session.navigateTree) { this.#render(); return; }
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

	// Rows shown by the model picker: favorites first, then provider groups. A collapsed provider keeps its
	// header (with its full count) but none of its models.
	#modelPickerLayout(): { favorites: Model<any>[]; groups: { provider: string; count: number; models: Model<any>[] }[]; shown: Model<any>[]; visible: Model<any>[] } {
		const query = this.#modelQuery.trim().toLowerCase();
		const visible = this.#modelCatalog.filter((m) => `${m.provider}/${m.id} ${m.name}`.toLowerCase().includes(query));
		const isFavorite = (m: Model<any>) => this.#modelFavorites.has(`${m.provider}/${m.id}`);
		const favorites = visible.filter(isFavorite);
		const rest = visible.filter((m) => !isFavorite(m));
		const groups = [...new Set(rest.map((m) => m.provider))].map((provider) => {
			const models = rest.filter((m) => m.provider === provider);
			return { provider, count: models.length, models: this.#collapsedProviders.has(provider) ? [] : models };
		});
		return { favorites, groups, shown: [...favorites, ...groups.flatMap((g) => g.models)], visible };
	}

	#modelPickerNode(): TspNode {
		const models = this.#modelCatalog;
		const query = this.#modelQuery.trim().toLowerCase();
		const { favorites, groups, shown, visible } = this.#modelPickerLayout();
		const pickerItems: unknown[] = [];
		const order: (string | { group: string; label: string; count: number })[] = [];
		const pushModel = (model: Model<any>, favorite: boolean) => {
			const id = `${model.provider}/${model.id}`;
			order.push(id);
			pickerItems.push({ id, label: model.id, detail: model.name, mono: true, facts: { ctx: model.contextWindow ?? 0, price: `$${model.cost?.input ?? 0}/$${model.cost?.output ?? 0}` }, title: id, ...(favorite ? { badges: [{ text: "★" }] } : {}) });
		};
		if (favorites.length) {
			order.push({ group: "favorites", label: "Favorites", count: favorites.length });
			for (const model of favorites) pushModel(model, true);
		}
		for (const group of groups) {
			order.push({ group: `provider:${group.provider}`, label: group.provider, count: group.count });
			for (const model of group.models) pushModel(model, false);
		}
		const selected = shown.some((m) => `${m.provider}/${m.id}` === this.#modelSelected) ? this.#modelSelected : shown[0] ? `${shown[0].provider}/${shown[0].id}` : null;
		this.#modelSelected = selected ?? undefined;
		const current = modelIdentity(this.#session.model);
		const currentIds = current && models.some((m) => `${m.provider}/${m.id}` === current) ? [current] : [];
		const preview = shown.find((m) => `${m.provider}/${m.id}` === selected);
		return {
			id: "model-picker-sheet", k: "picker",
			p: { title: "Model", subtitle: this.#modelCatalogLoading ? "Loading available models…" : this.#modelCatalogError, state: this.#modelCatalogError ? "error" : this.#modelCatalogLoading ? "loading" : "ready", ...(this.#modelCatalogError ? { message: this.#modelCatalogError } : {}), icon: "cpu", noun: "models", size: "md", layout: "rows", preview: "below", query: this.#modelQuery, cursor: this.#modelQuery.length, placeholder: "Search models…", items: pickerItems, order, selected, current: currentIds, total: models.length, columns: [{ id: "ctx", head: "Context", format: "num" }], empty: query ? "No matching models" : "No models available", actions: [{ id: "favorite", label: "Favorite", keys: ["ctrl+f"], disabled: !selected }, { id: "use", label: "Use", keys: ["enter"], primary: true, disabled: !selected || this.#modelCatalogLoading }, { id: "close", label: "Cancel", keys: ["esc"] }] },
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

	// Tasks live in the transcript, not in a hover panel: one inline row per live task with its open
	// acceptance questions under it - the same row a work step uses. `frame: "inline"` is what keeps a
	// row a row: no ring, no tint, no status bar. Questions are plain text, not rows: a question is a
	// line the reader should notice, and a tool head per question cost three times the height for it.
	#taskRowNodes(rows: ReturnType<typeof buildTaskRows>["rows"]): TspNode[] {
		return rows.map((row) => ({
			id: row.id, k: "tool",
			p: {
				role: "pi.tasks.line", name: "todo", title: row.title, status: row.status,
				target: row.target, targetKind: "text",
				meta: row.meta,
				...(row.badges.length ? { badges: row.badges } : {}),
				...(row.note ? { note: row.note } : {}),
				frame: "inline", collapsible: true, collapsed: false,
			},
			c: row.questions.map((question): TspNode => ({
				id: `${row.id}-q-${question.id}`, k: "text",
				p: {
					role: "pi.tasks.line-q", tone: question.status === "done" ? "success" : "warning",
					wrap: "none", truncate: "end", text: `  ${question.mark} ${question.id}: ${question.text}`,
					title: `${question.id} · ${question.status === "done" ? "answered" : "open"}\n${question.text}`,
				},
			})),
		}));
	}

	// The transcript's task block, keyed so it updates in place instead of being re-added each render.
	// It shows live work only - what is being worked and what is stuck - because a transcript that keeps
	// every finished and not-yet-started task on screen spends the reader's attention on history. Those
	// tasks stay in the head as counts, so nothing disappears silently.
	#transcriptTasks(): TspNode[] {
		const view = this.#taskView();
		if (!view || view.status !== "ready" || !(view.tasks ?? []).length) return [];
		const counts = taskRowCounts(view);
		const { rows, hidden } = buildTaskRows(view, { liveOnly: true, maxRows: TASK_LIVE_ROWS, maxQuestions: TASK_LIVE_QUESTIONS });
		const head = [
			"Tasks",
			counts.active ? `${counts.active} active` : "",
			counts.pending ? `${counts.pending} pending` : "",
			counts.done ? `${counts.done} done` : "",
			counts.blocked ? `${counts.blocked} blocked` : "",
		].filter(Boolean).join(" · ");
		return [{
			id: "tasks-block", k: "col", p: { role: "pi.tasks.block" },
			c: [
				{ id: "tasks-block-head", k: "text", p: { role: "pi.tasks.block-head", tone: "muted", wrap: "none", text: head } },
				...this.#taskRowNodes(rows),
				...(hidden ? [{ id: "tasks-block-more", k: "text", p: { role: "pi.tasks.lines-more", tone: "muted", wrap: "none", text: `+${hidden} more live task${hidden === 1 ? "" : "s"}` } }] : []),
			],
		}];
	}

	// The composer's running-work pulse (composer-view.ts workChip) reads only these facts. Live work used to
	// be a card prepended to the dock, which cost three to seven rows of the pane for as long as anything ran
	// and kept a "Recent background work" button for fifteen minutes after it settled. Now the bar carries one
	// spinner while work is live, and nothing at all once it settles: the list, per-job output and stop live in
	// the work sheet (click the pulse, or /work), which is otherwise unchanged.
	#workFacts(now = Date.now()): WorkFacts | undefined {
		const live = runningWorkSnapshot().filter((item) => (item.status === "queued" || item.status === "running") && item.foreground !== true);
		if (!live.length) return undefined;
		return {
			running: live.filter((item) => item.status === "running").length,
			queued: live.filter((item) => item.status === "queued").length,
			// The store is ordered by start time, so the last one is the newest.
			newest: backgroundWorkLabel(live[live.length - 1]),
		};
	}

	#backgroundItems(): RunningWorkItem[] {
		const now = Date.now();
		return runningWorkSnapshot().filter((i) => i.foreground !== true && (backgroundWorkLive(i) || (now - (i.endedAt ?? i.startedAt) < 15 * 60 * 1000)));
	}

	// The one focused task Pi's task state reports, as a plain value for the work table (no inference from prose).
	#currentTask(): CurrentTask | undefined {
		const view = this.#taskView();
		return view?.status === "ready" && view.focus ? { id: view.focus.id, subject: view.focus.subject } : undefined;
	}

	#render(): void {
		if (this.#closed) return;
		this.#syncSession();
		// The annotation sheet is the only way a mark gets a position: TSP nodes cannot carry one.
		if (this.#annotate) {
			const css = annotateSheet(this.#annotate);
			if (css !== this.#annotateCss) {
				this.#annotateCss = css;
				this.#surface.stylesheet("annotate", css);
			}
		}
		const gitFocus = this.#gitView && this.#gitFocus ? (this.#gitFocus === "summary" ? "git-summary" : "git-body-field") : undefined;
		const focus = this.#ui.focusId ?? (this.#workViewId !== undefined ? "bg-search" : undefined) ?? (this.#stepInspector ? "work-inspector-search" : undefined) ?? (this.#mcpManager.open ? this.#mcpManager.focusId : undefined) ?? gitFocus ?? (this.#treePickerOpen ? "session-tree-picker" : this.#modelPickerOpen ? "model-picker-sheet" : "composer");
		const transcript = this.#projector.nodes(this.#toolOutputExpanded, { currentTask: this.#currentTask(), messageFocus: this.#messageFocus, editing: this.#editing?.itemId, busy: this.#busy });
		// The git sheet replaces the composer, as OMP's fullscreen git app does; hiding the dock also gives the
		// full sheet the whole pane instead of leaving the composer under it.
		this.#surface.render([...startupNodes(this.#logo, this.#version, this.#repo, readMcpStatus(this.#session.sessionManager?.getSessionId?.() as string | undefined)), ...transcript, ...this.#transcriptTasks()], this.#gitView ? [] : this.#dock(), focus, this.#layer(), this.#workReveal ?? this.#complete.selectedId);
		this.#workReveal = undefined;
		try { this.#onRenderTap?.(transcript, this.#trigger, this.#busy); } catch { /* tracing never affects the UI */ }
	}

	/** The view Tern holds after applying every frame sent so far. For tests that replay the wire. */
	debugView(): TspView {
		return this.#surface.sent ?? { main: [], dock: [], layer: [] };
	}

	// ctrl+o folds or unfolds all tool output; each tool's head click still toggles just that tool.
	toggleToolOutput(): void {
		if (this.#closed) return;
		this.#toolOutputExpanded = !this.#toolOutputExpanded;
		// The global state overrides every group's local fold, so Ctrl+O clears them all.
		this.#projector.clearGroupViews();
		this.#render();
	}

	// A programmatic draft change (extension setEditorText, pasteToEditor) closes the autocomplete, as
	// pi-tui's Editor.setText does.
	setDraft(text: string): void {
		this.#writeDraft(text, { kind: "set" });
	}

	// Applies one editor operation, then renders and refreshes the autocomplete for the new state.
	#editDraft(apply: () => void, edit: Edit): void {
		if (this.#closed) return;
		apply();
		this.#render();
		void this.#complete.edited(edit);
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
		if (this.#treePickerOpen && !this.#closed) { this.#setTreeFilter(nextFilter(this.#treeFilter, 1, this.#treeModel)); return Promise.resolve(); }
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
			const rows = this.#treeVisible;
			if (!rows.length) return;
			const index = rows.findIndex((row) => row.id === this.#treePickerSelected);
			this.#treePickerSelected = rows[Math.max(0, Math.min(rows.length - 1, index + delta))]?.id;
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

	/** A path the agent can open: workspace-relative when it lives inside the session's cwd. */
	#shownPath(path: string): string {
		const cwd = this.#session.sessionManager?.getCwd?.();
		if (!cwd) return path;
		const rel = relative(cwd, path);
		return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : path;
	}

	/**
	 * Writes a generated image's path into the composer on its own line. The chip is the picture; this is
	 * the durable reference when the picture does not reach the model — a non-vision model, a blob that
	 * never connected, or a conversation resumed where the image data no longer travels.
	 */
	#appendPath(label: string, path: string): void {
		const line = `${label}: ${this.#shownPath(path)}`;
		if (this.#draft.includes(line)) return;
		const body = this.#draft.trimEnd();
		this.setDraft(`${body}${body ? "\n\n" : ""}${line}\n`);
	}

	appendDraft(text: string): void {
		if (this.#treePickerOpen) {
			this.#treeQuery += text.replace(/[\r\n]/g, "");
			this.#render();
			return;
		}
		if (this.#modelPickerOpen) {
			this.#modelQuery += text.replace(/[\r\n]/g, "");
			this.#modelSelected = undefined;
			this.#render();
			return;
		}
		if (this.#ui.active) return this.#ui.type(text);
		if (this.#btw?.active) {
			this.#btw.input(text);
			return;
		}
		if (this.#dialog?.active) {
			this.#dialog.input(text);
			return;
		}
		this.#editDraft(() => this.#editor.insert(text), { kind: "type", text });
	}

	// The git sheet is modal in Tern (an overlay never takes the keyboard), so run.ts asks it first. Every key
	// is consumed while it is open: the commit fields edit their own text, the rest are OMP's git bindings.
	applyMcpKey(effect: KeyEffect): boolean {
		if (this.#ui.active) return false;
		if (this.#mcpManager.open && effect.kind === "paste") { void this.pasteClipboard(); return true; }
		return this.#mcpManager.key(effect);
	}

	applyWorkKey(effect: KeyEffect): boolean {
		if (this.#workViewId !== undefined && !this.#ui.active) {
			if (effect.kind === "escape") this.#closeWorkView();
			else if (effect.kind === "paste") {
				const panel = this.#backgroundPanel;
				void this.#clipboard.text().then((text) => { if (text && this.#workViewId !== undefined && this.#backgroundPanel === panel) { panel.search.insert(text); this.#render(); } }).catch(() => {});
			} else { this.#backgroundPanel.key(effect, this.#backgroundItems()); this.#render(); }
			return true;
		}
		const v = this.#stepInspector;
		if (!v || this.#ui.active) return false;
		switch (effect.kind) {
			case "escape": this.#stepInspector = undefined; break;
			case "text": v.search.insert(effect.text); break;
			case "backspace": v.search.backspace(); break;
			case "deleteWord": v.search.deleteWordBackward(); break;
			case "deleteForward": v.search.deleteForward({ word: effect.word }); break;
			case "deleteToEdge": v.search.deleteToEdge(effect.direction); break;
			case "selectAll": v.search.selectAll(); break;
			case "undo": v.search.undo(); break;
			case "cursor": v.search.move(effect.direction, { word: effect.word, extend: effect.extend, line: effect.line }); break;
			case "tabMove": v.search.move(effect.delta < 0 ? -1 : 1); break;
			case "tab": v.filter = (["all", "active", "failed"] as const)[(["all", "active", "failed"].indexOf(v.filter) + 1) % 3]!; break;
			case "up": case "down": {
				const rows = filterWork(this.#projector.groupItems(v.group), v.filter, v.search.text);
				const i = Math.max(0, rows.findIndex((r) => r.id === v.selected));
				v.selected = rows[Math.max(0, Math.min(rows.length - 1, i + (effect.kind === "up" ? -1 : 1)))]?.id;
				break;
			}
			case "paste": void this.#clipboard.text().then((text) => { if (text && this.#stepInspector === v) { v.search.insert(text); this.#render(); } }).catch(() => {}); break;
		}
		this.#render();
		return true;
	}

	applyGitKey(effect: KeyEffect): boolean {
		if (!this.#gitView) return false;
		if (this.#gitHelp) {
			if (effect.kind === "escape" || (effect.kind === "text" && effect.text === "?")) {
				this.#gitHelp = false;
				this.#render();
			}
			return true;
		}
		if (this.#gitFocus) {
			const editor = this.#gitFocus === "summary" ? this.#gitSummary : this.#gitBody;
			switch (effect.kind) {
				case "text":
					editor.insert(effect.text);
					break;
				case "backspace":
					editor.backspace();
					break;
				case "deleteWord":
					editor.deleteWordBackward();
					break;
				case "deleteForward":
					editor.deleteForward({ word: effect.word });
					break;
				case "deleteToEdge":
					editor.deleteToEdge(effect.direction);
					break;
				case "cursor":
					editor.move(effect.direction, { word: effect.word, extend: effect.extend, line: effect.line });
					break;
				case "selectAll":
					editor.selectAll();
					break;
				case "undo":
					editor.undo();
					break;
				case "submit":
					if (this.#gitFocus === "summary") this.#gitFocus = "body";
					else editor.insert("\n");
					break;
				case "newline":
					editor.insert("\n");
					break;
				case "tab":
					this.#gitFocus = this.#gitFocus === "summary" ? "body" : "summary";
					break;
				case "escape":
					this.#gitFocus = undefined;
					break;
				default:
					return true;
			}
			this.#render();
			return true;
		}
		if (effect.kind === "escape") {
			this.escape();
			return true;
		}
		if (effect.kind === "interrupt") {
			this.#gitRequest++;
			this.#gitView = undefined;
			this.#gitStatus = undefined;
			this.#render();
			return true;
		}
		if (effect.kind === "text") {
			const key = effect.text;
			if (key === "j") this.#gitMoveSelection(1);
			else if (key === "k") this.#gitMoveSelection(-1);
			else if (key === "]") this.#gitMoveSelection(1);
			else if (key === "[") this.#gitMoveSelection(-1);
			else if (key === "v") this.#gitDiffMode = this.#gitDiffMode === "split" ? "unified" : "split";
			else if (key === "s") void this.#gitAct("git.stage");
			else if (key === "u") void this.#gitAct("git.unstage");
			else if (key === "x") void this.#gitAct("git.discard");
			else if (key === "a") void this.#gitAct("git.stageAll");
			else if (key === "c") this.#gitFocus = "summary";
			else if (key === "r") this.#loadRepo();
			else if (key === "?") this.#gitHelp = true;
			this.#render();
			return true;
		}
		if (effect.kind === "up" || effect.kind === "down") {
			this.#gitMoveSelection(effect.kind === "down" ? 1 : -1);
			return true;
		}
		return true;
	}

	// A bracketed paste while the git sheet is open goes to the commit field that owns the keys.
	applyGitPaste(text: string): boolean {
		if (!this.#gitView || this.#gitFocus === undefined) return false;
		const editor = this.#gitFocus === "summary" ? this.#gitSummary : this.#gitBody;
		if (isLargePaste(text)) editor.insertPaste(text);
		else editor.insert(text);
		this.#render();
		return true;
	}

	// Left/right (and Shift+Tab) move the ask-dialog tab when a dialog is open; otherwise they move the caret.
	moveTabOrCursor(delta: number): void {
		if (this.#treePickerOpen && !this.#closed) return this.#setTreeFilter(nextFilter(this.#treeFilter, delta < 0 ? -1 : 1, this.#treeModel));
		if (this.#dialog?.active) return this.moveDialogTab(delta);
		this.moveCursor(delta < 0 ? -1 : 1, false, false);
	}

	moveCursor(direction: -1 | 1, word: boolean, extend: boolean, line = false): void {
		this.#editField((field) => field.move(direction, { word, extend, line }), { kind: "set" });
	}

	// One caret/delete/undo operation on the field that owns the caret: an open extension text prompt, else
	// the composer. Nothing while an ask dialog or a picker owns the keys.
	#editField(op: (field: DraftEditor) => void, edit: Edit): void {
		if (this.#closed) return;
		if (this.#ui.active) {
			this.#ui.editText(op);
			return;
		}
		if (this.#dialog?.active || this.#modelPickerOpen || this.#treePickerOpen) return;
		this.#editDraft(() => op(this.#editor), edit);
	}

	// The caret, selection, delete and undo effects of keys.ts, shared by run.ts and the e2e drivers so the key
	// path has one dispatch. Returns false for effects that are not plain text editing.
	applyEditKey(effect: KeyEffect): boolean {
		switch (effect.kind) {
			case "cursor": this.moveCursor(effect.direction, effect.word, effect.extend, effect.line); return true;
			case "selectAll": this.selectAllDraft(); return true;
			case "undo": this.undoDraft(); return true;
			case "deleteWord": this.deleteWordDraft(); return true;
			case "deleteForward": this.#editField((field) => field.deleteForward({ word: effect.word }), { kind: "backspace" }); return true;
			case "deleteToEdge": this.#editField((field) => field.deleteToEdge(effect.direction), { kind: "backspace" }); return true;
			default: return false;
		}
	}

	// Ctrl+B. Tern owns the keys, so the Pi-side running-work panel never sees this chord here: it goes to
	// the same detach the panel uses, and the writers' store updates redraw the background card.
	backgroundForegroundWork(): boolean {
		if (this.#closed) return false;
		const moved = detachRunningWork();
		if (moved) this.#render();
		return moved;
	}

	selectAllDraft(): void {
		this.#editField((field) => field.selectAll(), { kind: "set" });
	}

	// The composer takes Tern's `send` only when nothing else owns Enter; otherwise Tern holds the prompt.
	#composerSendable(): boolean {
		return !this.#closed && !this.#annotate && this.#workViewId === undefined && !this.#stepInspector && !this.#mcpManager.open && !this.#ui.active && !this.#dialog?.active && !this.#btw?.active && !this.#modelPickerOpen && !this.#treePickerOpen;
	}

	// Tern's atomic `send` goes through the normal submit path but is not the user's draft: a half-typed
	// draft survives it.
	#sendFromTern(text: string): Promise<void> {
		const draft = this.#editor.text;
		const result = this.submit(text);
		if (draft && this.#editor.text !== draft) this.#writeDraft(draft, null);
		return result;
	}

	// Tern's native editing on the composer: a click placing the caret, a drag/double-click/⌘A selection
	// replaced by typing, ⌫, ⌘X or a paste, or a drawn-line ↑/↓/Home/End move. A stale event (keys in
	// flight) is dropped, as the protocol asks.
	applyNativeEdit(edit: HostEdit): void {
		if (this.#closed || this.#annotate || this.#ui.active || this.#dialog?.active || this.#btw?.active || this.#modelPickerOpen || this.#treePickerOpen) return;
		const inserted = typeof edit.text === "string" ? edit.text : "";
		const removed = edit.from !== edit.to;
		const kind: Edit = inserted && !removed ? { kind: "type", text: inserted } : !inserted && removed ? { kind: "backspace" } : { kind: "set" };
		if (!this.#editor.applyHostEdit(edit)) return;
		this.#render();
		void this.#complete.edited(kind);
	}

	// Ctrl/Cmd+Z on the composer. Undo can restore text a submit cleared.
	undoDraft(): void {
		this.#editField((field) => field.undo(), { kind: "set" });
	}

	deleteWordDraft(): void {
		this.#editField((field) => field.deleteWordBackward(), { kind: "backspace" });
	}

	// Ctrl+V through Pi's cross-platform clipboard helper: copied files and a copied image become attachment
	// chips (any mix, several at once); otherwise the text is pasted.
	async pasteClipboard(): Promise<void> {
		if (this.#closed || this.#ui.active || this.#dialog?.active || this.#modelPickerOpen || this.#treePickerOpen) return;
		if (this.#mcpManager.open) {
			const text = await this.#clipboard.text().catch(() => null);
			if (text && this.#mcpManager.open) this.#mcpManager.key({ kind: "text", text });
			return;
		}
		const paths = await this.#clipboard.filePaths().catch(() => null);
		if (paths?.length) {
			this.attachPaths(paths);
			return;
		}
		const image = await this.#clipboard.image().catch(() => null);
		if (image?.length) {
			const path = this.#clipboard.saveImage?.(image);
			if (!path) return;
			this.attachPaths([path]);
			return;
		}
		const text = await this.#clipboard.text().catch(() => null);
		if (text && !this.#closed && !this.#ui.active && !this.#dialog?.active && !this.#modelPickerOpen) {
			this.pasteText(text);
		}
	}

	// Bracketed or clipboard paste. A paste that is only existing absolute paths (what Tern and other terminals
	// write for files dropped on the pane) attaches them. Large text becomes a marker that expands on submit;
	// small text is flattened to one line, so embedded newlines never submit.
	pasteText(text: string): void {
		if (this.#workViewId !== undefined && !this.#ui.active) { this.applyWorkKey({ kind: "text", text }); return; }
		if (this.#stepInspector && !this.#ui.active) { this.applyWorkKey({ kind: "text", text }); return; }
		if (this.#mcpManager.open && !this.#ui.active) { this.#mcpManager.key({ kind: "text", text }); return; }
		const normalized = text.replace(/\r\n?/g, "\n");
		const composer = !this.#ui.active && !this.#dialog?.active && !this.#btw?.active && !this.#modelPickerOpen && !this.#treePickerOpen;
		const dropped = composer ? parseDroppedPaths(normalized) : null;
		if (dropped) {
			this.attachPaths(dropped);
			return;
		}
		if (!isLargePaste(normalized) || this.#ui.active || this.#dialog?.active || this.#modelPickerOpen || this.#treePickerOpen) {
			this.appendDraft(normalized.replace(/\n/g, " "));
			return;
		}
		this.#editDraft(() => this.#editor.insertPaste(normalized), { kind: "set" });
	}

	// Adds files as composer attachments: images carry a blob, sent to Tern before the frame that draws it.
	// A path already attached is not added twice; past the limit the rest are reported, not dropped silently.
	attachPaths(paths: readonly string[]): void {
		if (this.#closed) return;
		const skipped: string[] = [];
		for (const path of paths) {
			if (this.#attachments.some((a) => a.path === path)) continue;
			if (this.#attachments.length >= ATTACHMENT_LIMITS.maxAttachments) { skipped.push(`${path} (limit of ${ATTACHMENT_LIMITS.maxAttachments} attachments)`); continue; }
			const attachment = loadAttachment(path, this.#attachmentSeq + 1);
			if (!attachment) { skipped.push(`${path} (not found)`); continue; }
			this.#attachmentSeq++;
			if (attachment.blob) for (const chunk of encodeTspBlob(attachment.blob.id, attachment.blob.mime, attachment.blob.base64)) this.#write(chunk);
			this.#attachments.push(attachment);
		}
		if (skipped.length) this.#projector.add("system", `not attached: ${skipped.join(", ")}`);
		this.#render();
	}

	get attachments(): readonly Attachment[] {
		return this.#attachments;
	}

	removeAttachment(n: number): void {
		const before = this.#attachments.length;
		this.#attachments = this.#attachments.filter((a) => a.n !== n);
		if (this.#attachments.length !== before) this.#render();
	}

	// Shift+Enter: a newline in an open multi-line prompt; the composer is single-line.
	newline(): void {
		if (this.#ui.active) this.#ui.newline();
	}

	backspaceDraft(): void {
		if (this.#treePickerOpen) {
			this.#treeQuery = [...this.#treeQuery].slice(0, -1).join("");
			this.#render();
			return;
		}
		if (this.#modelPickerOpen) {
			this.#modelQuery = [...this.#modelQuery].slice(0, -1).join("");
			this.#render();
			return;
		}
		if (this.#ui.active) return this.#ui.backspace();
		if (this.#btw?.active) return this.#btw.backspace();
		if (this.#dialog?.active) return this.#dialog.backspace();
		// ⌫ in an empty composer takes back the last attachment, as in OMP's composer.
		if (!this.#editor.text && this.#attachments.length) return this.removeAttachment(this.#attachments.at(-1)!.n);
		this.#editDraft(() => this.#editor.backspace(), { kind: "backspace" });
	}

	// Pi's app.clear (Ctrl+C) clears only the editor (its text and attachments); it does not cancel a turn.
	clearDraft(): void {
		if (this.#attachments.length) { this.#attachments = []; if (!this.#draft) this.#render(); }
		if (this.#draft) this.setDraft("");
	}

	// Escape: dismiss transient UI, cancel a running turn, or clear non-empty input before idle double-Escape.
	// Returns true only when the configured `none` action closes the Tern surface.
	escape(): boolean {
		if (this.#stepInspector && !this.#ui.active) { this.#stepInspector = undefined; this.#render(); return false; }
		if (this.#mcpManager.open && !this.#ui.active) { this.#mcpManager.escape(); return false; }
		if (this.#workViewId !== undefined) {
			this.#closeWorkView();
			this.#lastEligibleEscapeAt = 0;
			return false;
		}
		if (this.#gitView) {
			if (this.#gitHelp) {
				this.#gitHelp = false;
				this.#render();
				return false;
			}
			if (this.#gitFocus) {
				this.#gitFocus = undefined;
				this.#render();
				return false;
			}
			this.#gitRequest++;
			this.#gitView = this.#gitView.mode === "diff" ? { mode: "list" } : undefined;
			this.#gitStatus = undefined;
			this.#gitPendingDiscard = undefined;
			this.#lastEligibleEscapeAt = 0;
			this.#render();
			return false;
		}
		if (this.#contextView) {
			this.#contextView = false;
			this.#lastEligibleEscapeAt = 0;
			this.#render();
			return false;
		}
		if (this.#treePickerOpen) {
			// Esc clears a search first, like the model picker, then closes.
			if (this.#treeQuery) this.#treeQuery = "";
			else this.#closeSessionTree();
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
		// /btw: Escape aborts a running side question, otherwise it closes the box and restores the composer.
		if (this.#btw?.active) {
			this.#lastEligibleEscapeAt = 0;
			this.#btw.escape();
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
		if (this.#editing) {
			this.#lastEligibleEscapeAt = 0;
			this.#cancelEdit();
			return false;
		}
		if (this.#messageFocus) {
			this.#lastEligibleEscapeAt = 0;
			this.#messageFocus = undefined;
			this.#render();
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
		// Marking up a picture owns the input slot. A click names a grid cell (TSP has no pointer
		// coordinates), the arrows nudge the crosshair by a percent, Enter drops a pin, and the note is a
		// native editor so typing never has to be reconstructed from key events.
		if (this.#annotate && msg.verb === "e" && !this.#ui.active) {
			const session = this.#annotate;
			const b = msg.body;
			const close = () => { this.#annotate = undefined; this.#annotateCss = undefined; };
			if (b.ev === "action") {
				const act = String(b.act ?? "");
				if (act === ANNOTATE_CANCEL) close();
				else if (act === ANNOTATE_SEND) { void this.#sendAnnotate(); return undefined; }
				else if (act === ANNOTATE_ADD) addMark(session);
				else if (act === ANNOTATE_REMOVE) removeSelected(session);
				else if (act === ANNOTATE_CELL) {
					const cell = cellFromNodeId(b.id);
					if (cell) session.cursor = cellPoint(cell.row, cell.col);
					session.noteFocused = false;
				} else if (act === ANNOTATE_PIN) {
					const pin = pinFromNodeId(b.id);
					if (pin !== undefined) selectPin(session, pin);
					session.noteFocused = false;
				}
				this.#render();
				return undefined;
			}
			if (b.ev === "focus" && b.id === ANNOTATE_NOTE_ID) {
				session.noteFocused = true;
				return undefined;
			}
			if (b.ev === "edit" && b.id === ANNOTATE_NOTE_ID) {
				editNote(session, Number(b.from ?? 0), Number(b.to ?? 0), typeof b.text === "string" ? b.text : "", typeof b.cursor === "number" ? b.cursor : undefined);
				this.#render();
				return undefined;
			}
			if (b.ev === "paste" && b.id === ANNOTATE_NOTE_ID && typeof b.text === "string") {
				const at = session.noteCursor ?? session.note.length;
				editNote(session, at, at, b.text);
				this.#render();
				return undefined;
			}
			if (b.ev === "key") {
				const key = String(b.key ?? "");
				if (session.noteFocused) {
					// The note editor owns arrows and text; Esc hands the keys back to the crosshair.
					if (key === "escape") { session.noteFocused = false; this.#render(); }
					return undefined;
				}
				if (key === "escape") close();
				else if (key === "left") nudgeCursor(session, -0.01, 0);
				else if (key === "right") nudgeCursor(session, 0.01, 0);
				else if (key === "up") nudgeCursor(session, 0, -0.01);
				else if (key === "down") nudgeCursor(session, 0, 0.01);
				else if (key === "enter") addMark(session);
				else if (key === "backspace") removeSelected(session);
				else if (key === "tab" && session.marks.length > 0) {
					const pins = session.marks.map((mark) => mark.n);
					const at = session.selected === undefined ? -1 : pins.indexOf(session.selected);
					selectPin(session, pins[(at + 1) % pins.length]);
				}
				this.#render();
				return undefined;
			}
			return undefined;
		}
		if (this.#workViewId !== undefined && msg.verb === "e" && !this.#ui.active) {
			const b = msg.body;
			if (b.ev === "action" && b.act === "bg.close") { this.#closeWorkView(); return; }
			if (b.ev === "action" && b.act === "bg.stop" && typeof b.value === "string") { this.#stopWork(b.value); return; }
			if (b.ev === "action" && b.act === "bg.open" && typeof b.value === "string") { this.#openWorkView(b.value); return; }
			this.#backgroundPanel.event(b);
			if (b.ev === "paste" && typeof b.text === "string") this.#backgroundPanel.search.insert(b.text);
			if (b.ev === "key") {
				const key = String(b.key ?? "");
				const effects: Record<string, KeyEffect> = { escape: { kind: "escape" }, up: { kind: "up" }, down: { kind: "down" }, tab: { kind: "tab" }, backspace: { kind: "backspace" } };
				const effect = effects[key] ?? (key.length === 1 ? { kind: "text" as const, text: key } : undefined);
				if (effect) this.applyWorkKey(effect);
			}
			if (["action", "select", "activate", "edit", "undo", "paste", "key", "send", "focus"].includes(String(b.ev))) { this.#render(); return; }
		}
		if (this.#stepInspector && msg.verb === "e" && !this.#ui.active) {
			const v = this.#stepInspector;
			const b = msg.body;
			if (b.ev === "action" && b.act === "work.inspect.close") { this.#stepInspector = undefined; this.#render(); return; }
			if (b.ev === "action" && b.act === "work.reveal" && typeof b.value === "string") {
				if (this.#projector.revealStep(b.value)) this.#workReveal = b.value;
				this.#stepInspector = undefined; this.#render(); return;
			}
			if ((b.ev === "select" || b.ev === "activate") && b.id === "work-inspector-list" && typeof b.item === "string") v.selected = b.item;
			if ((b.ev === "select" || b.ev === "activate") && b.id === "work-inspector-tabs" && ["all", "active", "failed"].includes(String(b.item))) v.filter = b.item as WorkFilter;
			if (b.ev === "edit" && b.id === "work-inspector-search") v.search.applyHostEdit(b as unknown as HostEdit);
			if (b.ev === "undo" && b.id === "work-inspector-search") v.search.undo();
			if (b.ev === "paste" && typeof b.text === "string") v.search.insert(b.text);
			if (b.ev === "key") {
				const key = String(b.key ?? "");
				const effects: Record<string, KeyEffect> = { escape: { kind: "escape" }, up: { kind: "up" }, down: { kind: "down" }, tab: { kind: "tab" }, backspace: { kind: "backspace" } };
				const effect = effects[key] ?? (key.length === 1 ? { kind: "text" as const, text: key } : undefined);
				if (effect) this.applyWorkKey(effect);
			}
			if (["action", "select", "activate", "edit", "undo", "paste", "key", "send", "focus"].includes(String(b.ev))) { this.#render(); return; }
		}
		if (msg.verb === "e" && msg.body.act === "mcp.open") return this.#mcpManager.show();
		if (this.#mcpManager.open && msg.verb === "e" && !this.#ui.active) {
			// Own every editing event while modal, including stale composer edits.
			if (["edit", "undo", "key", "paste", "send", "focus", "select", "activate", "action"].includes(String(msg.body.ev))) return this.#mcpManager.event(msg.body);
		}
		// The context card is a peek, not a modal: the composer keeps the keys, so the first thing typed (or a
		// paste) closes the card and edits the draft as before.
		if (this.#contextView && msg.verb === "e" && (msg.body.ev === "edit" || msg.body.ev === "key" || msg.body.ev === "paste")) {
			this.#closeContextView();
		}
		// Native editing (hello features edit/undo/send) on the composer and an extension prompt's text field,
		// the two editor/input fields Pi draws. Each event goes to the field it names.
		if (msg.verb === "e" && msg.body.id === UI_PROMPT_INPUT_ID) {
			if (msg.body.ev === "edit") this.#ui.applyNativeEdit(msg.body as unknown as HostEdit);
			else if (msg.body.ev === "undo") this.#ui.editText((field) => field.undo());
			return undefined;
		}
		if (msg.verb === "e" && msg.body.id === "composer") {
			if (msg.body.ev === "edit") return this.applyNativeEdit(msg.body as unknown as HostEdit), undefined;
			if (msg.body.ev === "undo") {
				if (this.#composerSendable()) this.#editDraft(() => this.#editor.undo(), { kind: "set" });
				return undefined;
			}
			// A click in the composer while a picker holds the keys: the picker closes (no choice applied) and the
			// composer takes the focus back. A modal prompt, ask dialog or /btw card keeps the keys.
			if (msg.body.ev === "focus") {
				if (this.#ui.active || this.#dialog?.active || this.#btw?.active || this.#closed) return undefined;
				if (this.#modelPickerOpen || this.#treePickerOpen) {
					this.#modelPickerOpen = false;
					if (this.#treePickerOpen) this.#closeSessionTree();
				}
				this.#render();
				return undefined;
			}
			// An atomic prompt (Tern's initial prompt, Carly): the normal submit path, leaving the draft alone.
			if (msg.body.ev === "send") return typeof msg.body.text === "string" && this.#composerSendable() ? this.#sendFromTern(msg.body.text) : undefined;
		}
		if (msg.verb === "e" && msg.body.ev === "toggle" && typeof msg.body.id === "string" && msg.body.id.startsWith("g-")) {
			this.#projector.setGroupCollapsed(msg.body.id, msg.body.collapsed === true);
			this.#render();
			return undefined;
		}
		if (msg.verb === "e" && msg.body.ev === "resize" && typeof msg.body.cols === "number" && msg.body.cols > 0) {
			this.#columns = msg.body.cols;
			if (this.#dialog?.active || this.#gitView || this.#contextView || this.#workViewId !== undefined) this.#render();
		}
		if (msg.verb === "e" && msg.body.ev === "action" && msg.body.id === UI_PROMPT_LIST_ID) {
			this.#ui.action(msg.body.act);
			return undefined;
		}
		if (msg.verb === "e" && (msg.body.ev === "select" || msg.body.ev === "activate") && msg.body.id === UI_PROMPT_LIST_ID) {
			this.#ui.pick(msg.body.item, msg.body.ev === "activate");
			return undefined;
		}
		if (msg.verb === "e" && this.#treePickerOpen && msg.body.id === "session-tree-picker") {
			if ((msg.body.ev === "select" || msg.body.ev === "activate") && typeof msg.body.item === "string" && this.#treeVisible.some((row) => row.id === msg.body.item)) {
				this.#treePickerSelected = msg.body.item;
				if (msg.body.ev === "activate") return this.#navigateSessionTree();
			}
			if (msg.body.ev === "action") {
				if (msg.body.act === "navigate") return this.#navigateSessionTree();
				if (msg.body.act === "close") this.#closeSessionTree();
				if (msg.body.act === "filter") this.#treeFilter = nextFilter(this.#treeFilter, 1, this.#treeModel);
				if (msg.body.act === "tab" && TREE_FILTERS.some((f) => f.id === msg.body.value)) this.#treeFilter = msg.body.value as TreeFilter;
				if (msg.body.act === "clear") this.#treeQuery = "";
			}
			this.#render();
			return undefined;
		}
		if (msg.verb === "e" && msg.body.ev === "key" && (this.#gitView || this.#contextView || this.#workViewId !== undefined) && msg.body.key === "escape") {
			this.escape();
			return undefined;
		}
		if (this.#gitView && msg.verb === "e" && (msg.body.ev === "select" || msg.body.ev === "activate") && typeof msg.body.id === "string") {
			const item = typeof msg.body.item === "string" ? msg.body.item : "";
			if (msg.body.id === "git-diff-mode" && (item === "unified" || item === "split")) this.#gitDiffMode = item;
			else if (msg.body.id === "git-side-style" && (item === "path" || item === "tree")) this.#gitStyle = item;
			this.#render();
			return undefined;
		}
		if (this.#gitView && msg.verb === "e" && typeof msg.body.id === "string" && (msg.body.id === "git-summary" || msg.body.id === "git-body-field")) {
			const editor = msg.body.id === "git-summary" ? this.#gitSummary : this.#gitBody;
			if (msg.body.ev === "edit") {
				if (editor.applyHostEdit(msg.body as unknown as HostEdit)) this.#render();
				return undefined;
			}
			if (msg.body.ev === "undo") {
				editor.undo();
				this.#render();
				return undefined;
			}
			if (msg.body.ev === "focus") {
				this.#gitFocus = msg.body.id === "git-summary" ? "summary" : "body";
				this.#render();
				return undefined;
			}
		}
		if (this.#gitView && msg.verb === "e" && (msg.body.ev === "key" || msg.body.ev === "paste") && this.#gitFocus !== undefined) {
			const editor = this.#gitFocus === "summary" ? this.#gitSummary : this.#gitBody;
			const key = typeof msg.body.key === "string" ? msg.body.key : "";
			const text = msg.body.ev === "paste" && typeof msg.body.text === "string" ? msg.body.text : undefined;
			const mods = typeof msg.body.mods === "string" ? msg.body.mods : "";
			if (msg.body.ev === "paste" && text) {
				if (isLargePaste(text)) editor.insertPaste(text);
				else editor.insert(text);
			}
			else if (key === "escape") this.#gitFocus = undefined;
			else if (key === "tab") this.#gitFocus = this.#gitFocus === "summary" ? "body" : "summary";
			else if (key === "backspace") editor.backspace();
			else if (key === "delete") editor.deleteForward();
			else if (key === "left") editor.move(-1);
			else if (key === "right") editor.move(1);
			else if (key === "home" || (key === "left" && mods.includes("meta"))) editor.move(-1, { line: true });
			else if (key === "end" || (key === "right" && mods.includes("meta"))) editor.move(1, { line: true });
			else if (key === "enter") {
				if (this.#gitFocus === "summary") this.#gitFocus = "body";
				else editor.insert("\n");
			} else if (key && !key.startsWith("\x1b") && !mods.includes("ctrl") && !mods.includes("meta") && key.length <= 2) editor.insert(key);
			else return undefined;
			this.#render();
			return undefined;
		}
		if (this.#gitView && msg.verb === "e" && msg.body.ev === "key" && this.#gitFocus === undefined) {
			const key = typeof msg.body.key === "string" ? msg.body.key : "";
			if (key === "j" || key === "down") return this.#gitMoveSelection(1);
			if (key === "k" || key === "up") return this.#gitMoveSelection(-1);
			if (key === "]") return this.#gitMoveSelection(1);
			if (key === "[") return this.#gitMoveSelection(-1);
			if (key === "v") { this.#gitDiffMode = this.#gitDiffMode === "split" ? "unified" : "split"; this.#render(); return undefined; }
			if (key === "s") return this.#gitAct("git.stage");
			if (key === "u") return this.#gitAct("git.unstage");
			if (key === "x") return this.#gitAct("git.discard");
			if (key === "a") return this.#gitAct("git.stageAll");
			if (key === "c") { this.#gitFocus = "summary"; this.#render(); return undefined; }
			if (key === "r") { this.#loadRepo(); return undefined; }
			if (key === "?") { this.#gitHelp = !this.#gitHelp; this.#render(); return undefined; }
		}
		if (msg.verb === "e" && msg.body.ev === "key" && this.#treePickerOpen) {
			const key = typeof msg.body.key === "string" ? msg.body.key : "";
			if (key === "up") this.movePicker(-1);
			else if (key === "down") this.movePicker(1);
			else if (key === "enter") return this.#navigateSessionTree();
			else if (key === "escape") this.escape();
			else if (key === "tab") this.#treeFilter = nextFilter(this.#treeFilter, 1, this.#treeModel);
			else if (key === "shift+tab") this.#treeFilter = nextFilter(this.#treeFilter, -1, this.#treeModel);
			this.#render();
			return undefined;
		}
		// Ask-dialog pointer actions: `act` names the action and `id` the node it ran on. A text
		// node such as a tab reports the same string twice; a list row's own click action can
		// report the list id, so try the action name first and fall back to the node id.
		if (msg.verb === "e" && msg.body.ev === "action") {
			if (typeof msg.body.act === "string" && this.#dialog?.handleAction(msg.body.act)) return undefined;
			if (typeof msg.body.id === "string" && this.#dialog?.handleAction(msg.body.id)) return undefined;
			if (typeof msg.body.act === "string" && this.#btw?.handleAction(msg.body.act)) return undefined;
			if (typeof msg.body.id === "string" && this.#btw?.handleAction(msg.body.id)) return undefined;
		}
		if (msg.verb === "e" && (msg.body.ev === "select" || msg.body.ev === "activate") && msg.body.id === ASK_OPTIONS_ID && typeof msg.body.item === "string" && this.#dialog?.handleSelect(msg.body.item, msg.body.ev === "activate")) return undefined;
		if (msg.verb === "e" && (msg.body.ev === "select" || msg.body.ev === "activate") && typeof msg.body.id === "string" && msg.body.id.startsWith(`${AUTOCOMPLETE_ID}.`)) {
			if (typeof msg.body.item === "string") this.#complete.select(msg.body.item, msg.body.ev === "activate");
			return undefined;
		}
		if (msg.verb === "e" && this.#modelPickerOpen && msg.body.id === "model-picker-sheet") {
			if (msg.body.ev === "select" && typeof msg.body.item === "string") this.#modelSelected = msg.body.item;
			if (msg.body.ev === "activate" && typeof msg.body.item === "string") { this.#modelSelected = msg.body.item; return this.#applyModelSelection(); }
			if (msg.body.ev === "action") {
				if (msg.body.act === "use") return this.#applyModelSelection();
				if (msg.body.act === "favorite") { this.#toggleModelFavorite(); return undefined; }
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
			else if (key === "ctrl+f") this.#toggleModelFavorite();
			else if (key === "left" || key === "right") this.#setSelectedProviderCollapsed(key === "left");
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
		if (act === "work.inspect" && typeof msg.body.value === "string") {
			this.#stepInspector = { group: msg.body.value, filter: "all", search: new DraftEditor() };
			this.#render(); return;
		}
		// Form-backed actions carry `values.text`. The composer's Send control carries no payload, so it
		// must fall through to the same path as Enter (autocomplete, ask-dialog confirmation, attachments
		// and the draft) instead of submitting an empty string.
		if (act === "submit") {
			const text = submittedText(msg.body);
			return text ? this.submit(text) : this.submitDraft();
		}
		if (act === ATTACHMENT_REMOVE) {
			const n = attachmentFromNodeId(msg.body.id);
			if (n !== undefined) this.removeAttachment(n);
			return undefined;
		}
		if (act === DRAWING_ACTION) {
			void this.#openDrawing();
			return undefined;
		}
		if (act === DRAWING_SEND) {
			void this.#sendDrawing();
			return undefined;
		}
		if (act === DRAWING_DISCARD) {
			this.#hideDrawingPreview();
			return undefined;
		}
		if (act === ARTIFACT_ANNOTATE) {
			const ref = artifactFromNodeId(msg.body.id);
			if (ref) this.#openAnnotate(ref);
			return undefined;
		}
		if (act === "submit.followUp") return this.submitFollowUp(submittedText(msg.body));
		if (act === MESSAGE_FOCUS || act === MESSAGE_EDIT || act === MESSAGE_RESEND) {
			const item = messageItemFromNode(msg.body.id);
			if (!item) return undefined;
			if (act === MESSAGE_FOCUS) {
				this.#messageFocus = this.#messageFocus === item ? undefined : item;
				this.#render();
				return undefined;
			}
			return act === MESSAGE_EDIT ? this.editMessage(item) : this.resendMessage(item);
		}
		if (act === MESSAGE_EDIT_CANCEL) {
			this.#cancelEdit();
			return undefined;
		}
		if (act === "queue.edit") {
			this.restoreQueuedMessages();
			return undefined;
		}
		if (act === "cancel") {
			void this.cancel();
			return undefined;
		}
		if (act === "close") this.close();
		if (act === "interrupt") void this.cancel();
		if (act === "work.collapse" && typeof msg.body.value === "string") {
			this.#projector.setGroupCollapsed(msg.body.value, true);
			this.#render();
			return undefined;
		}
		if (act === "git.open") { this.#openGitView(); return undefined; }
		if (typeof act === "string" && act.startsWith("git.")) return this.#gitAct(act, typeof msg.body.value === "string" ? msg.body.value : undefined);
		if (act === "bg.open" && typeof msg.body.value === "string") { this.#openWorkView(msg.body.value); return undefined; }
		if (act === "bg.close") { this.#closeWorkView(); return undefined; }
		if (act === TRANSCRIPT_EARLIER) { this.#projector.showEarlier(); this.#render(); return undefined; }
		if (act === "bg.stop" && typeof msg.body.value === "string") { this.#stopWork(msg.body.value); return undefined; }
		// The composer's Background button: the same dispatch the ctrl+b key reaches in run.ts.
		if (act === "bg.background") { this.backgroundForegroundWork(); return undefined; }
		if (act === "context.close") { this.#closeContextView(); return undefined; }
		// OMP's composer meter opens the context card on click; the same card is `/context` in the composer.
		if (act === "status.context") { this.#openContextView(); return undefined; }
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
		const { shown: models } = this.#modelPickerLayout();
		if (!models.length) { this.#modelSelected = undefined; return; }
		const index = models.findIndex((m) => `${m.provider}/${m.id}` === this.#modelSelected);
		const next = models[(index + delta + models.length) % models.length];
		this.#modelSelected = `${next.provider}/${next.id}`;
	}

	// Left collapses and right expands the provider group of the selected model.
	#setSelectedProviderCollapsed(collapsed: boolean): void {
		const model = this.#modelCatalog.find((m) => `${m.provider}/${m.id}` === this.#modelSelected);
		if (!model) return;
		if (collapsed) this.#collapsedProviders.add(model.provider);
		else this.#collapsedProviders.delete(model.provider);
		this.#render();
	}

	#toggleModelFavorite(): void {
		const id = this.#modelSelected;
		if (!id) return;
		if (this.#modelFavorites.has(id)) this.#modelFavorites.delete(id);
		else this.#modelFavorites.add(id);
		try {
			mkdirSync(dirname(modelFavoritesPath()), { recursive: true });
			writeFileSync(modelFavoritesPath(), JSON.stringify([...this.#modelFavorites], null, 2));
		} catch (error) {
			this.#projector.add("system", `Could not save model favorites: ${error instanceof Error ? error.message : String(error)}`);
		}
		this.#render();
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
		// An open prompt, ask dialog or /btw card owns Enter; the composer must not send a prompt underneath it.
		if (this.#ui.active) {
			this.#ui.submit();
			return Promise.resolve();
		}
		if (this.#btw?.active) {
			this.#btw.request();
			return Promise.resolve();
		}
		if (this.#dialog?.active) {
			this.#dialog.confirmCurrent();
			return Promise.resolve();
		}
		const prompt = text.trim();
		// Attachments alone are a message: they skip command routing and go as a plain prompt.
		if (!prompt) return this.#attachments.length ? this.#sendPrompt(prompt) : Promise.resolve();
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
		if (route.kind === "bridge") {
			// A bridge command is a local view: it runs here, clears the composer and never reaches the model.
			this.#draft = "";
			if (route.name === "context") this.#openContextView();
			else if (route.name === "work") this.#openWorkView("all");
			else if (route.name === "drawing") void this.#openDrawing();
			else if (route.name === "annotate") this.#openAnnotate();
			else if (route.name === "diagram") this.#openDiagram();
			else this.#render();
			return Promise.resolve();
		}
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
			// Pi's `/mcp` with no arguments opens a TUI component (`ctx.ui.custom`) that Tern
			// cannot render: ext-ui disposes it and prints "needs Pi's terminal UI", so the
			// command looked broken and told the user to run `pi -nt`. Open the native manager
			// instead. Typed subcommands retain Pi's handler; GUI auth uses mcp-host's native
			// prompt adaptation because Pi's TUI login also uses a custom component.
			if (route.entry.name === "mcp" && prompt.trim().slice("mcp".length + 1).trim() === "") {
				return this.#mcpManager.show();
			}
			return this.#session.prompt(prompt).catch((error: unknown) => {
				this.#projector.add("system", `error: ${error instanceof Error ? error.message : String(error)}`);
				this.#render();
			});
		}
		return this.#sendPrompt(prompt);
	}

	// The Pi entry behind a transcript bubble, or a notice saying why there is none.
	#userEntryFor(itemId: string): UserEntry | undefined {
		const branch = this.#session.sessionManager?.getBranch?.();
		const entry = resolveUserEntry(itemId, this.#projector.userItemIds(), userEntriesOf(Array.isArray(branch) ? branch : []));
		if (!entry) {
			this.#projector.add("system", "Could not match this message to the session; open /tree to branch from it");
			this.#render();
		}
		return entry;
	}

	#refuseBranchWhileBusy(verb: string): boolean {
		if (!this.#busy && this.#session.navigateTree) return false;
		this.#projector.add("system", this.#session.navigateTree ? `Wait for the current turn to finish (Esc stops it) before you ${verb} a message` : "Branching is unavailable in this Pi session");
		this.#render();
		return true;
	}

	// Edit: the message's text and images go to the composer; the session is untouched until you send.
	editMessage(itemId: string): Promise<void> {
		if (this.#closed || this.#refuseBranchWhileBusy("edit")) return Promise.resolve();
		const entry = this.#userEntryFor(itemId);
		if (!entry) return Promise.resolve();
		const before = this.#editing ? { draftBefore: this.#editing.draftBefore, attachmentsBefore: this.#editing.attachmentsBefore } : { draftBefore: this.#draft, attachmentsBefore: this.#attachments };
		this.#editing = { itemId, entry, ...before };
		this.#messageFocus = undefined;
		const images = imageAttachments(entry.images, this.#attachmentSeq + 1);
		this.#attachmentSeq += images.length;
		for (const a of images) for (const chunk of encodeTspBlob(a.blob!.id, a.blob!.mime, a.blob!.base64)) this.#write(chunk);
		this.#attachments = images;
		this.setDraft(entry.text);
		return Promise.resolve();
	}

	#cancelEdit(): void {
		const edit = this.#editing;
		if (!edit) return;
		this.#editing = undefined;
		this.#attachments = edit.attachmentsBefore;
		this.setDraft(edit.draftBefore);
	}

	// Moves Pi's leaf to the message's parent (AgentSession.navigateTree on a user entry). The transcript reseeds from
	// the branch on Pi's session_tree event, so the old message and its replies leave the screen but stay in /tree.
	async #branchBefore(entry: UserEntry): Promise<boolean> {
		try {
			const result = await this.#session.navigateTree!(entry.id);
			if (!result.cancelled) return true;
			this.#projector.add("system", "Branching was cancelled");
		} catch (error) {
			this.#projector.add("system", `Could not branch: ${error instanceof Error ? error.message : String(error)}`);
		}
		this.#render();
		return false;
	}

	// Resend: the same text and images again from the same point, as a new branch.
	async resendMessage(itemId: string): Promise<void> {
		if (this.#closed || this.#refuseBranchWhileBusy("resend")) return;
		const entry = this.#userEntryFor(itemId);
		if (!entry) return;
		this.#messageFocus = undefined;
		if (this.#editing?.itemId === itemId) this.#cancelEdit();
		if (!(await this.#branchBefore(entry))) return;
		this.#projector.add("user", entry.text);
		this.#busy = true;
		this.#render();
		const images = entry.images;
		return (images.length ? this.#session.prompt(entry.text, { images }) : this.#session.prompt(entry.text)).catch((error: unknown) => {
			this.#busy = false;
			this.#projector.add("system", `error: ${error instanceof Error ? error.message : String(error)}`);
			this.#render();
		});
	}

	// Sending an edit: branch first, then the normal send path with the composer's text and attachments.
	async #sendEdited(prompt: string): Promise<void> {
		const edit = this.#editing!;
		if (this.#refuseBranchWhileBusy("send an edited")) return;
		this.#editing = undefined;
		if (!(await this.#branchBefore(edit.entry))) {
			this.#editing = edit;
			return;
		}
		return this.#sendPrompt(prompt);
	}

	// Plain Enter steers at the next boundary, like native Pi. Only Alt+Enter waits for a yield.
	#sendPrompt(prompt: string): Promise<void> {
		if (this.#editing) return this.#sendEdited(prompt);
		if (this.#busy || this.#session.isStreaming) return this.#submitQueued(prompt, "steer");
		const { text: sent, images } = this.#takeAttachments(this.#withMentions(prompt), prompt);
		this.#draft = "";
		this.#projector.add("user", sent.typed);
		this.#busy = true;
		this.#render();
		return (images.length ? this.#session.prompt(sent.model, { images }) : this.#session.prompt(sent.model)).catch((error: unknown) => {
			this.#busy = false;
			this.#projector.add("system", `error: ${error instanceof Error ? error.message : String(error)}`);
			this.#render();
		});
	}

	// Empties the attachment row into a submission: Pi image content for a model that takes images, a path list
	// in the text for everything else. `typed` is the transcript's line: the prompt as typed plus what went with it.
	#takeAttachments(expanded: string, typed: string): { text: { model: string; typed: string }; images: ImageContentLike[] } {
		const list = this.#attachments;
		if (list.length === 0) return { text: { model: expanded, typed }, images: [] };
		this.#attachments = [];
		const input = (this.#session.model as { input?: unknown } | undefined)?.input;
		const vision = !Array.isArray(input) || input.includes("image");
		const { text, images } = attachmentPayload(expanded, list, vision);
		const summary = attachmentSummary(list);
		return { text: { model: text, typed: typed ? `${typed}\n\n${summary}` : summary }, images };
	}

	// Pi's Alt+Enter queues a follow-up while streaming and submits normally while idle.
	submitFollowUp(text: string): Promise<void> {
		return this.#submitQueued(text, "followUp");
	}

	#submitQueued(text: string, mode: "steer" | "followUp"): Promise<void> {
		const prompt = text.trim();
		if (!prompt && !this.#attachments.length) return Promise.resolve();
		if (!this.#busy && !this.#session.isStreaming) return this.submit(prompt);
		this.#draft = "";
		const { text: { model: sent, typed }, images } = this.#takeAttachments(this.#withMentions(prompt), prompt);
		this.#queuedTyped.set(sent, typed);
		// Optimistic until Pi's queue_update replaces it; the dock's queue band shows it, not the transcript.
		if (mode === "steer") this.#queuedSteering = [...this.#queuedSteering, sent];
		else this.#queuedFollowUp = [...this.#queuedFollowUp, sent];
		this.#render();
		return this.#session.prompt(sent, { streamingBehavior: mode, ...(images.length ? { images } : {}) }).catch((error: unknown) => {
			const queue = mode === "steer" ? this.#queuedSteering : this.#queuedFollowUp;
			const queuedIndex = queue.lastIndexOf(sent);
			if (queuedIndex >= 0) queue.splice(queuedIndex, 1);
			this.#projector.add("system", `error queueing ${mode === "steer" ? "steering" : "follow-up"}: ${error instanceof Error ? error.message : String(error)}`);
			this.#render();
		});
	}

	restoreQueuedMessages(): void {
		if (this.#closed) return;
		const restored = this.#session.clearQueue?.();
		const queued = (restored ? [...restored.steering, ...restored.followUp] : [...this.#queuedSteering, ...this.#queuedFollowUp]).map((text) => this.#queuedTyped.get(text) ?? text);
		this.#queuedSteering = [];
		this.#queuedFollowUp = [];
		this.#queuedTyped.clear();
		if (queued.length) this.setDraft([queued.join("\n\n"), this.#draft].filter(Boolean).join("\n\n"));
		else { this.#projector.add("system", "No queued messages to restore"); this.#render(); }
	}

	// Enter with the autocomplete open applies the selection (pi-tui Editor); a command-name completion then
	// Plain prompts reach Pi with their resolved @mentions attached; the transcript keeps the typed text.
	#withMentions(prompt: string): string {
		try {
			const cwd = this.#session.sessionManager?.getCwd?.() ?? process.cwd();
			const { prompt: expanded, notices } = expandMentions(prompt, cwd);
			if (notices.length) {
				this.#projector.add("system", notices.join("\n"));
				this.#render();
			}
			return expanded;
		} catch (error) {
			this.#projector.add("system", `mention expansion failed, sent as typed: ${error instanceof Error ? error.message : String(error)}`);
			this.#render();
			return prompt;
		}
	}

	// Enter with the autocomplete open applies the selection (pi-tui Editor); a command-name completion then
	// submits, an argument completion stays in the draft.
	submitDraft(): Promise<void> {
		if (this.#closed) return Promise.resolve();
		if (this.#workViewId !== undefined && !this.#ui.active) return Promise.resolve();
		if (this.#stepInspector && !this.#ui.active) return Promise.resolve();
		if (this.#mcpManager.open && !this.#ui.active) { this.#mcpManager.key({ kind: "submit" }); return Promise.resolve(); }
		if (this.#treePickerOpen) return this.#navigateSessionTree();
		const owned = this.#ui.active || this.#dialog?.active || this.#btw?.active || this.#modelPickerOpen;
		if (!owned && this.#complete.active && !this.#complete.enter()) return Promise.resolve();
		this.#complete.close();
		return this.submit(this.#editor.expandedText);
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
			if (name === "tree") return this.#openSessionTree();
			// Pi replaces the session through its runtime, which rebinds this bridge: the transcript is
			// reseeded from the new (empty) session, so the pane starts over here exactly as /new does.
			if (name === "new") {
				if (!this.#newSession) return say("new session unavailable in this Tern pane");
				const outcome = await this.#newSession();
				if (outcome?.cancelled) return say("New session cancelled");
				return say("Started a new session");
			}
			// /resume is Pi's picker name; Tern runs the extension command that owns the picker (extensions/tern-resume).
			if (name === "resume") {
				say("Loading sessions…");
				return await s.prompt("/tern-resume");
			}
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
		this.#projector.apply({ type: "agent_end" });
		this.#projector.add("system", "cancelled");
		this.#render();
	}

	close(): void {
		this.#workUnsubscribe?.();
		this.#workUnsubscribe = null;
		clearTimeout(this.#drawingTimer);
		this.#drawingTimer = undefined;
		clearInterval(this.#workViewTimer);
		this.#workViewTimer = undefined;
		if (this.#closed) return;
		this.#closed = true;
		this.#mcpManager.close();
		this.#gitRequest++;
		clearInterval(this.#gitTimer);
		this.#repoWatch?.();
		this.#mcpUnsubscribe?.();
		this.#mcpUnsubscribe = undefined;
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
