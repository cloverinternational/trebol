// Hosts a Pi TUI panel (`ctx.ui.custom`) as native Tern nodes when it is built only from the primitives Pi's
// own dialogs use: containers, Text, Spacer, borders, SelectList, Input and the sign-in URL component.
//
// Tern only draws. Every key goes to the component's own `handleInput` (with Pi's real keybindings), so the
// panel's logic runs unchanged: the host `/mcp` manager keeps its menus, live state, back/close, sign-in and
// redirect-URL flow, and nothing about MCP is re-implemented here. A panel with any other kind of child is
// not projectable and keeps the old "needs Pi's terminal UI" notice.
import type { TspNode } from "./tsp.ts";
import { DraftEditor, type HostEdit } from "./draft-edit.ts";
import { stripTerminal } from "./ui-context.ts";

type Tone = "accent" | "error" | "warning" | "success" | "muted" | "pending";

interface SelectItem { value: string; label?: string; description?: string }
interface SelectListLike {
	items: SelectItem[];
	filteredItems?: SelectItem[];
	selectedIndex: number;
	setSelectedIndex(index: number): void;
	getSelectedItem(): SelectItem | null | undefined;
	onSelectionChange?: (item: SelectItem) => void;
}
interface InputLike { getValue(): string; setValue(value: string): void }
export interface PanelComponent { handleInput?(data: string): void; render?(width: number): string[]; dispose?(): void }

type Leaf =
	| { kind: "text"; text: string; tone?: Tone }
	| { kind: "link"; url: string }
	| { kind: "list"; list: SelectListLike }
	| { kind: "input"; input: InputLike };

const KEY = { up: "\x1b[A", down: "\x1b[B", enter: "\r", escape: "\x1b" } as const;
const BORDER = /^[\s─━═-]*$/;
const MAX_DEPTH = 12;

function isList(c: Record<string, unknown>): boolean {
	return Array.isArray(c.items) && typeof c.setSelectedIndex === "function" && typeof c.getSelectedItem === "function";
}

// Walks the component tree into leaves; undefined means it holds something this module cannot draw.
export function panelLeaves(root: unknown, width: number, tones: (text: string) => Tone | undefined): Leaf[] | undefined {
	const out: Leaf[] = [];
	const walk = (node: unknown, depth: number): boolean => {
		if (!node || typeof node !== "object" || depth > MAX_DEPTH) return false;
		const c = node as Record<string, unknown>;
		if (isList(c)) return out.push({ kind: "list", list: c as unknown as SelectListLike }), true;
		if (typeof c.getValue === "function" && typeof c.setValue === "function") return out.push({ kind: "input", input: c as unknown as InputLike }), true;
		if (typeof c.url === "string" && typeof c.copy === "function") return out.push({ kind: "link", url: c.url }), true;
		if (Array.isArray(c.children)) return c.children.every((child) => walk(child, depth + 1));
		// A view that swaps whole screens keeps the current one in `content` (the /mcp manager does).
		if (c.content && typeof c.content === "object" && depth === 0) return walk(c.content, depth + 1);
		if (typeof c.text === "string") {
			const text = stripTerminal(c.text).trim();
			if (text) out.push({ kind: "text", text, tone: tones(c.text) });
			return true;
		}
		if (typeof c.lines === "number") return true; // Spacer
		if (typeof c.render === "function") {
			// Borders are the only other leaf allowed: a render that is nothing but rule characters.
			try {
				return (c.render as (w: number) => string[])(width).every((line) => BORDER.test(stripTerminal(line)));
			} catch {
				return false;
			}
		}
		return false;
	};
	return walk(root, 0) ? out : undefined;
}

// Status words Pi's lists lead their descriptions with (the /mcp server list: "connected · 3 tools").
function statusTone(detail: string): Tone | undefined {
	if (/^failed\b/.test(detail)) return "error";
	if (/^needs\b/.test(detail)) return "warning";
	if (/^connected\b/.test(detail)) return "success";
	if (/^disabled\b/.test(detail)) return "muted";
	if (/^(connecting|starting)\b/.test(detail)) return "pending";
	return undefined;
}

export interface PanelIds { overlay: string; list: string; input: string; itemPrefix: string }

export class TuiPanel {
	readonly #component: PanelComponent;
	readonly #tones: (text: string) => Tone | undefined;
	readonly #ids: PanelIds;
	readonly #width: () => number;
	#input: InputLike | undefined;
	#field = new DraftEditor({ text: "", multiline: false });

	constructor(component: PanelComponent, options: { theme: unknown; ids: PanelIds; width: () => number }) {
		this.#component = component;
		this.#ids = options.ids;
		this.#width = options.width;
		this.#tones = toneReader(options.theme);
	}

	// True when the component is drawable natively right now.
	projectable(): boolean {
		return typeof this.#component.handleInput === "function" && this.#leaves() !== undefined;
	}

	#leaves(): Leaf[] | undefined {
		return panelLeaves(this.#component, this.#width(), this.#tones);
	}

	#list(): SelectListLike | undefined {
		for (const leaf of this.#leaves() ?? []) if (leaf.kind === "list") return leaf.list;
		return undefined;
	}

	// The panel's Input, re-bound when the screen changes so the draft starts from the component's value.
	#currentInput(): InputLike | undefined {
		let input: InputLike | undefined;
		for (const leaf of this.#leaves() ?? []) if (leaf.kind === "input") input = leaf.input;
		if (input !== this.#input) {
			this.#input = input;
			this.#field = new DraftEditor({ text: input?.getValue() ?? "", multiline: false });
		}
		return input;
	}

	get hasInput(): boolean {
		return this.#currentInput() !== undefined;
	}

	#send(data: string): void {
		const input = this.#currentInput();
		input?.setValue(this.#field.text);
		this.#component.handleInput?.(data);
	}

	move(delta: number): void {
		this.#send(delta < 0 ? KEY.up : KEY.down);
	}

	submit(): void {
		this.#send(KEY.enter);
	}

	cancel(): void {
		this.#send(KEY.escape);
	}

	pick(index: number, activate: boolean): void {
		const list = this.#list();
		const items = list?.filteredItems ?? list?.items ?? [];
		if (!list || index < 0 || index >= items.length) return;
		list.setSelectedIndex(index);
		list.onSelectionChange?.(items[index]!);
		if (activate) this.submit();
	}

	editField(op: (field: DraftEditor) => void): boolean {
		const input = this.#currentInput();
		if (!input) return false;
		op(this.#field);
		input.setValue(this.#field.text);
		return true;
	}

	applyNativeEdit(edit: HostEdit): boolean {
		return this.editField((field) => field.applyHostEdit(edit));
	}

	dispose(): void {
		try {
			this.#component.dispose?.();
		} catch {
			// A failing dispose must not strand the pane.
		}
	}

	nodes(): TspNode[] {
		const leaves = this.#leaves() ?? [];
		this.#currentInput();
		// The first accent text is the panel's title (Pi frames put it first).
		const titleIndex = leaves.findIndex((leaf) => leaf.kind === "text" && leaf.tone === "accent");
		const head = titleIndex >= 0 ? (leaves[titleIndex] as { text: string }).text : "Panel";
		// A screen that is a list and no text field is a picker sheet, like the model picker.
		const list = leaves.find((leaf): leaf is Extract<Leaf, { kind: "list" }> => leaf.kind === "list");
		if (list && !leaves.some((leaf) => leaf.kind === "input")) return [this.#sheet(head, list.list, leaves.filter((_, i) => i !== titleIndex))];
		const children: TspNode[] = [];
		leaves.forEach((leaf, i) => {
			if (i === titleIndex) return;
			const id = `${this.#ids.overlay}-${i}`;
			if (leaf.kind === "text") {
				children.push({ id, k: "text", p: { text: leaf.text, wrap: "soft", ...(leaf.tone && leaf.tone !== "accent" ? { tone: leaf.tone } : {}) } });
			} else if (leaf.kind === "link") {
				children.push({ id, k: "text", p: { spans: [{ t: leaf.url, href: leaf.url, s: "accent" }], wrap: "soft" } });
			} else if (leaf.kind === "list") {
				const items = leaf.list.filteredItems ?? leaf.list.items;
				children.push({
					id: this.#ids.list,
					k: "list",
					p: { max: { lines: 12 }, ...(items.length ? { selected: `${this.#ids.itemPrefix}${leaf.list.selectedIndex}` } : {}) },
					c: items.map((item, n) => {
						const detail = item.description ?? "";
						const tone = statusTone(detail);
						return { id: `${this.#ids.itemPrefix}${n}`, k: "item", p: { label: item.label ?? item.value, ...(detail ? { detail } : {}), ...(tone ? { tone } : {}) } };
					}),
				});
			} else {
				children.push({ id: this.#ids.input, k: "input", p: { text: this.#field.text, cursor: this.#field.cursor, anchor: this.#field.anchor, placeholder: "" } });
			}
		});
		return [{ id: this.#ids.overlay, k: "overlay", p: { head, size: "md", modal: true, role: "pi.panel" }, c: children }];
	}

	#sheet(title: string, list: SelectListLike, rest: Leaf[]): TspNode {
		const items = list.filteredItems ?? list.items;
		const rows = items.map((item) => serverRow(item.description ?? ""));
		const servers = items.length > 0 && rows.every((row) => row !== undefined) ? (rows as ServerRow[]) : undefined;
		const texts = rest.filter((leaf): leaf is Extract<Leaf, { kind: "text" }> => leaf.kind === "text");
		const hint = texts.map((leaf) => parseHint(leaf.text)).find((actions) => actions !== undefined);
		const body = texts.filter((leaf) => parseHint(leaf.text) === undefined);
		const pickerItems: unknown[] = [];
		const order: (string | { group: string; label: string; count: number })[] = [];
		let group: { group: string; label: string; count: number } | undefined;
		items.forEach((item, n) => {
			const id = `${this.#ids.itemPrefix}${n}`;
			const row = servers?.[n];
			if (row && row.group !== group?.group) {
				group = { group: row.group, label: GROUP_LABELS[row.group], count: 0 };
				order.push(group);
			}
			if (group) group.count++;
			order.push(id);
			pickerItems.push(row
				? { id, label: item.label ?? item.value, mono: true, dot: row.tone, ...(row.detail ? { detail: row.detail } : {}), ...(row.tone === "error" ? { tone: "error" } : {}), badges: [{ text: row.exposure, title: "exposure" }, { text: row.scope, title: "configured in" }], title: item.description }
				: { id, label: item.label ?? item.value, ...(item.description ? { detail: item.description } : {}) });
		});
		const summary = servers ? Object.entries(servers.reduce<Record<string, number>>((acc, row) => ({ ...acc, [row.group]: (acc[row.group] ?? 0) + 1 }), {})).map(([g, count]) => `${count} ${GROUP_LABELS[g as ServerRow["group"]].toLowerCase()}`).join(" · ") : undefined;
		const preview: TspNode[] = body.map((leaf, i) => ({ id: `${this.#ids.overlay}-pv-${i}`, k: "text", p: { text: leaf.text, wrap: "soft", ...(leaf.tone && leaf.tone !== "accent" ? { tone: leaf.tone } : {}) } }));
		// The selected server's whole state, unclipped: a long failure reads in full here.
		const chosen = servers?.[list.selectedIndex];
		if (chosen) preview.unshift({ id: `${this.#ids.overlay}-pv-state`, k: "text", p: { spans: [{ t: items[list.selectedIndex]!.label ?? items[list.selectedIndex]!.value, s: "bold" }, { t: "  " }, { t: chosen.state }], wrap: "soft", ...(chosen.tone === "error" || chosen.tone === "warning" ? { tone: chosen.tone } : {}) } });
		const actions = hint ?? [{ id: "close", label: "Close", keys: ["esc"] }];
		return {
			id: this.#ids.list,
			k: "picker",
			p: {
				title, ...(summary ? { subtitle: summary } : {}), icon: "extension", size: "md", layout: "rows", noun: servers ? "servers" : "items",
				preview: preview.length ? "below" : "none", role: "pi.panel",
				items: pickerItems, order, ...(items.length ? { selected: `${this.#ids.itemPrefix}${list.selectedIndex}` } : {}),
				actions,
			},
			c: preview.length ? [{ id: `${this.#ids.overlay}-pv`, k: "col", p: { gap: "sm" }, c: preview }] : [],
		};
	}
}

// Rows of Pi's `/mcp` server list: "<state> · <exposure> · <scope>", where the state is
// "connected · N tools[ · N resources]", "failed: <error>", "disabled", "needs sign-in", "connecting…", "starting"
// or "disconnected". Anything else returns undefined and the whole list stays plain text, so a wording change in
// Pi degrades to its own words instead of wrong facts.
// `detail` is what the row adds to its dot and group (counts, the error); `state` is Pi's whole state text.
export interface ServerRow { group: "attention" | "starting" | "connected" | "disabled"; tone: Tone; detail: string; state: string; exposure: string; scope: string; tools?: number; resources?: number }
const EXPOSURES = new Set(["direct", "codemode", "deferred", "hidden"]);
const GROUP_LABELS: Record<ServerRow["group"], string> = { attention: "Needs attention", starting: "Starting", connected: "Connected", disabled: "Disabled" };

export function serverRow(description: string): ServerRow | undefined {
	const parts = description.split(" · ");
	if (parts.length < 3) return undefined;
	const scope = parts.at(-1)!;
	const exposure = parts.at(-2)!;
	if (!EXPOSURES.has(exposure) || !scope) return undefined;
	const state = parts.slice(0, -2);
	const base = { exposure, scope };
	const head = state[0]!;
	if (head === "failed" || head.startsWith("failed: ")) return { ...base, group: "attention", tone: "error", detail: state.join(" · ").replace(/^failed: ?/, "") || "failed", state: state.join(" · ") };
	if (head === "connected") {
		let tools: number | undefined;
		let resources: number | undefined;
		for (const segment of state.slice(1)) {
			const m = /^(\d+) (tool|resource)s?$/.exec(segment);
			if (!m) return undefined;
			if (m[2] === "tool") tools = Number(m[1]);
			else resources = Number(m[1]);
		}
		if (tools === undefined) return undefined;
		return { ...base, group: "connected", tone: "success", detail: state.slice(1).join(" · "), state: state.join(" · "), tools, resources: resources ?? 0 };
	}
	if (state.length !== 1) return undefined;
	if (head === "needs sign-in" || head === "disconnected") return { ...base, group: "attention", tone: "warning", detail: head, state: head };
	if (head === "connecting…" || head === "starting") return { ...base, group: "starting", tone: "pending", detail: head, state: head };
	if (head === "disabled") return { ...base, group: "disabled", tone: "muted", detail: "", state: head };
	return undefined;
}

// Pi's key-hint footer ("enter manage • escape/ctrl+c close") as picker actions; undefined when it is not one.
export function parseHint(text: string): { id: string; label: string; keys: string[]; primary?: boolean }[] | undefined {
	const actions: { id: string; label: string; keys: string[]; primary?: boolean }[] = [];
	for (const segment of text.split(" • ")) {
		const m = /^(\S+) (\S.*)$/.exec(segment.trim());
		if (!m) return undefined;
		const keys = m[1]!.split("/");
		const label = m[2]!.charAt(0).toUpperCase() + m[2]!.slice(1);
		if (keys.includes("enter")) actions.push({ id: "select", label, keys: ["enter"], primary: true });
		else if (keys.includes("escape") || keys.includes("esc")) actions.push({ id: "close", label, keys: ["esc"] });
		else return undefined;
	}
	// Pi lists the confirm key first; the bar puts the primary action last.
	return actions.length ? [...actions.filter((a) => !a.primary), ...actions.filter((a) => a.primary)] : undefined;
}

// Pi colours a Text with `theme.fg(name, s)`; the escape it opens with tells us which tone the author meant.
function toneReader(theme: unknown): (text: string) => Tone | undefined {
	const fg = (theme as { fg?: (name: string, s: string) => string } | undefined)?.fg;
	const prefixes: [string, Tone][] = [];
	for (const [name, tone] of [["error", "error"], ["warning", "warning"], ["success", "success"], ["accent", "accent"], ["muted", "muted"], ["dim", "muted"]] as const) {
		try {
			const marked = fg?.call(theme, name, "\u0001") ?? "";
			const prefix = marked.slice(0, marked.indexOf("\u0001"));
			if (prefix) prefixes.push([prefix, tone]);
		} catch {
			// An unknown colour name just gives no tone.
		}
	}
	return (text) => prefixes.find(([prefix]) => text.startsWith(prefix))?.[1];
}
