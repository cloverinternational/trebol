// Caret, selection, word motion and undo for the Tern composer draft. Pure text state; the bridge reads
// `text`/`cursor`/`selection` and renders them. Indices are UTF-16 code units; steps never split a surrogate pair.
export interface DraftSnapshot {
	text: string;
	cursor: number;
	anchor: number | null;
}

const WORD_CHAR = /[\p{L}\p{N}_]/u;
const UNDO_LIMIT = 200;
// Same thresholds and marker shapes as pi-tui's Editor: a large paste is shown as a marker and expanded on submit.
const LARGE_PASTE_LINES = 10;
const LARGE_PASTE_CHARS = 1000;
const PASTE_MARKER = /\[paste #(\d+)(?: \+\d+ lines| \d+ chars)?\]/g;

export function isLargePaste(text: string): boolean {
	return text.length > LARGE_PASTE_CHARS || text.split("\n").length > LARGE_PASTE_LINES;
}

function isLowSurrogate(code: number): boolean {
	return code >= 0xdc00 && code <= 0xdfff;
}

function isHighSurrogate(code: number): boolean {
	return code >= 0xd800 && code <= 0xdbff;
}

function prevBoundary(text: string, index: number): number {
	if (index <= 0) return 0;
	const pair = index >= 2 && isLowSurrogate(text.charCodeAt(index - 1)) && isHighSurrogate(text.charCodeAt(index - 2));
	return index - (pair ? 2 : 1);
}

function nextBoundary(text: string, index: number): number {
	if (index >= text.length) return text.length;
	const pair = isHighSurrogate(text.charCodeAt(index)) && index + 1 < text.length && isLowSurrogate(text.charCodeAt(index + 1));
	return index + (pair ? 2 : 1);
}

// Start of the word before `index`: skip separators, then the word characters (readline style).
export function wordStartBefore(text: string, index: number): number {
	let i = index;
	while (i > 0) {
		const p = prevBoundary(text, i);
		if (WORD_CHAR.test(text.slice(p, i))) break;
		i = p;
	}
	while (i > 0) {
		const p = prevBoundary(text, i);
		if (!WORD_CHAR.test(text.slice(p, i))) break;
		i = p;
	}
	return i;
}

// End of the word after `index`: mirror of wordStartBefore.
export function wordEndAfter(text: string, index: number): number {
	let i = index;
	while (i < text.length) {
		const n = nextBoundary(text, i);
		if (WORD_CHAR.test(text.slice(i, n))) break;
		i = n;
	}
	while (i < text.length) {
		const n = nextBoundary(text, i);
		if (!WORD_CHAR.test(text.slice(i, n))) break;
		i = n;
	}
	return i;
}

export class DraftEditor {
	#text = "";
	#cursor = 0;
	#anchor: number | null = null;
	#undo: DraftSnapshot[] = [];
	// Consecutive typed characters share one undo step, so Ctrl+Z removes a typed run, not one character.
	#typing = false;
	// Large pastes kept out of the visible text, keyed by the id in their marker. Never cleared: undo can restore a marker.
	#pastes = new Map<number, string>();
	// The exact marker text each paste id was inserted with. Only this text is a marker, so typed look-alikes stay literal.
	#markers = new Map<number, string>();
	#pasteCounter = 0;

	get text(): string {
		return this.#text;
	}

	// The text with every paste marker replaced by its pasted content; what gets sent.
	get expandedText(): string {
		return this.#text.replace(PASTE_MARKER, (marker, id: string) => this.#markers.get(Number(id)) === marker ? this.#pastes.get(Number(id)) ?? marker : marker);
	}

	get cursor(): number {
		return this.#cursor;
	}

	// The selected range, or undefined when nothing is selected.
	get selection(): { start: number; end: number } | undefined {
		if (this.#anchor === null || this.#anchor === this.#cursor) return undefined;
		return { start: Math.min(this.#anchor, this.#cursor), end: Math.max(this.#anchor, this.#cursor) };
	}

	// Programmatic replacement (completion, submit clearing, restore). Undoable; caret goes to the end.
	setText(text: string): void {
		if (text === this.#text) return;
		this.#record();
		this.#text = text;
		this.#cursor = text.length;
		this.#anchor = null;
	}

	insert(input: string): void {
		if (!input) return;
		if (!this.#typing) this.#record();
		this.#typing = true;
		this.#splice(input);
	}

	// A large paste enters as one marker, so the visible draft stays small however much text was pasted.
	insertPaste(text: string): void {
		const lines = text.split("\n").length;
		const id = ++this.#pasteCounter;
		this.#pastes.set(id, text);
		const marker = lines > LARGE_PASTE_LINES ? `[paste #${id} +${lines} lines]` : `[paste #${id} ${text.length} chars]`;
		this.#markers.set(id, marker);
		this.#record();
		this.#typing = false;
		this.#splice(marker);
	}

	#splice(input: string): void {
		this.#deleteSelection();
		this.#text = this.#text.slice(0, this.#cursor) + input + this.#text.slice(this.#cursor);
		this.#cursor += input.length;
	}

	backspace(): void {
		if (this.selection) return this.#record(), this.#deleteSelection();
		if (this.#cursor === 0) return;
		this.#record();
		const before = this.#text.slice(0, this.#cursor);
		const pasted = [...this.#markers.values()].find(m => before.endsWith(m));
		const start = pasted !== undefined ? this.#cursor - pasted.length : prevBoundary(this.#text, this.#cursor);
		this.#text = this.#text.slice(0, start) + this.#text.slice(this.#cursor);
		this.#cursor = start;
	}

	// Option/Alt+Backspace: delete the selection, else the word before the caret.
	deleteWordBackward(): void {
		if (this.selection) return this.#record(), this.#deleteSelection();
		if (this.#cursor === 0) return;
		this.#record();
		const start = wordStartBefore(this.#text, this.#cursor);
		this.#text = this.#text.slice(0, start) + this.#text.slice(this.#cursor);
		this.#cursor = start;
	}

	// Move the caret. Without `extend` a selection collapses to its near edge; with `extend` the anchor stays
	// and the caret grows the selection. `word` jumps by word.
	move(direction: -1 | 1, { word = false, extend = false }: { word?: boolean; extend?: boolean } = {}): void {
		this.#typing = false;
		const sel = this.selection;
		if (!extend && sel) {
			this.#cursor = direction < 0 ? sel.start : sel.end;
			this.#anchor = null;
			return;
		}
		if (extend && this.#anchor === null) this.#anchor = this.#cursor;
		this.#cursor = direction < 0
			? (word ? wordStartBefore(this.#text, this.#cursor) : prevBoundary(this.#text, this.#cursor))
			: (word ? wordEndAfter(this.#text, this.#cursor) : nextBoundary(this.#text, this.#cursor));
		if (!extend) this.#anchor = null;
	}

	selectAll(): void {
		this.#typing = false;
		this.#anchor = 0;
		this.#cursor = this.#text.length;
	}

	// Ctrl/Cmd+Z: restore the last snapshot. Nothing to undo leaves the draft alone.
	undo(): void {
		this.#typing = false;
		const previous = this.#undo.pop();
		if (!previous) return;
		this.#text = previous.text;
		this.#cursor = previous.cursor;
		this.#anchor = null;
	}

	#deleteSelection(): void {
		const sel = this.selection;
		if (!sel) return;
		this.#text = this.#text.slice(0, sel.start) + this.#text.slice(sel.end);
		this.#cursor = sel.start;
		this.#anchor = null;
	}

	#record(): void {
		this.#typing = false;
		this.#undo.push({ text: this.#text, cursor: this.#cursor, anchor: this.#anchor });
		if (this.#undo.length > UNDO_LIMIT) this.#undo.shift();
	}
}
