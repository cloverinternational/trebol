// Minimal Pi-to-TSP bridge. Projects Pi session events into TSP nodes on one inline surface:
// `main` holds the keyed transcript and tool cards, `dock` holds the composer and status.
// Tern submit/cancel/close actions and typed keys map back onto the Pi session.
// Pi remains the authority for prompts and tools; this module adds no grants. Extension UI prompts
// (select, confirm, input, editor, notify, text widgets) are answered by native Tern dialogs (ext-ui.ts),
// so every extension command works without per-command code. They resolve only from user action.
import { onRunningWorkChange, runningWorkSnapshot, type RunningWorkItem } from "../ui/running-work-store.ts";
import { readSubagentConversationCached } from "../ui/running-work-view.ts";
import {
	autocompleteCommands,
	EMPTY_COMMAND_SOURCE,
	buildCatalog,
	routeSubmission,
	type CommandSource,
} from "./commands.ts";
import type { Model } from "@earendil-works/pi-ai";
import { encodeTspBlob, projectTranscript, type TspMessage, type TspNode, type TspWriter, TernInlineSurface } from "./tsp.ts";
import { composerNodes, modelDisplayName, type GitFacts } from "./composer-view.ts";
import { artifactNodes, previewFile, type ArtifactPreview } from "./artifact-previews.ts";
import { readMcpStatus, subscribeMcpStatus } from "../tools/mcp-status.ts";
import { STARTUP_CSS, gitDiffNodes, gitDismissNode, gitFileRefs, gitStatusNodes, readRepoStatus, startupBlob, startupNodes, trebolVersion, watchRepo, type GitFileRef, type RepoStatus } from "./startup-card.ts";
import { readFileDiff, type GitSection } from "./git-status.ts";
import { patchArtifactPaths } from "../tools/swarm-artifacts.ts";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { readGitFacts } from "./git-facts.ts";
import { PI_COMPOSER_CSS } from "./composer-style.ts";
import { TERN_WORK_CSS } from "./work-style.ts";
import { TERN_MARKDOWN_CSS } from "./markdown-style.ts";
import { projectTaskView, type TaskView, type TaskViewRow, type TaskViewSessionManager } from "./task-view.ts";
import { buildBoard } from "./task-board.ts";
import { ASK_OPTIONS_ID, TernAskDialog, type AskEventBus } from "./ask-dialog.ts";
import { TernBtwCard } from "./btw-card.ts";
import { TernExtensionUI, UI_PROMPT_INPUT_ID, UI_PROMPT_LIST_ID } from "./ext-ui.ts";
import { createClipboard, imageExtension } from "./clipboard.ts";
import type { KeyEffect } from "./keys.ts";
import { AUTOCOMPLETE_ID, SlashAutocomplete, type Edit } from "./autocomplete.ts";
import { expandMentions } from "./mentions.ts";
import { activityView, currentTaskLine, MAX_ACTIVE_STEPS, rowLine, stepHead, type CurrentTask } from "./work-summary.ts";
import { goalLine, isAbortedAssistant, isCancellationError, isFailedAssistant, isTurnBoundary, liveLineText, SETTLED_LABEL, segmentTranscript, summarizeToolGroup } from "./turn-groups.ts";
import { DraftEditor, isLargePaste, type HostEdit } from "./draft-edit.ts";
import { ATTACHMENT_LIMITS, ATTACHMENT_REMOVE, attachmentChips, attachmentFromNodeId, attachmentPayload, attachmentSummary, loadAttachment, parseDroppedPaths, type Attachment, type ImageContentLike } from "./attachments.ts";
import { getNativeClipboard } from "@earendil-works/pi-tui";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { extractBashDisplayText } from "../tools/swarm-bash.ts";
import { queueGroups, queueNodes } from "./queue-view.ts";

export interface PiEventLike {
	type: string;
	[key: string]: unknown;
}

export interface PiSessionLike {
	subscribe(listener: (event: PiEventLike) => void): () => void;
	prompt(text: string, options?: { streamingBehavior?: "steer" | "followUp"; images?: ImageContentLike[] }): Promise<void>;
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

const GIT_STATUS_TTL_MS = 10_000;
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
	startedAt?: number;
	took?: number;
	exit?: number;
	timedOut?: boolean;
	// Completion order among finished steps, so "latest" follows what finished last rather than what started last.
	doneSeq?: number;
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
	#doneSeq = 0;

	get items(): readonly Item[] {
		return this.#items;
	}

	replaceFromSessionBranch(entries: readonly unknown[]): void {
		this.#items = [];
		this.#current = null;
		this.#localUserPending = false;
		this.#turnOpen = false;
		this.#turnStart = 0;
		this.#groupViews.clear();
		this.#doneSeq = 0;
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
				this.#items.push({ id: `t-${call.id}`, role: "tool", text: `tool ${call.name}`, status: "running", name: call.name, args: call.arguments });
			}
		}
		// A call with no persisted result was interrupted before the session was saved.
		for (const item of this.#items) {
			if (item.role === "tool" && item.status === "running") {
				item.status = "error";
				item.cancelled = true;
			}
		}
	}

	#settleRestoredTool(result: ToolResultLike): void {
		const item = this.#items.find((i) => i.id === `t-${result.toolCallId}`);
		if (!item || item.status !== "running") return;
		const details = result.details as { exit_code?: unknown; duration_ms?: unknown } | undefined;
		item.exit = typeof details?.exit_code === "number" && details.exit_code !== 0 ? details.exit_code : undefined;
		item.status = result.isError || item.exit !== undefined ? "error" : "ok";
		item.doneSeq = ++this.#doneSeq;
		item.took = typeof details?.duration_ms === "number" ? details.duration_ms : undefined;
		const text = messageText(result);
		if (item.status === "error") item.errorText = text;
		item.output = item.name?.toLowerCase() === "bash" && !result.isError ? extractBashDisplayText(text) : resultText(text);
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
				const prior = this.#items.find((i) => i.id === `t-${String(event.toolCallId)}`);
				if (prior) return false;
				this.#items.push({
					id: `t-${String(event.toolCallId)}`,
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
				const item = this.#items.find((i) => i.id === `t-${String(event.toolCallId)}`);
				if (!item || item.status !== "running") return false;
				const output = item.name?.toLowerCase() === "bash" ? messageText(event.partialResult) : resultText(event.partialResult);
				if (output === item.output) return false;
				item.output = output;
				return true;
			}
			case "tool_execution_end": {
				const item = this.#items.find((i) => i.id === `t-${String(event.toolCallId)}`);
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
					item.doneSeq = ++this.#doneSeq;
					if (item.status === "error") item.errorText = resultBody;
					if (item.name === "TaskManage") item.batch = taskManageBatch(event.result);
					item.text = `tool ${String(event.toolName)} ${item.status}`;
					// A cancelled tool may have no final payload. Retain the last live snapshot.
					const final = item.name?.toLowerCase() === "bash" ? messageText(event.result) : resultText(event.result);
					// The final model envelope merges streams by channel, strips ANSI, and may
					// truncate. The last live snapshot is the full ordered terminal output;
					// only fall back to the envelope when no update ever arrived.
					if (!item.output && final) item.output = item.name?.toLowerCase() === "bash" && !event.isError ? extractBashDisplayText(final) : final;
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

	nodes(outputExpanded = false, options: { currentTask?: CurrentTask } = {}): TspNode[] {
		const out: TspNode[] = [];
		const segments = segmentTranscript(this.#items);
		// Only the newest turn can still be running; an earlier group is settled once a user message follows it.
		let openGroup = -1;
		if (this.#turnOpen) {
			for (let i = segments.length - 1; i >= 0; i--) {
				const s = segments[i]!;
				if (s.kind === "tools") {
					if (this.#items.indexOf(s.items[0]!) >= this.#turnStart) openGroup = i;
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
		let goal = "";
		segments.forEach((segment, i) => {
			if (segment.kind === "tools") {
				const turnOpen = i === openGroup;
				// toolGroupNode labels the current task only in the live (running) group.
				out.push(...toolGroupNode(segment.items, { goal, tail: turnOpen ? tail : "", outputExpanded, turnOpen, view: this.#groupViews.get(groupId(segment.items)), currentTask: options.currentTask }));
				return;
			}
			const { item } = segment;
			if (isTurnBoundary(item)) goal = goalLine(item.text);
			// A message with no visible text (thinking or tool calls only) has nothing to show.
			if (item.role === "assistant" && item.text.trim() === "") return;
			// A visible custom notice (agent completed, goal, monitor, schedule) is one muted line, never a block.
			if (item.turnStart) {
				// Auto-graph's planned chart draws natively; its ASCII text is the fallback for renderers without Tern.
				if (item.chart) {
					out.push(item.chart);
					return;
				}
				out.push({ id: `msg-${item.id}`, k: "text", p: { role: "tern.notice", tone: "muted", wrap: "none", truncate: "end", text: goalLine(item.text) } });
				return;
			}
			out.push(...projectTranscript([{ id: item.id, role: item.role as Exclude<Role, "tool">, text: item.text, streaming: item.streaming }]));
		});
		return out;
	}

	setGroupCollapsed(groupId: string, collapsed: boolean): void {
		this.#groupViews.set(groupId, { ...this.#groupViews.get(groupId), minimized: collapsed });
	}

	setGroupView(groupId: string, view: DetailView): void {
		this.#groupViews.set(groupId, { ...this.#groupViews.get(groupId), minimized: false, view });
	}

	clearGroupViews(): void {
		this.#groupViews.clear();
	}
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

// Three presentations per group. Opening a card is a request to see the work, so an opened group shows every
// step (All steps) whether it is live or settled; the activity panel is an explicit choice that persists through
// streamed updates. Minimize persists the same way.
type DetailView = "activity" | "all";
interface GroupView { minimized?: boolean; view?: DetailView }

interface GroupContext {
	goal: string;
	tail: string;
	outputExpanded: boolean;
	turnOpen: boolean;
	view: GroupView | undefined;
	currentTask: CurrentTask | undefined;
}

const ACTIVITY_LABEL = "Activity";
const ALL_STEPS_LABEL = "All steps";

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
	const badges = failureBadge(summary);
	// The head says the turn's state and names its request; each step below carries its own verb and target.
	const age = live ? liveAge(tools) : undefined;
	const took = live ? undefined : summary.durationMs;
	if (live) {
		const line = liveLineText(ctx.goal, summary.active);
		// Steps first: the head already says "N steps", so the opened body must show those steps. The activity
		// panel stays one control away (and Ctrl+O still opens everything on every card).
		const mode: DetailView = ctx.view?.view ?? "all";
		// The live header is the settled card's id, key and kind, so it keeps identity through streaming, expansion
		// and settlement.
		const card: TspNode = {
			id, k: "tool",
			p: {
				role: "tern.work-live", key: id, name: "work", title: line.split(" · ")[0], status: "running", text: line,
				...(ctx.goal ? { target: ctx.goal, targetKind: "text" } : {}),
				...(age !== undefined ? { age } : {}),
				...(badges.length > 0 ? { badges } : {}),
				frame: "card", collapsible: true, collapsed: minimized, meta: [steps],
			},
			c: minimized ? workBody(id, items, ctx.currentTask, ctx.outputExpanded, "all", ctx.goal, true) : workBody(id, items, ctx.currentTask, ctx.outputExpanded, mode, ctx.goal, true),
		};
		// Only a minimized live group needs the one-line tail; the activity panel already carries narration.
		const tail: TspNode[] = minimized && ctx.tail ? [{ id: `${id}-tail`, k: "text", p: { role: "tern.work-tail", tone: "muted", wrap: "none", truncate: "end", text: ctx.tail } }] : [];
		return [card, ...tail];
	}
	// Narration whose tool calls never started (the turn ended first) is just what the agent said.
	if (tools.length === 0) return items.filter((item) => item.text.trim()).flatMap((item) => projectTranscript([{ id: item.id, role: "assistant", text: item.text, streaming: item.streaming }]));
	const status = summary.status === "done" ? "done" : summary.status === "failed" ? "error" : "cancelled";
	return [{
		id, k: "tool",
		p: {
			role: "tern.work", key: id, name: "work", title: SETTLED_LABEL[summary.status], status,
			...(ctx.goal ? { target: ctx.goal, targetKind: "text" } : {}),
			...(took !== undefined ? { took } : {}),
			...(badges.length > 0 ? { badges } : {}),
			frame: "card", collapsible: true, collapsed: minimized,
			meta: [steps],
		},
		c: workBody(id, items, undefined, ctx.outputExpanded, "all"),
	}];
}

const textNode = (id: string, role: string, text: string, tone: string, extra: Record<string, unknown> = {}): TspNode => ({ id, k: "text", p: { role, tone, wrap: "none", truncate: "end", text, ...extra } });

// Every step is its own `tool` head, in call order, with narration written between them left in place. A nested
// `tool` draws unframed inside the group card, so a turn reads as one card of steps rather than one card of rows.
// The group's controls come first, so an opened card shows how to fold it again without scrolling past the steps.
function workBody(groupId: string, items: readonly Item[], currentTask: CurrentTask | undefined, outputExpanded: boolean, mode: DetailView | "all", goal = "", live = false): TspNode[] {
	return mode === "activity" ? activityBody(groupId, items, currentTask, outputExpanded, goal) : allStepsBody(groupId, items, currentTask, outputExpanded, mode === "all" && live, goal);
}

// A settled group has no activity panel, so it offers only Collapse work. Live groups always offer the mode
// chip, for the whole turn: deriving it from "a step is running right now" deleted and re-added the chip at
// every step boundary, which is a new element each time and drops whatever the host had on it (measured by
// tools/tern/style-lint.mjs, rule fold-reset).

function activityBody(groupId: string, items: readonly Item[], currentTask: CurrentTask | undefined, outputExpanded: boolean, goal: string): TspNode[] {
	const out: TspNode[] = [...controls(groupId, "activity")];
	const tools = items.filter((item) => item.role === "tool");
	const view = activityView(tools, currentTask, goal);
	// The head already carries the turn's request as its target, so the heading adds only the tracked task.
	if (currentTask) out.push(textNode(`${groupId}-focus`, "tern.work-focus", currentTaskLine(currentTask), "accent"));
	// The running steps, each with its own spinner and terminal-clocked timer. No list: a step head carries more
	// state than a row can (status, exit, note, target kind) and animates without a repaint from us.
	const running = tools.filter((item) => item.status === "running" && item.cancelled !== true);
	for (const item of running.slice(0, MAX_ACTIVE_STEPS)) out.push(toolRow(item, outputExpanded));
	if (view.moreActive > 0) out.push(textNode(`${groupId}-overflow`, "tern.work-overflow", `+${view.moreActive} more running`, "muted"));
	if (view.latest) out.push(textNode(`${groupId}-latest`, "tern.work-latest", `Last · ${rowLine(view.latest)}`, view.latest.tone === "error" ? "error" : "muted"));
	if (view.failed) out.push(textNode(`${groupId}-failed`, "tern.work-failed", `${view.failed.count} failed · ${rowLine(view.failed.last)}`, "error"));
	if (view.active.length === 0) out.push({ id: `${groupId}-preparing`, k: "shimmer", p: { role: "tern.work-preparing", text: "Preparing next action" } });
	return out;
}

function allStepsBody(groupId: string, items: readonly Item[], currentTask: CurrentTask | undefined, outputExpanded: boolean, live: boolean, goal = ""): TspNode[] {
	const out: TspNode[] = [...controls(groupId, live ? "all" : undefined)];
	// The head already carries the turn's request as its target, so the heading adds only the tracked task.
	if (currentTask) out.push(textNode(`${groupId}-focus`, "tern.work-focus", currentTaskLine(currentTask), "accent"));
	for (const item of items) {
		if (item.role === "tool") {
			out.push(toolRow(item, outputExpanded));
			continue;
		}
		if (item.text.trim()) out.push({ id: `${item.id}-note`, k: "md", p: { role: "tern.work-note", text: item.text, stream: item.streaming === true } });
	}
	return out;
}

// The last control is always Collapse work, which closes only this group.
function controls(groupId: string, mode: DetailView | undefined): TspNode[] {
	const chips: TspNode[] = [];
	if (mode === "activity") chips.push(textNode(`${groupId}-all`, "tern.work-mode", ALL_STEPS_LABEL, "muted", { actions: { click: `work.all=${groupId}` } }));
	if (mode === "all") chips.push(textNode(`${groupId}-activity`, "tern.work-mode", ACTIVITY_LABEL, "muted", { actions: { click: `work.activity=${groupId}` } }));
	chips.push(textNode(`${groupId}-collapse`, "tern.work-collapse", "Collapse work", "muted", { actions: { click: `work.collapse=${groupId}` } }));
	// One row, so the chips sit side by side on a single quiet line instead of stacking as two transcript lines.
	return [{ id: `${groupId}-controls`, k: "row", p: { role: "tern.work-controls", gap: "sm", align: "center" }, c: chips }];
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
	if (item.output) node.c = [{ id: `${item.id}-out`, k: "text", p: { text: running ? tailWindow(item.output, STEP_LIVE_LINES) : item.output } }];
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
			...(status === "running" ? { age: elapsed } : { took: elapsed }),
		},
		c: [{ id: `${item.id}-body`, k: "col", p: { role: "tasks.body", gap: "none" }, c: [
			{
				id: `${item.id}-list`, k: "checklist",
				p: {
					role: "tasks.list",
					phases: [{ id: `${item.id}-phase`, title: `${ops.length} op${ops.length === 1 ? "" : "s"}`, items: items.length ? items : [{ id: `${item.id}-empty`, text: "No operations", status: "pending" }] }],
				},
			},
		] }],
	};
}

// Mirror OMP's native bash describeCall/describeResult: the head carries the command as a `command` target
// (syntax-classed, copyable) and the description as the intent tooltip, while a single borderless run contains
// the command, the tailing output and the state foot.
function bashToolNode(item: Item, status: "running" | "done" | "error" | "cancelled", outputExpanded: boolean): TspNode {
	const args = item.args as { command?: unknown; description?: unknown; name?: unknown } | undefined;
	const command = typeof args?.command === "string" && args.command ? args.command : "…";
	// OMP's optional name annotates the verb; the description becomes the head's intent.
	const label = typeof args?.name === "string" && args.name ? `Bash · ${args.name}` : "Bash";
	const head = stepHead("bash", item.args);
	// A command long enough to be truncated in the head is shown in full in the body, which is where it can wrap.
	const headTarget = head.target !== undefined && head.target.length > STEP_HEAD_TARGET ? `${head.target.slice(0, STEP_HEAD_TARGET - 1)}…` : head.target;
	const showsCommand = command.length > STEP_HEAD_TARGET || command.includes("\n");
	const elapsed = status === "running" ? Date.now() - (item.startedAt ?? Date.now()) : item.took ?? 0;
	const state = status === "running" ? "Running" : status === "cancelled" ? "Cancelled" : item.timedOut ? "Timed out" : status === "error" ? item.exit !== undefined ? `exit ${item.exit}` : "Failed" : "Done";
	const tone = status === "running" ? "pending" : status === "done" ? "success" : status === "cancelled" ? "muted" : item.timedOut ? "warning" : "error";
	const foot: TspNode = {
		id: `${item.id}-foot`, k: "row", p: { role: "omp.run.foot", gap: "sm", align: "center" },
		c: [
			{ id: `${item.id}-state`, k: "text", p: { role: "omp.run.state", tone, spans: [{ t: state }] } },
			{ id: `${item.id}-elapsed`, k: "elapsed", p: { role: "omp.run.time", age: elapsed, ...(status === "running" ? {} : { stopped: elapsed }), format: "short" } },
		],
	};
	const run: TspNode = {
		// `sm` inside the box: the command, its output and the state foot are three different things.
		id: `${item.id}-run`, k: "col", p: { role: "omp.run", gap: "sm", ...(status === "error" ? { tone: item.timedOut ? "warning" : "error" } : {}) },
		c: [
			...(showsCommand ? [{ id: `${item.id}-cmd`, k: "code", p: { role: "omp.tool.bash.command", lang: "bash", wrap: true, text: command.trimEnd() } }] : []),
			...(item.output?.trim() ? [{ id: `${item.id}-out`, k: "ansi", p: { role: "omp.tool.bash.output", text: status === "running" ? tailWindow(item.output, STEP_LIVE_LINES) : item.output, follow: true } }] : []),
			foot,
		],
	};
	return {
		id: item.id, k: "tool",
		p: {
			role: "omp.tool.bash", key: item.id.slice(2), name: "bash", title: label,
			...(headTarget !== undefined ? { target: headTarget, targetKind: "command" } : {}),
			...(head.intent !== undefined ? { intent: head.intent } : {}),
			// Open while it runs, so the tail of its output is visible; folded once settled, where the head keeps the
			// command, the state, the exit code and the duration. Ctrl+O opens every step.
			command, status, frame: "inline", collapsible: true, collapsed: status !== "running" && !outputExpanded,
			...(status === "running" ? { age: elapsed } : { took: elapsed }),
			...(item.exit !== undefined ? { exit: item.exit } : {}),
			...(item.timedOut ? { note: "timed out" } : {}),
		},
		c: [run],
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
		c: [
			{
				id: `${item.id}-body`, k: "col", p: { role: "tern.work-patch", gap: "sm" },
				c: sections.slice(0, MAX_PATCH_FILES_SHOWN).map((section, i) => ({
					id: `${item.id}-diff-${i}`, k: "diff",
					p: { role: "tern.work-patch.diff", text: section.lines.join("\n"), path: section.path },
				})),
			},
		],
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
	clipboard?: { filePaths(): Promise<string[] | null | undefined>; image(): Promise<Uint8Array | null | undefined>; text(): Promise<string | null | undefined>; saveImage?(bytes: Uint8Array): string };
}


const BACKGROUND_WORK_MAX_ROWS = 5;
// A running step stays open, so its body is a bounded tail of what it printed: Tern's own `preview` gives way
// inside an open tool, and an unbounded body would push the rest of the turn off screen.
const STEP_LIVE_LINES = 12;
// The head stays one readable line; a longer command is repeated (wrapped) in the body where it can be read.
const STEP_HEAD_TARGET = 64;
const MAX_PATCH_FILES_SHOWN = 3;

// The last `lines` lines of a live stream, with an explicit count of what is held back (never silently cut).
function tailWindow(text: string, lines: number): string {
	const all = text.replace(/\s+$/, "").split("\n");
	if (all.length <= lines) return text;
	const hidden = all.length - lines;
	return `… ${hidden} earlier ${hidden === 1 ? "line" : "lines"}\n${all.slice(-lines).join("\n")}`;
}
const BACKGROUND_WORK_LABEL_CHARS = 80;
const boundedChars = (value: string, limit: number) => { const chars = Array.from(value.replace(/\s+/g, " ").trim()); return chars.length > limit ? `${chars.slice(0, limit - 1).join("")}…` : chars.join(""); };
/** Bash shows its command; a subagent shows its task. Full text stays in the row title. */
const backgroundWorkLabel = (item: RunningWorkItem) => boundedChars(item.kind === "bash" ? item.detail : `${item.label} · ${item.detail}`, BACKGROUND_WORK_LABEL_CHARS);
/** Latest non-empty output line for bash, read without changing the process (readOutput only drains buffers). */
function backgroundWorkTitle(item: RunningWorkItem): string {
	let latest = "";
	try { latest = (item.readOutput?.() ?? item.output ?? "").split("\n").filter((line) => line.trim()).at(-1) ?? ""; } catch { latest = ""; }
	return [item.label, item.detail, latest ? `last output: ${boundedChars(latest, 120)}` : ""].filter(Boolean).join("\n");
}
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
	#gitView: { mode: "list" } | { mode: "diff"; ref: GitFileRef; text: string } | undefined;
	// Bumped on every Git view navigation, session change and close; a diff read lands only if it is still the latest.
	#gitRequest = 0;
	#gitRefs: GitFileRef[] = [];
	// Background item whose output sheet is open, and the timer that keeps its output fresh.
	#workViewId: string | undefined;
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
	#treePickerItems: Array<{ id: string; label: string; description?: string }> = [];
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
	#taskQuestionsCollapsed = false;
	#taskBoardMode = false;
	#toolOutputExpanded = false;
	readonly #kinds: readonly string[];
	#git: GitFacts | undefined;
	#gitRefreshing = false;
	#gitTimer: ReturnType<typeof setInterval> | undefined;
	#columns = 100;
	readonly #ui: TernExtensionUI;
	readonly #clipboard: NonNullable<BridgeOptions["clipboard"]>;
	// Images and files waiting above the composer for the next submit (attachments.ts).
	#attachments: Attachment[] = [];
	#attachmentSeq = 0;

	constructor(session: PiSessionLike, options: BridgeOptions) {
		this.#session = session;
		this.#write = options.write;
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
		this.#surface.stylesheet("startup", STARTUP_CSS);
		this.#surface.stylesheet("work", TERN_WORK_CSS);
		this.#surface.stylesheet("markdown", TERN_MARKDOWN_CSS);
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
		this.#render();
	}

	// Resets per-session state when Pi's active session changes.
	#syncSession(): void {
		const id = sessionIdOf(this.#session);
		if (id === this.#sessionId) return;
		this.#sessionId = id;
		this.#gitRequest++;
	}

	// Sends picture blobs before re-rendering, so no frame references a blob Tern has not received.
	async #previewArtifacts(event: PiEventLike): Promise<void> {
		const name = String(event.toolName);
		const args = (this.#projector.items.find((i) => i.id === `t-${String(event.toolCallId)}`)?.args ?? {}) as Record<string, unknown>;
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
		const item = this.#projector.items.find((i) => i.id === `t-${String(event.toolCallId)}`);
		if (!item) return;
		for (const preview of previews) {
			if (!preview.blob) continue;
			for (const chunk of encodeTspBlob(preview.blob.id, preview.blob.mime, preview.blob.base64)) this.#write(chunk);
		}
		item.artifacts = previews;
		this.#render();
	}

	#onEvent(event: PiEventLike): void {
		if (this.#closed) return;
		this.#onEventTap?.(event);
		if (event.type === "session_tree") {
			const branch = this.#session.sessionManager?.getBranch?.();
			if (Array.isArray(branch)) this.#projector.replaceFromSessionBranch(branch);
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
			this.#busy = false;
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
		if (this.#dialog?.active) return [...this.#taskTop(), ...this.#dialog.nodes(this.#columns)];
		if (this.#btw?.active) return [...this.#taskTop(), ...this.#btw.nodes()];
		const work = this.#backgroundWork();
		const usage = contextUsageOf(this.#session) as { tokens?: unknown; contextWindow?: unknown } | undefined;
		const window = typeof usage?.contextWindow === "number" && usage.contextWindow > 0 ? usage.contextWindow : undefined;
		const tokens = typeof usage?.tokens === "number" && Number.isFinite(usage.tokens) ? usage.tokens : null;
		const compactAt = window !== undefined ? compactionPercent(this.#session, window) : undefined;
		const typed = (text: string) => this.#queuedTyped.get(text) ?? text;
		const queue = queueNodes(queueGroups(this.#queuedSteering.map(typed), this.#queuedFollowUp.map(typed)));
		return [...work, ...queue, ...this.#ui.widgetNodes("aboveEditor"), ...composerNodes({
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
			cost: costOf(this.#session),
			...(this.#attachments.length ? { chips: attachmentChips(this.#attachments) } : {}),
		}, this.#taskTop()), ...this.#ui.widgetNodes("belowEditor")];
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
		if (!runningWorkSnapshot().some((item) => item.id === id)) return;
		this.#workViewId = id;
		clearInterval(this.#workViewTimer);
		this.#workViewTimer = setInterval(() => {
			const item = runningWorkSnapshot().find((entry) => entry.id === this.#workViewId);
			if (item && backgroundWorkLive(item)) this.#render();
		}, BACKGROUND_OUTPUT_REFRESH_MS);
		this.#workViewTimer.unref?.();
		this.#render();
	}

	#closeWorkView(): void {
		clearInterval(this.#workViewTimer);
		this.#workViewTimer = undefined;
		this.#workViewId = undefined;
		this.#render();
	}

	// Stops only work that is still running and still offers a stop; the writer then settles the item in the store.
	#stopWork(id: string): void {
		const item = runningWorkSnapshot().find((entry) => entry.id === id);
		if (!item || !backgroundWorkLive(item) || !item.stop) return;
		try { item.stop(); } catch (error) {
			this.#projector.add("system", `Could not stop ${item.label}: ${error instanceof Error ? error.message : String(error)}`);
		}
		this.#render();
	}

	#openGitView(): void {
		if (!this.#repo?.git) return;
		this.#gitRequest++;
		this.#gitView = { mode: "list" };
		this.#render();
	}

	#showGitDiff(section: GitSection, path: string): Promise<void> {
		const repo = this.#repo;
		if (!repo?.git) return Promise.resolve();
		const ref = gitFileRefs(repo.snapshot).find((r) => r.section === section && r.entry.path === path);
		if (!ref) {
			this.#gitRequest++;
			this.#gitView = { mode: "list" };
			this.#render();
			return Promise.resolve();
		}
		const request = ++this.#gitRequest;
		const current = () => !this.#closed && request === this.#gitRequest;
		// The diff node is added only with its text: a later text update to an existing diff node is not applied by Tern.
		return readFileDiff(repo.root, ref.entry, section).then(
			(text) => {
				if (!current()) return;
				this.#gitView = { mode: "diff", ref, text };
				this.#render();
			},
			() => {
				if (!current()) return;
				this.#gitView = { mode: "diff", ref, text: "Diff unavailable." };
				this.#render();
			},
		);
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
		});
	}

	// Overlays float above `main` and `dock`. The ask flow is not here: it renders inline in `dock`.
	// The slash autocomplete is OMP's caret-anchored list; keys stay
	// in the editor and the bridge routes ↑/↓, Tab, Enter and Esc to it.
	#layer(): TspNode[] {
		if (this.#workViewId !== undefined) return backgroundWorkOutputNodes(runningWorkSnapshot().find((item) => item.id === this.#workViewId));
		if (this.#gitView && this.#repo?.git) {
			// The dismiss layer sits under the card, so a click outside the card closes the view.
			const dismiss = gitDismissNode();
			if (this.#gitView.mode === "diff") return [dismiss, gitDiffNodes(this.#gitView.ref, this.#gitView.text)];
			this.#gitRefs = gitFileRefs(this.#repo.snapshot);
			return [dismiss, gitStatusNodes(this.#repo, this.#gitRefs)];
		}
		if (this.#ui.active) return this.#ui.nodes();
		if (this.#treePickerOpen) return [this.#treePickerNode()];
		if (this.#modelPickerOpen) return [this.#modelPickerNode()];
		return this.#complete.nodes();
	}

	#treePickerNode(): TspNode {
		const items: unknown[] = [];
		const order: string[] = [];
		for (const item of this.#treePickerItems) {
			items.push({ id: item.id, label: item.label, ...(item.description ? { detail: item.description } : {}) });
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

	// Hoja-style kanban inside the task popover: status columns, one card per task, click to reference.
	// Same grouping as the TUI overlay (task-board.ts); rendering only, no task state here.
	#taskBoardNodes(tasks: TaskViewRow[]): TspNode[] {
		const marks: Record<string, string> = { todo: "○", in_progress: "◐", done: "●" };
		const model = buildBoard(tasks);
		return [{ id: "task-board", k: "row", p: { role: "pi.board" }, c: model.columns.map((col) => ({
			id: `task-board-${col.id}`, k: "col", p: { role: "pi.board.column", "data-status": col.id }, c: [
				{ id: `task-board-${col.id}-head`, k: "text", p: { role: "pi.board.head", text: `${marks[col.id] ?? "○"} ${col.title}  ${col.tasks.length}` } },
				...(col.tasks.length ? col.tasks.flatMap((t) => {
					const meta = [t.active ? "active" : "", t.blocked ? "blocked" : ""].filter(Boolean).join(" · ");
					return [{ id: `task-board-card-${t.id}`, k: "text", p: {
						role: "pi.board.card", tone: taskTone(t), text: `#${t.id} ${t.subject}`,
						title: `#${t.id} ${t.subject} · ${taskStatusLabel(t)}`, actions: { click: `tasks.reference=${t.id}` },
					} }, ...(meta ? [{ id: `task-board-meta-${t.id}`, k: "text", p: { role: "pi.board.meta", text: `  ${meta}` } }] : [])];
				}) : [{ id: `task-board-${col.id}-empty`, k: "text", p: { role: "pi.board.empty", text: "No tasks" } }]),
			],
		})) }];
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
	// Live background bash and subagent work as a card above the composer. Read-only projection of the
	// shared running-work store; hidden when nothing is queued or running. Foreground calls belong to the
	// turn's work line in the transcript, so they appear here only once moved to the background.
	#backgroundWork(now = Date.now()): TspNode[] {
		const live = runningWorkSnapshot().filter((item) => (item.status === "queued" || item.status === "running") && item.foreground !== true);
		if (!live.length) return [];
		// Clicking a row opens its output sheet. The x stops work that still runs; it is a sibling of the
		// clickable part, never nested in it, so one click runs exactly one action.
		const stopNode = (item: RunningWorkItem): TspNode[] => item.stop
			? [{ id: `bg-work-${item.id}-stop`, k: "text", p: { role: "pi.background.stop", spans: [{ t: "×", s: "error" }], aria: `Stop ${item.label}`, title: "Stop", wrap: "none", actions: { click: `bg.stop=${item.id}` } } }]
			: [];
		const rows: TspNode[] = live.slice(0, BACKGROUND_WORK_MAX_ROWS).map((item): TspNode => ({ id: `bg-work-${item.id}-line`, k: "row", p: { role: "pi.background.line", gap: "sm", align: "center" }, c: [item.kind === "subagent"
			// A subagent is a worker, so Tern draws it as one: a live pulse, its assignment, its own clock and its
			// token count. Only fields the running-work store really carries are sent.
			? {
				id: `bg-work-${item.id}`, k: "agent",
				p: {
					role: "pi.background.agent",
					name: boundedChars(item.label, BACKGROUND_WORK_LABEL_CHARS),
					task: item.detail,
					status: "running",
					stats: { age: Math.max(0, now - item.startedAt), ...(item.tokens ? { tokens: item.tokens } : {}) },
					grow: 1,
					actions: { click: `bg.open=${item.id}` },
				},
			}
			: {
				id: `bg-work-${item.id}`, k: "row", p: { role: "pi.background.row", gap: "sm", align: "center", grow: 1, title: backgroundWorkTitle(item), actions: { click: `bg.open=${item.id}` } }, c: [
					{ id: `bg-work-${item.id}-mark`, k: "text", p: { role: "pi.background.mark", text: "$", tone: "accent", wrap: "none" } },
					{ id: `bg-work-${item.id}-label`, k: "text", p: { text: backgroundWorkLabel(item), wrap: "none" } },
					{ id: `bg-work-${item.id}-time`, k: "elapsed", p: { age: Math.max(0, now - item.startedAt) } },
				],
			}, ...stopNode(item)] }));
		if (live.length > BACKGROUND_WORK_MAX_ROWS) rows.push({ id: "bg-work-more", k: "text", p: { role: "pi.background.more", text: `+${live.length - BACKGROUND_WORK_MAX_ROWS} more · /work`, wrap: "none", tone: "muted" } });
		return [{ id: "background-work", k: "card", p: { head: `Background work · ${live.length} running`, status: "running", tone: "accent", role: "pi.background" }, c: rows }];
	}

	// The one focused task Pi's task state reports, as a plain value for the work table (no inference from prose).
	#currentTask(): CurrentTask | undefined {
		const view = this.#taskView();
		return view?.status === "ready" && view.focus ? { id: view.focus.id, subject: view.focus.subject } : undefined;
	}

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
				{ id: "task-pop-head", k: "text", p: { role: "pi.tasks.head", text: `All tasks · ${open} open · ${tasks.length - open} done · ${this.#taskBoardMode ? "board" : "list"} (click to switch)`, actions: { click: "tasks.view" } } },
				...(this.#taskBoardMode ? this.#taskBoardNodes(tasks) : popRows),
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
		const transcript = this.#projector.nodes(this.#toolOutputExpanded, { currentTask: this.#currentTask() });
		this.#surface.render([...startupNodes(this.#logo, this.#version, this.#repo, readMcpStatus(this.#session.sessionManager?.getSessionId?.() as string | undefined)), ...transcript], this.#dock(), focus, this.#layer(), this.#complete.selectedId);
		try { this.#onRenderTap?.(transcript, this.#trigger, this.#busy); } catch { /* tracing never affects the UI */ }
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

	// Left/right (and Shift+Tab) move the ask-dialog tab when a dialog is open; otherwise they move the caret.
	moveTabOrCursor(delta: number): void {
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

	selectAllDraft(): void {
		this.#editField((field) => field.selectAll(), { kind: "set" });
	}

	// The composer takes Tern's `send` only when nothing else owns Enter; otherwise Tern holds the prompt.
	#composerSendable(): boolean {
		return !this.#closed && !this.#ui.active && !this.#dialog?.active && !this.#btw?.active && !this.#modelPickerOpen && !this.#treePickerOpen;
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
		if (this.#closed || this.#ui.active || this.#dialog?.active || this.#btw?.active || this.#modelPickerOpen || this.#treePickerOpen) return;
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
		if (this.#treePickerOpen) return;
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
		if (this.#workViewId !== undefined) {
			this.#closeWorkView();
			this.#lastEligibleEscapeAt = 0;
			return false;
		}
		if (this.#gitView) {
			this.#gitRequest++;
			this.#gitView = this.#gitView.mode === "diff" ? { mode: "list" } : undefined;
			this.#lastEligibleEscapeAt = 0;
			this.#render();
			return false;
		}
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
					this.#treePickerOpen = false;
					this.#treePickerSelected = undefined;
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
		if (msg.verb === "e" && msg.body.ev === "resize" && typeof msg.body.cols === "number" && msg.body.cols > 0) { this.#columns = msg.body.cols; if (this.#dialog?.active) this.#render(); }
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
		if (msg.verb === "e" && msg.body.ev === "key" && (this.#gitView || this.#workViewId !== undefined) && msg.body.key === "escape") {
			this.escape();
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
		if (act === "submit") return this.submit(submittedText(msg.body));
		if (act === ATTACHMENT_REMOVE) {
			const n = attachmentFromNodeId(msg.body.id);
			if (n !== undefined) this.removeAttachment(n);
			return undefined;
		}
		if (act === "submit.followUp") return this.submitFollowUp(submittedText(msg.body));
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
		if ((act === "work.all" || act === "work.activity") && typeof msg.body.value === "string") {
			this.#projector.setGroupView(msg.body.value, act === "work.all" ? "all" : "activity");
			this.#render();
			return undefined;
		}
		if (act === "tasks.reference" && typeof msg.body.value === "string") this.#referenceTask(msg.body.value);
		if (act === "tasks.view") {
			this.#taskBoardMode = !this.#taskBoardMode;
			this.#render();
		}
		if (act === "git.open") { this.#openGitView(); return undefined; }
		if (act === "bg.open" && typeof msg.body.value === "string") { this.#openWorkView(msg.body.value); return undefined; }
		if (act === "bg.close") { this.#closeWorkView(); return undefined; }
		if (act === "bg.stop" && typeof msg.body.value === "string") { this.#stopWork(msg.body.value); return undefined; }
		if (act === "git.file" && typeof msg.body.value === "string") {
			const ref = this.#gitRefs[Number(msg.body.value)];
			return ref ? this.#showGitDiff(ref.section, ref.entry.path) : undefined;
		}
		if (act === "git.back") { this.#gitRequest++; this.#gitView = { mode: "list" }; this.#render(); return undefined; }
		if (act === "git.close") { this.#gitRequest++; this.#gitView = undefined; this.#render(); return undefined; }
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
		return this.#sendPrompt(prompt);
	}

	// A plain prompt with the composer's attachments: queued as a follow-up during a turn (Pi's native
	// queued-message path for plain Enter), otherwise sent now.
	#sendPrompt(prompt: string): Promise<void> {
		if (this.#busy) return this.submitFollowUp(prompt);
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
		const prompt = text.trim();
		if (!prompt && !this.#attachments.length) return Promise.resolve();
		if (!this.#busy) return this.submit(prompt);
		this.#draft = "";
		const { text: { model: sent, typed }, images } = this.#takeAttachments(this.#withMentions(prompt), prompt);
		this.#queuedTyped.set(sent, typed);
		// Optimistic until Pi's queue_update replaces it; the dock's queue band shows it, not the transcript.
		this.#queuedFollowUp = [...this.#queuedFollowUp, sent];
		this.#render();
		return this.#session.prompt(sent, { streamingBehavior: "followUp", ...(images.length ? { images } : {}) }).catch((error: unknown) => {
			const queuedIndex = this.#queuedFollowUp.lastIndexOf(sent);
			if (queuedIndex >= 0) this.#queuedFollowUp.splice(queuedIndex, 1);
			this.#projector.add("system", `error queueing follow-up: ${error instanceof Error ? error.message : String(error)}`);
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
		clearInterval(this.#workViewTimer);
		this.#workViewTimer = undefined;
		if (this.#closed) return;
		this.#closed = true;
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
