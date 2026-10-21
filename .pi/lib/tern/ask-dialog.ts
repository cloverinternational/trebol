// Tern-side renderer for ask_user_question. It drives the remote-ask events on the Pi event bus.
// Mirrors the native flow: one tab per question plus a Submit review tab. Nothing is preselected,
// auto-submitted, or approved on the user's behalf; the ask tool validates answers.
import {
	PI_ASK_COMPLETED_EVENT,
	PI_ASK_STARTED_EVENT,
	PI_ASK_SUBMIT_EVENT,
	PI_ASK_SUBMIT_RESULT_EVENT,
	type RemoteAskResponse,
} from "../../../extensions/ask-user/src/remote-ask.ts";
import type { TspNode } from "./tsp.ts";

export interface AskEventBus {
	emit(channel: string, data: unknown): void;
	on(channel: string, handler: (data: unknown) => void): () => void;
}

export const ASK_NODE_PREFIX = "ask-";
const OPTION_PREFIX = "ask-opt:";
export const ASK_SUBMIT_ID = "ask-submit";
export const ASK_CANCEL_ID = "ask-cancel";
// Tab strip: `ask-tab-<question index>` per question, and `ask-tab-submit` for the review tab.
const TAB_PREFIX = "ask-tab-";
export const ASK_SUBMIT_TAB_ID = "ask-tab-submit";
// Native list of the current question's options. Its item ids are `ask-opt:<question>:<option>`.
export const ASK_OPTIONS_ID = "ask-options";
// Below this width the tab strip becomes a progress line and the flow is one question per screen.
export const NARROW_COLUMNS = 60;
const HINT_KEYS: Array<{ keys: string[]; label: string }> = [
	{ keys: ["up", "down"], label: "move" },
	{ keys: ["space"], label: "toggle" },
	{ keys: ["enter"], label: "confirm" },
	{ keys: ["left", "right"], label: "tab" },
	{ keys: ["esc"], label: "cancel" },
];
const CUSTOM_OPTION_VALUE = "__custom__";
const CUSTOM_OPTION_LABEL = "Type something";
const FREEFORM_ONLY_LABEL = "Type your answer";
const EDITOR_HINT = "type your answer · enter save · esc close editor (draft kept)";

type QuestionType = "single" | "multi" | "preview";

interface DialogOption {
	description?: string;
	freeform: boolean;
	label: string;
	value: string;
}

interface DialogQuestion {
	id: string;
	label: string;
	options: DialogOption[];
	prompt: string;
	required: boolean;
	type: QuestionType;
}

interface PendingFlow {
	action: number;
	error?: string;
	flowId: string;
	option: number[];
	questions: DialogQuestion[];
	requestId?: string;
	selected: Map<string, Set<string>>;
	// Saved freeform answers by question id, and the in-progress editor text (kept when the editor closes).
	custom: Map<string, string>;
	drafts: Map<string, string>;
	editing: boolean;
	tab: number;
	title?: string;
}

type Trigger = "toggle" | "confirm" | "digit" | "click";

let requestSeq = 0;

export class TernAskDialog {
	readonly #events: AskEventBus;
	readonly #onChange: () => void;
	readonly #unsubscribe: Array<() => void> = [];
	#queue: PendingFlow[] = [];

	constructor(events: AskEventBus, onChange: () => void) {
		this.#events = events;
		this.#onChange = onChange;
	}

	start(): void {
		this.#unsubscribe.push(
			this.#events.on(PI_ASK_STARTED_EVENT, (data) => this.#onStarted(data)),
			this.#events.on(PI_ASK_COMPLETED_EVENT, (data) => this.#onCompleted(data)),
			this.#events.on(PI_ASK_SUBMIT_RESULT_EVENT, (data) => this.#onSubmitResult(data)),
		);
	}

	// Stops listening and cancels every open flow, so a closing Tern pane never strands a tool call.
	dispose(): void {
		for (const off of this.#unsubscribe.splice(0)) off();
		for (const flow of this.#queue.splice(0)) {
			if (flow.requestId === undefined) this.#send(flow, { kind: "cancel" });
		}
	}

	get active(): boolean {
		return this.#queue.length > 0;
	}

	// Typed text goes to the freeform editor when it is open; otherwise Space toggles and digits pick.
	input(text: string): void {
		const editing = this.#editingFlow();
		if (editing) {
			const question = editing.questions[editing.tab];
			if (!question) return;
			editing.drafts.set(question.id, (editing.drafts.get(question.id) ?? "") + text);
			editing.error = undefined;
			this.#onChange();
			return;
		}
		if (text === " ") this.toggleCurrent();
		else if (/^[1-9]$/.test(text)) this.selectNumber(Number(text));
	}

	backspace(): void {
		const editing = this.#editingFlow();
		const question = editing?.questions[editing.tab];
		if (!editing || !question) return;
		editing.drafts.set(question.id, [...(editing.drafts.get(question.id) ?? "")].slice(0, -1).join(""));
		this.#onChange();
	}

	// Digits pick within the current question (or Submit/Cancel on the review tab), as in the native flow.
	selectNumber(number: number): boolean {
		const flow = this.#editable();
		if (!flow || !Number.isInteger(number) || number < 1) return false;
		if (flow.tab === flow.questions.length) {
			if (number > 2) return false;
			flow.action = number - 1;
			return this.#act(flow, "confirm");
		}
		const question = flow.questions[flow.tab];
		if (!question || number > question.options.length) return false;
		flow.option[flow.tab] = number - 1;
		return this.#act(flow, "digit");
	}

	// Left/Right and Tab/Shift+Tab move between question tabs and the Submit tab.
	moveTab(delta: number): boolean {
		const flow = this.#editable();
		if (!flow) return false;
		flow.tab = clamp(flow.tab + delta, 0, flow.questions.length);
		flow.error = undefined;
		this.#onChange();
		return true;
	}

	// Up/Down move the option cursor, or the Submit/Cancel action on the review tab.
	moveOption(delta: number): boolean {
		const flow = this.#editable();
		if (!flow) return false;
		if (flow.tab === flow.questions.length) {
			flow.action = clamp(flow.action + delta, 0, 1);
		} else {
			const question = flow.questions[flow.tab];
			if (!question) return false;
			flow.option[flow.tab] = clamp((flow.option[flow.tab] ?? 0) + delta, 0, question.options.length - 1);
		}
		this.#onChange();
		return true;
	}

	// Space: toggles the option under the cursor without advancing.
	toggleCurrent(): boolean {
		const flow = this.#editable();
		if (!flow || flow.tab === flow.questions.length) return false;
		return this.#act(flow, "toggle");
	}

	// Enter: saves the freeform editor, confirms the cursor option, or runs the selected action on the review tab.
	confirmCurrent(): boolean {
		const editing = this.#editingFlow();
		if (editing) return this.#saveInput(editing);
		const flow = this.#editable();
		if (!flow) return false;
		if (flow.tab === flow.questions.length) return flow.action === 0 ? this.submit() : this.cancel();
		return this.#act(flow, "confirm");
	}

	// Inline nodes that replace the composer in the dock while a flow is waiting. Empty when none is.
	nodes(columns = 100): TspNode[] {
		const flow = this.#queue[0];
		if (!flow) return [];
		const sending = flow.requestId !== undefined;
		const pending = this.#queue.length > 1 ? ` (+${this.#queue.length - 1} queued)` : "";
		const narrow = columns < NARROW_COLUMNS;
		const children: TspNode[] = [narrow ? this.#progressNode(flow) : this.#tabBar(flow)];
		children.push(...(flow.tab === flow.questions.length ? this.#reviewNodes(flow, sending) : this.#questionNodes(flow, sending)));
		if (flow.error) children.push({ id: "ask-error", k: "text", p: { text: flow.error, tone: "error", wrap: "soft" } });
		children.push(this.#hintNode(flow, sending, narrow));
		return [{
			id: "ask-dialog",
			k: "card",
			p: { head: `${flow.title ?? "Question"}${pending}`, role: "pi.ask" },
			c: children,
		}];
	}

	// Routes a Tern pointer action on an `ask-*` node. Returns true when the id belongs to the dialog.
	handleAction(id: string): boolean {
		if (!id.startsWith(ASK_NODE_PREFIX)) return false;
		if (id === ASK_SUBMIT_ID) this.submit();
		else if (id === ASK_CANCEL_ID) this.cancel();
		else if (id.startsWith(TAB_PREFIX)) this.#goToTab(id === ASK_SUBMIT_TAB_ID ? undefined : Number(id.slice(TAB_PREFIX.length)));
		else if (id.startsWith(OPTION_PREFIX)) {
			const [qi, oi] = id.slice(OPTION_PREFIX.length).split(":").map(Number);
			this.toggle(qi, oi);
		}
		return true;
	}

	// Tab tap: moves to that question, or to the review tab when index is undefined. Unknown indexes are ignored.
	#goToTab(index: number | undefined): boolean {
		const flow = this.#editable();
		if (!flow) return false;
		const target = index ?? flow.questions.length;
		if (!Number.isInteger(target) || target < 0 || target > flow.questions.length) return false;
		flow.tab = target;
		flow.error = undefined;
		this.#onChange();
		return true;
	}

	// Native list selection: a click toggles the option; a double-click (activate) confirms it and advances.
	handleSelect(item: string, activate: boolean): boolean {
		if (!item.startsWith(OPTION_PREFIX)) return false;
		const [qi = NaN, oi = NaN] = item.slice(OPTION_PREFIX.length).split(":").map(Number);
		if (!Number.isInteger(qi) || !Number.isInteger(oi)) return false;
		const flow = this.#editable();
		if (!flow || !flow.questions[qi] || !flow.questions[qi]!.options[oi]) return false;
		flow.tab = qi;
		flow.option[qi] = oi;
		return this.#act(flow, activate ? "confirm" : "click");
	}

	// Click on an option: moves the tab and cursor there, then toggles it (no auto-advance).
	toggle(questionIndex: number, optionIndex: number): boolean {
		const flow = this.#editable();
		if (!flow || !Number.isInteger(questionIndex) || !Number.isInteger(optionIndex)) return false;
		const question = flow.questions[questionIndex];
		if (!question || !question.options[optionIndex]) return false;
		flow.tab = questionIndex;
		flow.option[questionIndex] = optionIndex;
		return this.#act(flow, "click");
	}

	// Enter on the review tab, or the Submit action: sends only when every required question is answered.
	submit(): boolean {
		const flow = this.#editable();
		if (!flow) return false;
		const answers: Record<string, { values?: string[]; customText?: string }> = {};
		for (const [qi, question] of flow.questions.entries()) {
			const values = [...(flow.selected.get(question.id) ?? [])];
			const customText = flow.custom.get(question.id);
			if (values.length === 0 && !customText && question.required) {
				flow.error = `Answer required: ${question.label}`;
				flow.tab = qi;
				this.#onChange();
				return false;
			}
			if (values.length > 0 || customText) {
				answers[question.id] = {
					...(values.length > 0 ? { values } : {}),
					...(customText ? { customText } : {}),
				};
			}
		}
		this.#send(flow, { kind: "answer", answers, mode: "submit" });
		return true;
	}

	// Esc closes the freeform editor first (keeping its draft); otherwise cancels the head flow.
	// It never aborts the running turn.
	cancel(): boolean {
		const editing = this.#editingFlow();
		if (editing) {
			editing.editing = false;
			this.#onChange();
			return true;
		}
		const flow = this.#editable();
		if (!flow) return false;
		this.#send(flow, { kind: "cancel" });
		return true;
	}

	#editable(): PendingFlow | undefined {
		const flow = this.#queue[0];
		return flow && flow.requestId === undefined && !flow.editing ? flow : undefined;
	}

	#editingFlow(): PendingFlow | undefined {
		const flow = this.#queue[0];
		return flow && flow.requestId === undefined && flow.editing ? flow : undefined;
	}

	// Saves the freeform text as the answer for the current question and advances. Empty text is rejected.
	#saveInput(flow: PendingFlow): boolean {
		const question = flow.questions[flow.tab];
		if (!question) return false;
		const text = (flow.drafts.get(question.id) ?? "").trim();
		if (!text) {
			flow.error = "Type an answer, or press esc to close.";
			this.#onChange();
			return false;
		}
		flow.custom.set(question.id, text);
		if (question.type !== "multi") flow.selected.delete(question.id);
		flow.drafts.delete(question.id);
		flow.editing = false;
		flow.error = undefined;
		// Multi-choice keeps the tab so more options can be picked; single-choice advances like the native flow.
		if (question.type !== "multi") this.#advance(flow);
		this.#onChange();
		return true;
	}

	// Applies a choice on the current question. Returns false when nothing changed.
	#act(flow: PendingFlow, trigger: Trigger): boolean {
		const question = flow.questions[flow.tab];
		const option = question?.options[flow.option[flow.tab] ?? 0];
		if (!question || !option) return false;
		if (option.freeform) {
			// A saved multi-choice text toggles off with Space; otherwise the editor opens.
			if (question.type === "multi" && trigger === "toggle" && flow.custom.has(question.id)) {
				flow.custom.delete(question.id);
				flow.error = undefined;
				this.#onChange();
				return true;
			}
			flow.editing = true;
			flow.error = undefined;
			this.#onChange();
			return true;
		}
		if (question.type !== "multi") flow.custom.delete(question.id);
		const current = new Set(flow.selected.get(question.id) ?? []);
		const toggling = trigger === "toggle" || trigger === "click";
		if (question.type === "multi") {
			if (trigger !== "confirm") {
				if (current.has(option.value)) current.delete(option.value);
				else current.add(option.value);
			}
		} else if (toggling && current.has(option.value)) {
			current.clear();
		} else {
			current.clear();
			current.add(option.value);
		}
		flow.selected.set(question.id, current);
		// Enter always advances; a single-choice digit advances; Space and clicks never do.
		if (trigger === "confirm" || (trigger === "digit" && question.type !== "multi")) this.#advance(flow);
		flow.error = undefined;
		this.#onChange();
		return true;
	}

	#onStarted(data: unknown): void {
		if (!isRecord(data) || data.version !== 1 || typeof data.flowId !== "string") return;
		const questions = parseQuestions(data.questions);
		if (!questions) return;
		if (this.#queue.some((flow) => flow.flowId === data.flowId)) return;
		this.#queue.push({
			flowId: data.flowId,
			title: typeof data.title === "string" && data.title ? data.title : undefined,
			questions,
			selected: new Map(),
			custom: new Map(),
			drafts: new Map(),
			editing: false,
			tab: 0,
			option: questions.map(() => 0),
			action: 0,
		});
		this.#onChange();
	}

	#onCompleted(data: unknown): void {
		if (!isRecord(data) || typeof data.flowId !== "string") return;
		const before = this.#queue.length;
		this.#queue = this.#queue.filter((flow) => flow.flowId !== data.flowId);
		if (this.#queue.length !== before) this.#onChange();
	}

	#onSubmitResult(data: unknown): void {
		if (!isRecord(data) || data.version !== 1 || typeof data.requestId !== "string") return;
		const flow = this.#queue.find((candidate) => candidate.requestId === data.requestId);
		if (!flow) return;
		if (data.ok === true) {
			this.#onChange();
			return;
		}
		if (data.error === "flow_not_found") {
			this.#queue = this.#queue.filter((candidate) => candidate !== flow);
		} else {
			flow.requestId = undefined;
			flow.error = typeof data.message === "string" ? data.message : "Submit rejected.";
		}
		this.#onChange();
	}

	#advance(flow: PendingFlow): void {
		flow.tab = Math.min(flow.tab + 1, flow.questions.length);
		flow.action = 0;
	}

	#send(flow: PendingFlow, response: RemoteAskResponse): void {
		requestSeq += 1;
		const requestId = `tern-ask-${Date.now()}-${requestSeq}`;
		flow.requestId = requestId;
		flow.error = undefined;
		// Mark in-flight before emitting: the runtime answers synchronously.
		this.#events.emit(PI_ASK_SUBMIT_EVENT, { version: 1, flowId: flow.flowId, requestId, response });
		this.#onChange();
	}

	#tabBar(flow: PendingFlow): TspNode {
		const tabs: TspNode[] = flow.questions.map((question, qi) => ({
			id: `ask-tab-${qi}`,
			k: "text",
			p: {
				role: "pi.ask.tab",
				text: `${isAnswered(flow, question) ? "✓ " : ""}${question.label}`,
				...(qi === flow.tab ? { tone: "accent" } : {}),
				actions: { click: `ask-tab-${qi}` },
			},
		}));
		tabs.push({
			id: ASK_SUBMIT_TAB_ID,
			k: "text",
			p: { role: "pi.ask.tab", text: "Submit", ...(flow.tab === flow.questions.length ? { tone: "accent" } : {}), actions: { click: ASK_SUBMIT_TAB_ID } },
		});
		return { id: "ask-tabs", k: "row", p: { role: "pi.ask.tabs" }, c: tabs };
	}

	#questionNodes(flow: PendingFlow, sending: boolean): TspNode[] {
		const qi = flow.tab;
		const question = flow.questions[qi]!;
		const cursor = flow.option[qi] ?? 0;
		const selected = flow.selected.get(question.id);
		return [
			{ id: `ask-q-${qi}-prompt`, k: "text", p: { role: "pi.ask.prompt", text: `${question.prompt}${question.required ? "" : " (optional)"}`, wrap: "soft" } },
			{
				id: ASK_OPTIONS_ID,
				k: "list",
				p: { role: "pi.ask.options", selected: `${OPTION_PREFIX}${qi}:${cursor}` },
				c: question.options.map((option, oi) => this.#optionItem(flow, question, qi, oi, cursor, selected, sending)),
			},
		];
	}

	// One list row. Text is never wrapped by Tern, so the free-form draft and description go in `detail`.
	#optionItem(flow: PendingFlow, question: DialogQuestion, qi: number, oi: number, cursor: number, selected: Set<string> | undefined, sending: boolean): TspNode {
		const option = question.options[oi]!;
		const cursorMark = oi === cursor ? "›" : " ";
		const hint = oi < 9 ? [String(oi + 1)] : undefined;
		if (option.freeform) {
			const saved = flow.custom.get(question.id);
			const draft = flow.drafts.get(question.id);
			const body = flow.editing && oi === cursor ? `${draft ?? ""}▏` : (saved ?? draft);
			return {
				id: `${OPTION_PREFIX}${qi}:${oi}`,
				k: "item",
				p: { role: "pi.ask.option", label: `${cursorMark} ${option.label}`, detail: body ?? "", tone: saved ? "accent" : "muted", hint, disabled: sending },
			};
		}
		const on = selected?.has(option.value) ?? false;
		const mark = question.type === "multi" ? (on ? "[x]" : "[ ]") : on ? "(•)" : "( )";
		return {
			id: `${OPTION_PREFIX}${qi}:${oi}`,
			k: "item",
			p: {
				role: "pi.ask.option",
				label: `${cursorMark} ${mark} ${option.label}`,
				detail: option.description ?? "",
				tone: on ? "accent" : "muted",
				hint,
				disabled: sending,
			},
		};
	}

	// Narrow layout: no tab strip. Shows position and per-question state in one line.
	#progressNode(flow: PendingFlow): TspNode {
		const total = flow.questions.length;
		const dots = flow.questions.map((question, qi) => (qi === flow.tab ? "●" : isAnswered(flow, question) ? "✓" : "○")).join(" ");
		const text = flow.tab === total ? `Review · ${total} questions` : `Question ${flow.tab + 1} of ${total} · ${flow.questions[flow.tab]!.label}`;
		return { id: "ask-progress", k: "row", p: { role: "pi.ask.progress" }, c: [
			{ id: "ask-progress-text", k: "text", p: { text, tone: "accent", wrap: "soft" } },
			{ id: "ask-progress-dots", k: "text", p: { text: dots, tone: "muted" } },
		] };
	}

	// Keycap hints on the wide layout; narrow keeps only confirm and cancel so a line never wraps.
	#hintNode(flow: PendingFlow, sending: boolean, narrow: boolean): TspNode {
		if (sending || flow.editing) return { id: "ask-hint", k: "text", p: { text: sending ? "Sending…" : EDITOR_HINT, tone: "muted", wrap: "soft" } };
		const pairs = narrow ? HINT_KEYS.filter((pair) => pair.label === "confirm" || pair.label === "cancel") : HINT_KEYS;
		return { id: "ask-hint", k: "row", p: { role: "pi.ask.hint" }, c: pairs.flatMap((pair) => [
			{ id: `ask-hint-${pair.label}-keys`, k: "kbd", p: { keys: pair.keys } },
			{ id: `ask-hint-${pair.label}`, k: "text", p: { text: pair.label, tone: "muted" } },
		]) };
	}

	#reviewNodes(flow: PendingFlow, sending: boolean): TspNode[] {
		const rows: TspNode[] = flow.questions.map((question, qi) => ({
			id: `ask-review-${qi}`,
			k: "text",
			p: { role: "pi.ask.review", text: `${question.label}: ${answerText(flow, question)}`, wrap: "soft", ...(isAnswered(flow, question) ? {} : { tone: "muted" }) },
		}));
		const submitCursor = flow.action === 0 ? "›" : " ";
		const cancelCursor = flow.action === 1 ? "›" : " ";
		rows.push({
			id: "ask-actions",
			k: "col",
			p: { role: "pi.ask.actions" },
			c: [
				{ id: ASK_SUBMIT_ID, k: "text", p: { role: "pi.ask.action", text: `${submitCursor} 1. ${sending ? "Sending…" : "Submit"}`, ...(flow.action === 0 ? { tone: "accent" } : {}), ...(sending ? {} : { actions: { click: "ask-submit" } }) } },
				{ id: ASK_CANCEL_ID, k: "text", p: { role: "pi.ask.action", text: `${cancelCursor} 2. Cancel`, tone: "muted", ...(sending ? {} : { actions: { click: "ask-cancel" } }) } },
			],
		});
		return rows;
	}
}

function isAnswered(flow: PendingFlow, question: DialogQuestion): boolean {
	return (flow.selected.get(question.id)?.size ?? 0) > 0 || flow.custom.has(question.id);
}

function answerText(flow: PendingFlow, question: DialogQuestion): string {
	const custom = flow.custom.get(question.id);
	if (custom) return custom;
	const values = flow.selected.get(question.id);
	if (!values || values.size === 0) return question.required ? "(unanswered)" : "(skipped)";
	return question.options.filter((option) => values.has(option.value)).map((option) => option.label).join(", ");
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max);
}

function parseQuestions(value: unknown): DialogQuestion[] | undefined {
	if (!Array.isArray(value) || value.length === 0) return undefined;
	const out: DialogQuestion[] = [];
	for (const raw of value) {
		if (!isRecord(raw) || typeof raw.id !== "string" || typeof raw.prompt !== "string" || !Array.isArray(raw.options)) return undefined;
		const options: DialogOption[] = [];
		for (const option of raw.options) {
			if (!isRecord(option) || typeof option.value !== "string" || typeof option.label !== "string") return undefined;
			options.push({
				value: option.value,
				label: option.label,
				description: typeof option.description === "string" ? option.description : undefined,
				freeform: option.freeform === true,
			});
		}
		// Matches the native flow: a lone freeform option is the editor itself; otherwise add a trailing "Type something" row.
		const freeformOnly = options.length === 1 && options[0]!.freeform;
		if (freeformOnly) options[0] = { ...options[0]!, label: FREEFORM_ONLY_LABEL };
		else options.push({ value: CUSTOM_OPTION_VALUE, label: CUSTOM_OPTION_LABEL, freeform: true });
		out.push({
			id: raw.id,
			label: typeof raw.label === "string" && raw.label ? raw.label : raw.id,
			prompt: raw.prompt,
			type: raw.type === "multi" || raw.type === "preview" ? raw.type : "single",
			required: raw.required !== false,
			options,
		});
	}
	return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
