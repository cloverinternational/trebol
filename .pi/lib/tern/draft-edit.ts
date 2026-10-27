// Caret, selection, word motion and undo for the Tern composer draft. Pure text state; the bridge reads
// `text`/`cursor`/`anchor` and renders them. Indices are UTF-16 code units; steps never split a surrogate pair.
export interface DraftSnapshot {
	text: string;
	cursor: number;
	anchor: number | null;
}

// Tern's native-editing `edit` event: replace UTF-16 [from, to) with `text`, caret at `cursor`; `len` is the
// text length Tern computed it against (TSP protocol/input.md, Events).
export interface HostEdit {
	from: unknown;
	to: unknown;
	text?: unknown;
	cursor: unknown;
	len: unknown;
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

// True when `index` falls between the halves of a surrogate pair.
function splitsPair(text: string, index: number): boolean {
	return index > 0 && index < text.length && isHighSurrogate(text.charCodeAt(index - 1)) && isLowSurrogate(text.charCodeAt(index));
}

function offset(value: unknown, max: number): number | null {
	return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(max, Math.trunc(value))) : null;
}

export interface HostEditResult {
	text: string;
	cursor: number;
	/** False for a pure caret move (a click). */
	changed: boolean;
}

// Applies Tern's native `edit` event to `old`, as OMP's host-edit apply does: a stale `len` drops it (keys in
// flight, returns null), offsets are clamped and ordered, a caret never lands inside a surrogate pair and a
// range widens to whole pairs. `widen` may grow the replaced range further (atomic spans); `transform` maps the
// inserted text (flattening, markers). The caret Tern reports, which is in the coordinates of Tern's own result,
// is mapped onto the transformed result.
export function spliceHostEdit(
	old: string,
	edit: HostEdit,
	opts: { widen?: (from: number, to: number) => [number, number]; transform?: (text: string) => string } = {},
): HostEditResult | null {
	if (edit.len !== old.length) return null;
	let from = offset(edit.from, old.length);
	let to = offset(edit.to, old.length);
	if (from === null || to === null) return null;
	if (to < from) [from, to] = [to, from];
	// A collapsed caret snaps as one point; a range widens to whole pairs.
	if (from === to) { if (splitsPair(old, from)) to = --from; }
	else {
		if (splitsPair(old, from)) from--;
		if (splitsPair(old, to)) to++;
	}
	const raw = typeof edit.text === "string" ? edit.text.replace(/\r\n?/g, "\n") : "";
	const hostCursor = offset(edit.cursor, old.length - (to - from) + raw.length) ?? from + raw.length;
	const [start, end] = from < to && opts.widen ? opts.widen(from, to) : [from, to];
	const changed = start < end || raw.length > 0;
	const text = raw && opts.transform ? opts.transform(raw) : raw;
	const next = old.slice(0, start) + text + old.slice(end);
	let cursor: number;
	if (hostCursor <= start) cursor = hostCursor;
	else if (hostCursor <= from) cursor = start;
	else if (hostCursor < from + raw.length) cursor = start + Math.min(hostCursor - from, text.length);
	else cursor = start + text.length + Math.max(0, hostCursor - from - raw.length - (end - to));
	cursor = Math.min(cursor, next.length);
	if (splitsPair(next, cursor)) cursor--;
	return { text: next, cursor, changed };
}

export function prevCodePoint(text: string, index: number): number {
	return prevBoundary(text, index);
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
	// Multi-line fields (an extension `editor` prompt) keep newlines and take pastes as they are.
	readonly #multiline: boolean;

	// `text` is the starting content (a prefill); it is not an undo step.
	constructor({ text = "", multiline = false }: { text?: string; multiline?: boolean } = {}) {
		this.#text = text;
		this.#cursor = text.length;
		this.#multiline = multiline;
	}

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

	// The selection anchor as TSP's `editor` draws it (`anchor`..`cursor`), or null when nothing is selected.
	get anchor(): number | null {
		return this.#anchor === null || this.#anchor === this.#cursor ? null : this.#anchor;
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
		const marker = this.#pasteMarker(text);
		this.#record();
		this.#typing = false;
		this.#splice(marker);
	}

	#pasteMarker(text: string): string {
		const lines = text.split("\n").length;
		const id = ++this.#pasteCounter;
		this.#pastes.set(id, text);
		const marker = lines > LARGE_PASTE_LINES ? `[paste #${id} +${lines} lines]` : `[paste #${id} ${text.length} chars]`;
		this.#markers.set(id, marker);
		return marker;
	}

	// Live paste-marker spans in the text; a marker is atomic, so host edits never cut one in half.
	#markerSpans(): Array<[number, number]> {
		const spans: Array<[number, number]> = [];
		for (const m of this.#text.matchAll(PASTE_MARKER)) {
			if (this.#markers.get(Number(m[1])) === m[0]) spans.push([m.index, m.index + m[0].length]);
		}
		return spans;
	}

	// Applies Tern's native `edit` event (a click placing the caret, a replaced native selection, a spell-check
	// pick). Mirrors OMP's host-edit apply: a stale `len` drops the event (keys in flight), offsets are clamped
	// and ordered, never split a surrogate pair or a paste marker, and a changed text is one undo step. Pasted text
	// follows pasteText's rules: large becomes a marker, small is flattened to one line. Returns whether it applied.
	applyHostEdit(edit: HostEdit): boolean {
		const spans = this.#markerSpans();
		const result = spliceHostEdit(this.#text, edit, {
			widen: (from, to) => {
				let start = from;
				let end = to;
				for (const [a, b] of spans) if (a < end && b > start) [start, end] = [Math.min(start, a), Math.max(end, b)];
				return [start, end];
			},
			transform: (raw) => this.#multiline ? raw : isLargePaste(raw) ? this.#pasteMarker(raw) : raw.replace(/\n/g, " "),
		});
		if (!result) return false;
		let { cursor } = result;
		if (!result.changed) {
			// A caret placed inside a paste marker moves to its end, so typing never edits the marker text.
			const inside = spans.find(([a, b]) => cursor > a && cursor < b);
			if (inside) cursor = inside[1];
			this.#typing = false;
			this.#cursor = cursor;
			this.#anchor = null;
			return true;
		}
		this.#record();
		this.#text = result.text;
		this.#cursor = cursor;
		this.#anchor = null;
		return true;
	}

	#splice(input: string): void {
		this.#deleteSelection();
		// A collapsed anchor (Shift+arrow that selected nothing) must not survive an edit, or the typed text
		// would become the selection and the next key would replace it.
		this.#anchor = null;
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
	// and the caret grows the selection. `word` jumps by word, `line` to the start or end (Home/End; the draft
	// is one line).
	move(direction: -1 | 1, { word = false, extend = false, line = false }: { word?: boolean; extend?: boolean; line?: boolean } = {}): void {
		this.#typing = false;
		const sel = this.selection;
		if (!extend && sel && !line) {
			this.#cursor = direction < 0 ? sel.start : sel.end;
			this.#anchor = null;
			return;
		}
		if (extend && this.#anchor === null) this.#anchor = this.#cursor;
		this.#cursor = line ? (direction < 0 ? 0 : this.#text.length) : direction < 0
			? (word ? wordStartBefore(this.#text, this.#cursor) : prevBoundary(this.#text, this.#cursor))
			: (word ? wordEndAfter(this.#text, this.#cursor) : nextBoundary(this.#text, this.#cursor));
		if (!extend) this.#anchor = null;
	}

	// Delete / Ctrl+Delete (Alt+D): the selection, else the character or word after the caret. A paste marker
	// right after the caret goes whole.
	deleteForward({ word = false }: { word?: boolean } = {}): void {
		if (this.selection) return this.#record(), this.#deleteSelection();
		if (this.#cursor >= this.#text.length) return;
		this.#record();
		const after = this.#text.slice(this.#cursor);
		const pasted = [...this.#markers.values()].find(m => after.startsWith(m));
		const end = pasted !== undefined ? this.#cursor + pasted.length : word ? wordEndAfter(this.#text, this.#cursor) : nextBoundary(this.#text, this.#cursor);
		this.#text = this.#text.slice(0, this.#cursor) + this.#text.slice(end);
	}

	// Ctrl+U / ⌘⌫ (direction -1) and Ctrl+K (1): the selection, else everything before or after the caret.
	deleteToEdge(direction: -1 | 1): void {
		if (this.selection) return this.#record(), this.#deleteSelection();
		if (direction < 0 ? this.#cursor === 0 : this.#cursor === this.#text.length) return;
		this.#record();
		if (direction < 0) {
			this.#text = this.#text.slice(this.#cursor);
			this.#cursor = 0;
		} else this.#text = this.#text.slice(0, this.#cursor);
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
		// Every text change starts here (or in #splice): a leftover collapsed anchor never outlives it.
		if (this.#anchor === this.#cursor) this.#anchor = null;
	}
}
