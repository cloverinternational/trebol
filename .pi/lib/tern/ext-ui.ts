// Native Tern implementation of Pi's ExtensionUIContext. Binding it makes every extension command's
// prompts (select, confirm, input, editor, notify, widgets) work in Tern without per-command code.
// Every prompt resolves only from an explicit user action, its abort signal or its timeout; Esc,
// timeout and close resolve like Pi's own TUI cancel (select/input/editor -> undefined, confirm -> false).
// TUI component factories (custom panels, headers, footers, editor components) have no Tern renderer:
// `custom` runs the factory only so flows with a remote Tern counterpart (ask-user) can start; anything
// else is disposed and resolves undefined with a notice.
import type { TspNode } from "./tsp.ts";
import { sanitizeUiLines } from "./ui-context.ts";
import { DraftEditor, type HostEdit } from "./draft-edit.ts";

export const UI_PROMPT_LIST_ID = "ui-prompt-list";
export const UI_PROMPT_INPUT_ID = "ui-prompt-input";
const ITEM_PREFIX = "ui-opt-";
const WIDGET_WIDTH = 200;

type NotifyType = "info" | "warning" | "error";

interface DialogOptions {
	signal?: AbortSignal;
	timeout?: number;
}

interface Prompt {
	kind: "select" | "confirm" | "input" | "editor";
	title: string;
	message?: string;
	options: string[];
	index: number;
	// Text, caret, selection and undo of an input/editor prompt; Tern edits it natively like the composer.
	field: DraftEditor;
	placeholder?: string;
	resolve(value: string | undefined): void;
}

export interface ExtUiHost {
	// Re-render the surface.
	render(): void;
	// Show a line in the transcript.
	notice(text: string): void;
	// The composer draft, for get/setEditorText.
	getDraft(): string;
	setDraft(text: string): void;
	// True once a native Tern flow (the ask dialog) owns the screen, so a custom factory has a counterpart.
	remoteFlowActive(): boolean;
	columns(): number;
}

export class TernExtensionUI {
	readonly #host: ExtUiHost;
	readonly #theme: unknown;
	#queue: Prompt[] = [];
	#widgets = new Map<string, { lines: string[]; placement: "aboveEditor" | "belowEditor" }>();
	#toolsExpanded = false;

	constructor(host: ExtUiHost, theme: unknown) {
		this.#host = host;
		this.#theme = theme;
	}

	get active(): boolean {
		return this.#queue.length > 0;
	}

	// The object bound as Pi's uiContext.
	context(): Record<string, unknown> {
		const self = this;
		return {
			select: (title: string, options: string[], opts?: DialogOptions) => this.#ask({ kind: "select", title, options: [...options] }, opts),
			confirm: async (title: string, message: string, opts?: DialogOptions) =>
				(await this.#ask({ kind: "confirm", title, message, options: ["Yes", "No"] }, opts)) === "Yes",
			input: (title: string, placeholder?: string, opts?: DialogOptions) => this.#ask({ kind: "input", title, placeholder, options: [] }, opts),
			editor: (title: string, prefill?: string) => this.#ask({ kind: "editor", title, options: [], text: prefill ?? "" }),
			notify: (message: string, type?: NotifyType) => this.#host.notice(type === "error" ? `Error: ${message}` : type === "warning" ? `Warning: ${message}` : message),
			onTerminalInput: () => () => {},
			setStatus: () => {},
			setWorkingMessage: () => {},
			setWorkingVisible: () => {},
			setWorkingIndicator: () => {},
			setHiddenThinkingLabel: () => {},
			setWidget: (key: string, content: unknown, options?: { placement?: "aboveEditor" | "belowEditor" }) => this.#setWidget(key, content, options?.placement),
			setFooter: () => {},
			setHeader: () => {},
			setTitle: () => {},
			custom: (factory: CustomFactory) => this.#custom(factory),
			pasteToEditor: (text: string) => this.#host.setDraft(this.#host.getDraft() + text),
			setEditorText: (text: string) => this.#host.setDraft(text),
			getEditorText: () => this.#host.getDraft(),
			addAutocompleteProvider: () => {},
			setEditorComponent: () => {},
			getEditorComponent: () => undefined,
			get theme() {
				return self.#theme;
			},
			getAllThemes: () => [],
			getTheme: () => undefined,
			setTheme: () => ({ success: false, error: "Theme switching is not available in the Tern UI" }),
			getToolsExpanded: () => this.#toolsExpanded,
			setToolsExpanded: (expanded: boolean) => {
				this.#toolsExpanded = expanded;
			},
		};
	}

	#ask(init: Omit<Prompt, "index" | "field" | "resolve"> & { text?: string }, opts?: DialogOptions): Promise<string | undefined> {
		return new Promise((resolve) => {
			if (opts?.signal?.aborted) return resolve(undefined);
			let timer: ReturnType<typeof setTimeout> | undefined;
			const { text, ...rest } = init;
			const prompt: Prompt = {
				...rest,
				index: 0,
				field: new DraftEditor({ text: text ?? "", multiline: init.kind === "editor" }),
				resolve: (value) => {
					if (!this.#queue.includes(prompt)) return;
					clearTimeout(timer);
					opts?.signal?.removeEventListener("abort", onAbort);
					this.#queue = this.#queue.filter((p) => p !== prompt);
					resolve(value);
					this.#host.render();
				},
			};
			const onAbort = (): void => prompt.resolve(undefined);
			opts?.signal?.addEventListener("abort", onAbort, { once: true });
			if (opts?.timeout && opts.timeout > 0) timer = setTimeout(onAbort, opts.timeout);
			this.#queue.push(prompt);
			this.#host.render();
		});
	}

	async #custom(factory: CustomFactory): Promise<unknown> {
		let resolveDone!: (value: unknown) => void;
		let settled = false;
		const done = new Promise<unknown>((r) => (resolveDone = (value) => { settled = true; r(value); }));
		const tui = {
			requestRender: () => this.#host.render(),
			terminal: { columns: this.#host.columns(), rows: 40 },
		};
		let component: { dispose?(): void } | undefined;
		try {
			component = (await factory(tui, this.#theme, undefined, (result: unknown) => resolveDone(result))) as { dispose?(): void } | undefined;
		} catch (error) {
			this.#host.notice(`panel failed: ${error instanceof Error ? error.message : String(error)}`);
			return undefined;
		}
		// Remote flows announce themselves in a microtask; let them land before deciding. A flow can also be
		// answered before this check runs, so a settled `done` wins over the (now inactive) remote flow.
		await new Promise((r) => setTimeout(r, 0));
		if (!settled && !this.#host.remoteFlowActive()) {
			try {
				component?.dispose?.();
			} catch {
				// A failing dispose must not strand the command.
			}
			this.#host.notice("This panel needs Pi's terminal UI and is not available in Tern (run `pi -nt`).");
			return undefined;
		}
		const result = await done;
		try {
			component?.dispose?.();
		} catch {
			// ignore
		}
		return result;
	}

	#setWidget(key: string, content: unknown, placement: "aboveEditor" | "belowEditor" = "aboveEditor"): void {
		if (content === undefined) this.#widgets.delete(key);
		else if (Array.isArray(content)) {
			const lines = sanitizeUiLines(content.filter((l): l is string => typeof l === "string"), WIDGET_WIDTH);
			this.#widgets.set(key, { lines, placement });
		} else return; // Component factories need a TUI owner.
		this.#host.render();
	}

	// Plain-text widgets, placed around the composer like Pi's TUI.
	widgetNodes(placement: "aboveEditor" | "belowEditor"): TspNode[] {
		const out: TspNode[] = [];
		for (const [key, w] of this.#widgets) {
			if (w.placement !== placement || w.lines.length === 0) continue;
			out.push({ id: `ui-widget-${key}`, k: "text", p: { role: "pi.widget", text: w.lines.join("\n"), wrap: "none", tone: "muted" } });
		}
		return out;
	}

	// The input field owns the caret while a text prompt is open.
	get focusId(): string | undefined {
		const p = this.#queue[0];
		return p && (p.kind === "input" || p.kind === "editor") ? UI_PROMPT_INPUT_ID : undefined;
	}

	nodes(): TspNode[] {
		const p = this.#queue[0];
		if (!p) return [];
		const queued = this.#queue.length > 1 ? ` (+${this.#queue.length - 1} queued)` : "";
		const [head, ...rest] = p.title.split("\n");
		const body = [...rest, ...(p.message ? [p.message] : [])].join("\n");
		const children: TspNode[] = [];
		if (body) children.push({ id: "ui-prompt-msg", k: "text", p: { text: body, wrap: "soft" } });
		if (p.kind === "select" || p.kind === "confirm") {
			children.push({
				id: UI_PROMPT_LIST_ID,
				k: "list",
				p: { max: { lines: 10 }, empty: "no options", ...(p.options.length ? { selected: `${ITEM_PREFIX}${p.index}` } : {}) },
				c: p.options.map((label, i) => ({ id: `${ITEM_PREFIX}${i}`, k: "item", p: { label } })),
			});
		} else {
			children.push({
				id: UI_PROMPT_INPUT_ID,
				k: p.kind === "editor" ? "editor" : "input",
				p: { text: p.field.text, cursor: p.field.cursor, anchor: p.field.anchor, placeholder: p.placeholder ?? "", ...(p.kind === "editor" ? { maxLines: 12 } : {}) },
			});
		}
		const hint = p.kind === "select" || p.kind === "confirm" ? "↑/↓ choose · enter select · esc cancel" : p.kind === "editor" ? "enter submit · shift+enter newline · esc cancel" : "enter submit · esc cancel";
		children.push({ id: "ui-prompt-hint", k: "text", p: { text: hint, tone: "muted" } });
		return [{ id: "ui-prompt", k: "overlay", p: { head: `${head}${queued}`, size: "md", modal: true, role: "pi.prompt" }, c: children }];
	}

	move(delta: number): void {
		const p = this.#queue[0];
		if (!p || p.options.length === 0) return;
		p.index = (p.index + delta + p.options.length) % p.options.length;
		this.#host.render();
	}

	type(text: string): void {
		const p = this.#queue[0];
		if (!p) return;
		if (p.kind === "input" || p.kind === "editor") {
			p.field.insert(p.kind === "input" ? text.replace(/\r\n?|\n/g, " ") : text);
			this.#host.render();
		} else if (/^[1-9]$/.test(text) && Number(text) <= p.options.length) {
			p.index = Number(text) - 1;
			this.#host.render();
		}
	}

	newline(): void {
		const p = this.#queue[0];
		if (p?.kind !== "editor") return;
		p.field.insert("\n");
		this.#host.render();
	}

	backspace(): void {
		const p = this.#queue[0];
		if (!p || (p.kind !== "input" && p.kind !== "editor")) return;
		p.field.backspace();
		this.#host.render();
	}

	// The open prompt's text field, when it has one: caret, selection, delete and undo keys edit it.
	editText(op: (field: DraftEditor) => void): boolean {
		const p = this.#queue[0];
		if (!p || (p.kind !== "input" && p.kind !== "editor")) return false;
		op(p.field);
		this.#host.render();
		return true;
	}

	// Tern's native `edit` on the prompt field; a stale or malformed one changes nothing.
	applyNativeEdit(edit: HostEdit): void {
		const p = this.#queue[0];
		if (!p || (p.kind !== "input" && p.kind !== "editor")) return;
		if (p.field.applyHostEdit(edit)) this.#host.render();
	}

	submit(): void {
		const p = this.#queue[0];
		if (!p) return;
		p.resolve(p.kind === "select" || p.kind === "confirm" ? p.options[p.index] : p.field.expandedText);
	}

	cancel(): void {
		this.#queue[0]?.resolve(undefined);
	}

	// List clicks: a click selects, a double-click (activate) selects and submits.
	pick(itemId: unknown, activate: boolean): void {
		const p = this.#queue[0];
		const m = typeof itemId === "string" ? new RegExp(`^${ITEM_PREFIX}(\\d+)$`).exec(itemId) : null;
		if (!p || !m || Number(m[1]) >= p.options.length) return;
		p.index = Number(m[1]);
		if (activate) this.submit();
		else this.#host.render();
	}

	// Closing the pane cancels every open prompt so no command is stranded.
	dispose(): void {
		for (const p of [...this.#queue]) p.resolve(undefined);
	}
}

type CustomFactory = (tui: unknown, theme: unknown, keybindings: unknown, done: (result: unknown) => void) => unknown;
