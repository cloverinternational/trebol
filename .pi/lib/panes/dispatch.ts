/**
 * Route the `tern` tool's pane operations to whichever runtime is present.
 *
 * The native Tern runtime keeps its own dispatcher (`runTern`): it owns browser blocks, the
 * session daemon and the caller's pane. A terminal multiplexer has none of those, so rather
 * than pretend it is Tern, this module serves the eight pane/tab/terminal ops directly and
 * returns the same answer shapes. Callers cannot tell which runtime answered, except by the
 * absent browser surface.
 *
 * Two deliberate semantic differences on the fallback, both reported rather than hidden:
 *  - There is no caller pane, so `list` marks nothing as `caller`.
 *  - Ownership is still enforced: only blocks this process created can be sent to or closed.
 */
import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import {
	BROWSER_OPS,
	createOwnership,
	OPS,
	PANE_OPS,
	type Inspect,
	type Ownership,
	type Params,
} from "../tern/browser.ts";

/** The terminal half of a multiplexer, as the dispatcher needs it. Structural on purpose: the
 *  herdr adapter satisfies this shape without the dispatcher depending on its CLI details. */
export type PaneBackend = {
	inspect(): Promise<Inspect>;
	newTab(options: { cwd?: string; label?: string }): Promise<{ tab: number; block: number }>;
	renameTab(tab: number, name: string): Promise<void>;
	split(options: { pane: number; direction: "right" | "down" }): Promise<{ block: number }>;
	focus(block: number): Promise<void>;
	close(block: number): Promise<void>;
	send(block: number, text: string, options: { enter: boolean }): Promise<void>;
	read(block: number, options: { lines?: number; until?: string; timeout?: number }): Promise<{ text: string; matched?: boolean }>;
};

const MAX_TEXT = 20_000;
/** Newlines and tabs are allowed (delivered as one paste); every other control character is not. */
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/;

const required = <T>(value: T | undefined, name: string): T => {
	if (value === undefined) throw new Error(`${name} is required for this op`);
	return value;
};

/** Tab name rules, matching the native runtime's (single line, bounded). */
export function paneTabName(name: string): string {
	const trimmed = name.trim();
	if (!trimmed) throw new Error("name must not be empty");
	if (trimmed.length > 200) throw new Error("name must be at most 200 characters");
	if (/[\n\r\t]/.test(trimmed)) throw new Error("name must be a single line");
	return trimmed;
}

type TabView = Inspect["sessions"][number]["tabs"][number];

function tabOf(tabs: TabView[], block: number): TabView {
	const tab = tabs.find((t) => t.blocks.some((b) => b.id === block));
	if (!tab) throw new Error(`block ${block} is not in any tab`);
	return tab;
}

/**
 * Run one pane op against `backend`.
 *
 * Browser ops fail loudly here instead of silently: the schema should already have hidden them
 * on this backend, so reaching one means a hand-written call, and the answer says what to do.
 */
export async function runPaneOp(p: Params, backend: PaneBackend, owned: Ownership = createOwnership()): Promise<unknown> {
	if ((BROWSER_OPS as readonly string[]).includes(p.op)) {
		throw new Error(`${p.op} needs the native Tern runtime (browsers, snapshots and screenshots are not available on this pane backend)`);
	}
	const inspect = () => backend.inspect();
	const tabs = async () => (await inspect()).sessions.flatMap((s) => s.tabs);
	switch (p.op) {
		case "list": {
			const all = await tabs();
			return {
				tabs: all.map((t) => ({
					tab: t.id,
					name: t.name,
					// No caller pane exists on this backend, so there is no tab to call "own".
					caller: false,
					agentCreated: owned.tabs.has(t.id),
					blocks: t.blocks.map((b) => ({
						block: b.id,
						title: b.title ?? null,
						cwd: b.cwd ?? null,
						program: b.program ?? null,
						caller: false,
						agentCreated: owned.blocks.has(b.id),
						url: null,
					})),
				})),
			};
		}
		case "new_tab": {
			if (p.cwd !== undefined) {
				if (!isAbsolute(p.cwd)) throw new Error(`cwd must be an absolute directory: ${p.cwd}`);
				const isDir = await stat(p.cwd).then((s) => s.isDirectory()).catch(() => false);
				if (!isDir) throw new Error(`cwd must be an existing absolute directory: ${p.cwd}`);
			}
			const made = await backend.newTab({ cwd: p.cwd, label: p.name });
			owned.tabs.add(made.tab);
			owned.blocks.add(made.block);
			return { tab: made.tab, block: made.block, session: null };
		}
		case "rename_tab": {
			const block = required(p.block, "block");
			const tab = tabOf(await tabs(), block);
			if (!owned.tabs.has(tab.id)) throw new Error(`tab of block ${block} was not created by this agent; only agent-created tabs can be renamed`);
			const name = paneTabName(required(p.name, "name"));
			await backend.renameTab(tab.id, name);
			return { tab: tab.id, name };
		}
		case "split": {
			const anchor = p.block ?? (await tabs()).flatMap((t) => t.blocks).at(0)?.id;
			if (anchor === undefined) throw new Error("there is no pane to split");
			const direction = required(p.direction, "direction");
			if (direction !== "right" && direction !== "down") throw new Error(`unknown direction: ${direction}`);
			const made = await backend.split({ pane: anchor, direction });
			owned.blocks.add(made.block);
			return { block: made.block, beside: anchor, direction };
		}
		case "focus": {
			const block = required(p.block, "block");
			await backend.focus(block);
			return { focused: block };
		}
		case "close": {
			const block = required(p.block, "block");
			if (!owned.blocks.has(block)) throw new Error(`block ${block} was not created by this agent; only blocks it created can be closed`);
			await backend.close(block);
			owned.blocks.delete(block);
			return { closed: block };
		}
		case "send": {
			const block = required(p.block, "block");
			if (!owned.blocks.has(block)) throw new Error(`block ${block} was not created by this agent; only blocks it created can receive input`);
			const text = required(p.text, "text");
			if (text.length > MAX_TEXT || CONTROL.test(text)) {
				throw new Error(`text must be 1-${MAX_TEXT} characters; newlines and tabs allowed, no other control characters`);
			}
			const enter = p.enter !== false;
			await backend.send(block, text, { enter });
			return { sent: block, chars: text.length, mode: /[\n\t]/.test(text) ? "paste" : "text", enter };
		}
		case "read": {
			const block = required(p.block, "block");
			const lines = Math.min(Math.max(p.lines ?? 60, 1), 400);
			const answer = p.until === undefined
				? await backend.read(block, { lines })
				: await backend.read(block, { lines, until: p.until, timeout: Math.min(Math.max(p.timeout ?? 30, 1), 120) });
			if (p.until === undefined) return { block, text: answer.text };
			return { block, text: answer.text, matched: answer.matched ?? answer.text.includes(p.until) };
		}
		default:
			throw new Error(`unknown op: ${String(p.op)}`);
	}
}

/** The ops a backend can serve, for registration. Filters the canonical order rather than
 *  concatenating, so the surviving ops keep their documented sequence. */
export function opsFor(hasBrowser: boolean): readonly (typeof OPS)[number][] {
	if (hasBrowser) return OPS;
	return OPS.filter((op) => !(BROWSER_OPS as readonly string[]).includes(op));
}
