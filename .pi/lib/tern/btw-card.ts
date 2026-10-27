// Tern-side renderer for /btw. Pi mounts BtwView in its input slot; Tern cannot render a pi-tui Component,
// so the extension publishes BtwState snapshots and this card takes the composer slot, exactly like
// TernAskDialog does for ask_user_question. The card never answers on its own: the question is sent only
// when the user presses Enter, and abort/close only when they press Esc or click.
import {
	BTW_ABORT_EVENT,
	BTW_CLOSE_EVENT,
	BTW_STATE_EVENT,
	BTW_SUBMIT_EVENT,
	type BtwEntry,
	type BtwState,
} from "../../../extensions/swarm-btw/src/events.ts";
import type { TspNode } from "./tsp.ts";

export const BTW_CARD_ID = "btw-card";
export const BTW_INPUT_ID = "btw-input";
export const BTW_REQUEST_ID = "btw-request";
export const BTW_CLOSE_ID = "btw-close";
// Older turns stay as one-line context; the newest exchange is always what the card is about.
const HISTORY = 3;
const EMPTY_HINT = "Ask a side question…";

export interface BtwEventBus {
	emit(channel: string, data: unknown): void;
	on(channel: string, handler: (data: unknown) => void): () => void;
}

export class TernBtwCard {
	readonly #bus: BtwEventBus;
	readonly #onChange: () => void;
	#draft = "";
	#state: BtwState = { open: false, entries: [] };

	constructor(bus: BtwEventBus, onChange: () => void) {
		this.#bus = bus;
		this.#onChange = onChange;
		bus.on(BTW_STATE_EVENT, (data) => this.#applyState(data));
	}

	get active(): boolean {
		return this.#state.open;
	}

	// Inline nodes that replace the composer while a side question is open. Empty when none is.
	nodes(): TspNode[] {
		if (!this.#state.open) return [];
		const { active, entries } = this.#state;
		const children: TspNode[] = [];
		const recent = entries.slice(-HISTORY);
		children.push(...recent.flatMap((entry, index) => exchange(`btw-turn-${index}`, entry)));
		if (active) children.push(...exchange("btw-active", { question: active.question, answer: active.answer }, true));
		if (!recent.length && !active) {
			children.push({ id: "btw-empty", k: "text", p: { text: "No side questions yet.", tone: "muted", wrap: "soft" } });
		}
		children.push({
			id: BTW_INPUT_ID,
			k: "text",
			p: {
				role: "pi.btw.input",
				text: this.#draft || EMPTY_HINT,
				...(this.#draft ? {} : { tone: "muted" }),
				wrap: "soft",
			},
		});
		children.push({
			id: "btw-hint",
			k: "row",
			p: { role: "pi.btw.hint" },
			c: [
				{ id: "btw-hint-request", k: "kbd", p: { keys: ["enter"], actions: { click: BTW_REQUEST_ID } } },
				{ id: "btw-hint-request-label", k: "text", p: { text: "ask", tone: "muted" } },
				{ id: "btw-hint-close", k: "kbd", p: { keys: ["esc"], actions: { click: BTW_CLOSE_ID } } },
				{ id: "btw-hint-close-label", k: "text", p: { text: active ? "abort" : "close", tone: "muted" } },
			],
		});
		return [{ id: BTW_CARD_ID, k: "card", p: { head: "BTW · side question", role: "pi.btw" }, c: children }];
	}

	// Typed text owns the card, so the composer draft underneath is never touched.
	input(text: string): void {
		if (!this.#state.open || !text) return;
		this.#draft += text.replace(/[\r\n]/g, " ");
		this.#onChange();
	}

	backspace(): void {
		if (!this.#state.open || !this.#draft) return;
		this.#draft = [...this.#draft].slice(0, -1).join("");
		this.#onChange();
	}

	// Enter behaviour mirrors BtwView: send the draft, or ignore Enter while an answer streams.
	request(): void {
		if (!this.#state.open) return;
		const question = this.#draft.trim();
		if (this.#state.active || !question) return;
		this.#draft = "";
		this.#bus.emit(BTW_SUBMIT_EVENT, { question });
		this.#onChange();
	}

	// Escape behaviour mirrors BtwView: abort a running question, otherwise close the box.
	escape(): void {
		if (!this.#state.open) return;
		this.#bus.emit(this.#state.active ? BTW_ABORT_EVENT : BTW_CLOSE_EVENT, {});
		this.#onChange();
	}

	// Routes a Tern pointer action on a `btw-*` node. Returns true when the id belongs to this card.
	handleAction(id: string): boolean {
		const known = id === BTW_REQUEST_ID || id === BTW_CLOSE_ID || id === BTW_INPUT_ID;
		if (!known) return false;
		if (id === BTW_REQUEST_ID) this.request();
		else if (id === BTW_CLOSE_ID) this.escape();
		return true;
	}

	// The bus carries the whole snapshot, so a missed or repeated event can never desync the card.
	#applyState(data: unknown): void {
		const next = data as Partial<BtwState> | undefined;
		if (!next || typeof next.open !== "boolean") return;
		this.#state = {
			open: next.open,
			entries: Array.isArray(next.entries) ? (next.entries as BtwEntry[]) : [],
			...(next.active ? { active: next.active } : {}),
		};
		if (!next.open) this.#draft = "";
		this.#onChange();
	}
}

function exchange(id: string, entry: BtwEntry, streaming = false): TspNode[] {
	const answer = entry.error ? entry.error : entry.answer;
	return [
		{ id: `${id}-question`, k: "text", p: { role: "pi.btw.question", text: `You: ${entry.question}`, tone: "muted", wrap: "soft" } },
		{
			id: `${id}-answer`,
			k: "text",
			p: {
				role: "pi.btw.answer",
				text: answer || (streaming ? "…" : "(no answer)"),
				...(entry.error ? { tone: "error" } : {}),
				wrap: "soft",
			},
		},
	];
}
