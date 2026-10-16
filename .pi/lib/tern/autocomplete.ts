// Slash-command autocomplete for the Tern composer: Pi's own CombinedAutocompleteProvider (pi-tui) decides the
// suggestions and applies completions; the editor key semantics follow pi-tui's Editor; the nodes are OMP's
// native autocomplete (overlay `omp.autocomplete` anchored to the editor caret > col `omp.select` > list).
import { CombinedAutocompleteProvider, type AutocompleteItem } from "@earendil-works/pi-tui";
import type { SlashCommandItem } from "./commands.ts";
import { mentionToken, suggestMentions } from "./mentions.ts";
import type { TspNode } from "./tsp.ts";

export const AUTOCOMPLETE_ID = "complete";
const MAX_LINES = 10;
// Tern switches to virtual rows above 200 children; those rows render with a larger pitch than
// OMP's regular autocomplete rows. Keep all Pi suggestions in `Open.items` and page only the
// mounted children. The selected item remains in the visible ten-row viewport on page changes.
const MOUNTED_ITEMS = 100;
// pi-tui Editor: an alphanumeric (or . - _) key typed in a slash context opens the list.
const TRIGGER_CHAR = /^[a-zA-Z0-9.\-_]$/;

export type Edit = { kind: "type"; text: string } | { kind: "backspace" } | { kind: "set" };

interface Open {
	items: AutocompleteItem[];
	prefix: string;
	index: number;
	force: boolean;
	gen: number;
}

export interface AutocompleteHost {
	commands(): SlashCommandItem[];
	cwd(): string;
	draft(): string;
	setDraft(text: string): void;
	render(): void;
}

export class SlashAutocomplete {
	readonly #host: AutocompleteHost;
	#open: Open | null = null;
	#icons = new Map<string, Pick<SlashCommandItem, "icon" | "disabled">>();
	#values = new Map<string, string>();
	#request = 0;
	#gen = 0;

	constructor(host: AutocompleteHost) {
		this.#host = host;
	}

	get active(): boolean {
		return this.#open !== null;
	}

	get selectedId(): string | undefined {
		const open = this.#open;
		const item = open?.items[open.index];
		return open && item ? this.#itemId(open, item) : undefined;
	}

	// OMP gives the editor a dim suffix for the selected row, clearing it when the list closes.
	get ghost(): string | undefined {
		const open = this.#open;
		if (!open) return undefined;
		const item = open.items[open.index];
		if (!item) return undefined;
		const typed = open.prefix.startsWith("/") ? open.prefix.slice(1) : open.prefix;
		// Argument labels may omit a provider while their inserted values include it. A ghost must never
		// suggest text different from what Tab actually inserts (e.g. /model gpt → openai-codex/gpt…).
		const candidate = open.prefix.startsWith("/") ? item.label : item.value;
		return candidate.toLowerCase().startsWith(typed.toLowerCase()) ? candidate.slice(typed.length) : undefined;
	}

	// The provider is rebuilt per request so reloaded extensions, templates and skills show up immediately.
	#provider(): CombinedAutocompleteProvider {
		const commands = this.#host.commands();
		this.#icons = new Map(commands.map((c) => [c.name, { icon: c.icon, ...(c.disabled ? { disabled: true } : {}) }]));
		this.#values = new Map(commands.filter((c) => c.value).map((c) => [c.name, c.value!]));
		return new CombinedAutocompleteProvider(commands.map((c) => ({
			name: c.name,
			...(c.description ? { description: c.description } : {}),
			...(c.complete ? { getArgumentCompletions: c.complete } : {}),
		})), this.#host.cwd(), null);
	}

	// Called after every draft edit, with what caused it. Mirrors pi-tui Editor insertCharacter/handleBackspace:
	// an open list always refreshes; a closed one opens on `/` at the start, on a word character in a slash
	// context, or on backspace in a slash context. Programmatic sets close it (Editor.setText).
	edited(edit: Edit): Promise<void> {
		if (edit.kind === "set") return Promise.resolve(this.close());
		if (this.#open) return this.#refresh(this.#open.force, false);
		const text = this.#host.draft();
		const slash = text.trimStart().startsWith("/");
		// A typed `@` token (or any edit within one) opens the workspace file list.
		if (mentionToken(text) !== null && !slash) {
			return this.#refresh(false, false);
		}
		if (edit.kind === "backspace" ? slash : edit.text === "/" ? text.trim() === "/" : slash && [...edit.text].every((c) => TRIGGER_CHAR.test(c))) {
			return this.#refresh(false, false);
		}
		return Promise.resolve();
	}

	// Tab: applies the selection when open; otherwise opens the slash list (command name, no space yet) or
	// forces Pi's path completion, applying a lone match directly (pi-tui handleTabCompletion).
	tab(): Promise<void> {
		if (this.#open) {
			// OMP keeps the preview open when the completed value has further argument/subcommand
			// completions. Pi's provider is authoritative: absent a further level, it closes.
			const slash = this.#host.draft().trimStart().startsWith("/");
			const completed = this.#open.items[this.#open.index]?.value;
			this.#apply();
			return slash ? this.#refresh(false, false, completed) : Promise.resolve();
		}
		const before = this.#host.draft();
		// A slash command with arguments must use Pi's argument provider, not force filesystem suggestions.
		const force = !before.trimStart().startsWith("/");
		return this.#refresh(force, true);
	}

	// Enter while open: apply; a command-name completion then submits (returns true), an argument stays.
	enter(): boolean {
		const open = this.#open;
		if (!open) return true;
		this.#apply();
		return open.prefix.startsWith("/");
	}

	move(delta: number): void {
		const open = this.#open;
		if (!open || !open.items.length) return;
		open.index = (open.index + delta + open.items.length) % open.items.length;
		this.#host.render();
	}

	select(itemId: string, activate: boolean): void {
		const open = this.#open;
		if (!open) return;
		const index = open.items.findIndex((item) => this.#itemId(open, item) === itemId);
		if (index < 0 || this.#iconOf(open, open.items[index]).disabled) return;
		open.index = index;
		if (activate) this.#apply();
		else this.#host.render();
	}

	close(): void {
		this.#request += 1;
		if (!this.#open) return;
		this.#open = null;
		this.#host.render();
	}

	async #refresh(force: boolean, explicitTab: boolean, completed?: string): Promise<void> {
		const request = ++this.#request;
		const text = this.#host.draft();
		const mention = mentionToken(text);
		if (mention !== null && !text.trimStart().startsWith("/")) {
			const items = suggestMentions(mention, this.#host.cwd());
			if (!items.length) {
				this.close();
				return;
			}
			this.#open = { items, prefix: mention, index: 0, force: false, gen: ++this.#gen };
			this.#host.render();
			return;
		}
		const provider = this.#provider();
		const suggestions = await provider.getSuggestions([text], 0, text.length, { signal: new AbortController().signal, force });
		if (request !== this.#request || text !== this.#host.draft()) return;
		if (!suggestions || !suggestions.items.length) {
			this.close();
			return;
		}
		// Applying a terminal argument such as a thinking level can return just that same argument
		// from Pi's fuzzy provider. Do not re-open a one-row list for a completion already applied.
		if (completed !== undefined && suggestions.items.length === 1 && suggestions.items[0].value === completed) {
			this.close();
			return;
		}
		if (force && explicitTab && suggestions.items.length === 1) {
			this.#open = null;
			this.#host.setDraft(provider.applyCompletion([text], 0, text.length, suggestions.items[0], suggestions.prefix).lines[0]);
			return;
		}
		const best = bestMatchIndex(suggestions.items, suggestions.prefix);
		this.#open = { items: suggestions.items, prefix: suggestions.prefix, index: Math.max(0, best), force, gen: ++this.#gen };
		this.#host.render();
	}

	#apply(): void {
		const open = this.#open;
		if (!open) return;
		const item = open.items[open.index];
		this.#open = null;
		this.#request += 1;
		if (!item) return this.#host.render();
		const text = this.#host.draft();
		// A mention replaces the typed token and leaves a space, so Enter then sends the prompt.
		if (open.prefix.startsWith("@")) return this.#host.setDraft(`${text.slice(0, text.length - open.prefix.length)}${item.value} `);
		this.#host.setDraft(this.#provider().applyCompletion([text], 0, text.length, item, open.prefix).lines[0]);
	}

	// One path separator only: Tern treats `<list>/<item>` as the item address, so a value's own `/`
	// (provider/model, paths) is escaped.
	#itemId(open: Open, item: AutocompleteItem): string {
		return `${AUTOCOMPLETE_ID}.${open.gen}.list/${encodeURIComponent(item.value)}`;
	}

	#iconOf(open: Open, item: AutocompleteItem): { icon?: string; disabled?: boolean } {
		if (open.prefix.startsWith("/")) return this.#icons.get(item.value) ?? {};
		// Slash-command argument completions (model ids, levels) are not paths; only path completions get icons.
		if (!open.force && this.#host.draft().trimStart().startsWith("/")) return {};
		if (open.prefix.startsWith("@") || open.force) return { icon: item.label.endsWith("/") ? "folder" : "file" };
		return {};
	}

	// OMP marks the label prefix that matches the typed text after its sigil and last `/`.
	nodes(): TspNode[] {
		const open = this.#open;
		if (!open) return [];
		const mark = open.prefix.replace(/^[/@]/, "").split("/").at(-1) ?? "";
		const listId = `${AUTOCOMPLETE_ID}.${open.gen}.list`;
		const selected = open.items[open.index];
		const start = open.items.length <= MOUNTED_ITEMS ? 0 : Math.max(0, open.index - (MAX_LINES - 1));
		const mounted = open.items.slice(start, start + MOUNTED_ITEMS);
		return [{
			id: AUTOCOMPLETE_ID,
			k: "overlay",
			p: { anchor: { caret: "composer" }, role: "omp.autocomplete" },
			c: [{
				id: `${AUTOCOMPLETE_ID}.${open.gen}`,
				k: "col",
				p: { role: "omp.select" },
				c: [{
					id: listId,
					k: "list",
					p: { ...(selected ? { selected: this.#itemId(open, selected) } : {}), empty: "No items", max: { lines: MAX_LINES } },
					c: mounted.map((item) => {
						const { icon, disabled } = this.#iconOf(open, item);
						const label = item.label;
						const n = mark && label.toLowerCase().startsWith(mark.toLowerCase()) ? mark.length : 0;
						return {
							id: this.#itemId(open, item),
							k: "item",
							p: {
								...(icon ? { icon } : {}),
								label: n ? [{ t: label.slice(0, n), s: "mark" }, ...(n < label.length ? [{ t: label.slice(n) }] : [])] : [{ t: label }],
								...(item.description ? { detail: [{ t: item.description, s: "muted" }] } : {}),
								...(open.prefix.startsWith("/") && this.#values.has(item.value) ? { value: [{ t: this.#values.get(item.value)!, s: "muted" }] } : {}),
								...(disabled ? { disabled: true } : {}),
							},
						};
					}),
				}],
			}],
		}];
	}
}

// pi-tui Editor.getBestAutocompleteMatchIndex: an exact value wins, else the first value with the prefix.
function bestMatchIndex(items: AutocompleteItem[], prefix: string): number {
	if (!prefix) return -1;
	let first = -1;
	for (let i = 0; i < items.length; i++) {
		if (items[i].value === prefix) return i;
		if (first === -1 && items[i].value.startsWith(prefix)) first = i;
	}
	return first;
}
