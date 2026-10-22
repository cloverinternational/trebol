/** Agent-facing `tern` tool: regular signed-in browsers plus pane and tab management in Tern.
 *  Identity: TERN_PANE is the caller's block id; `tern inspect --json` lists each tab's blocks.
 *  Scope: the caller's own tab, plus tabs this process created with `new_tab`. Within those tabs,
 *  `close` and `rename_tab` act only on what this process created (tracked in `Ownership`), so the
 *  user's panes, tabs and browser blocks are never closed or renamed. Ownership lives for this
 *  process only: after a reload, earlier agent-created blocks stay in scope for reads but can't be
 *  closed. */
import { execFile } from "node:child_process";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export const OPS = ["list", "new_tab", "rename_tab", "open", "blocks", "goto", "snapshot", "act", "capture", "close", "split", "focus", "send", "read"] as const;
export const ACTIONS = ["click", "fill", "press", "select", "check", "uncheck", "hover", "scroll"] as const;
export const DIRECTIONS = ["right", "down"] as const;

export type Params = {
	op: (typeof OPS)[number];
	url?: string;
	/** Target pane for open/split; the block for every other op that takes one. */
	block?: number;
	name?: string;
	cwd?: string;
	root?: string;
	depth?: number;
	action?: (typeof ACTIONS)[number];
	ref?: string;
	text?: string;
	keys?: string;
	dy?: number;
	direction?: (typeof DIRECTIONS)[number];
	/** send: press Enter after the text (default true). */
	enter?: boolean;
	/** read: last N lines of the terminal (default 60, max 400). */
	lines?: number;
	/** read: poll until the terminal text contains this literal string. */
	until?: string;
	/** read with until: give up after this many seconds (default 30, max 120). */
	timeout?: number;
};
type TabBlock = { id: number; title?: string; cwd?: string; program?: string };
type Tab = { id: number; name: string | null; sessionId: number | null; blocks: TabBlock[] };
type Inspect = { sessions: { id?: number; tabs: { id: number; name: string | null; blocks: TabBlock[] }[] }[] };
type BrowserBlock = { block: number; url: string; title?: string; owner: number | null };
export type Ownership = { tabs: Set<number>; blocks: Set<number> };

export const createOwnership = (): Ownership => ({ tabs: new Set(), blocks: new Set() });

export const TERN_TOOL = {
	name: "tern",
	label: "Tern",
	description: "Drive Tern from this pane. Regular signed-in browsers: open (url; optional block = pane to open beside, default this pane; answers the new block), blocks, goto (block, url), snapshot (block; tree with element refs), act (block, ref from snapshot, action click|fill|press|select|check|uncheck|hover|scroll, text|keys|dy), capture (block; PNG under artifacts/tern-browser). Terminals: send (block you created with new_tab or split; text, multi-line allowed and pasted as one unit; enter default true presses Enter after), read (block; answers the terminal's last `lines` lines as text; with `until` it polls until that literal text appears or `timeout` seconds pass, answering matched true|false). Panes and tabs: list (tabs and panes you can reach), new_tab (optional cwd absolute directory; answers tab, block), rename_tab (block in a tab you created, name), split (direction right|down, optional block, default this pane; answers the new block), focus (block), close (block you created with open, split or new_tab; never this pane). Typical agent launch: new_tab -> send text 'pi' -> read until a prompt marker -> send the task -> read until done. Only this pane's tab and tabs you created are reachable; send only reaches blocks you created. Refs go stale after navigation; snapshot again. URLs must be http or https. Commands run with no shell and no arbitrary program.",
	parameters: {
		type: "object",
		required: ["op"],
		additionalProperties: false,
		properties: {
			op: { type: "string", enum: [...OPS] },
			url: { type: "string" },
			block: { type: "integer" },
			name: { type: "string" },
			cwd: { type: "string" },
			root: { type: "string" },
			depth: { type: "integer", minimum: 1, maximum: 50 },
			action: { type: "string", enum: [...ACTIONS] },
			ref: { type: "string" },
			text: { type: "string" },
			keys: { type: "string" },
			dy: { type: "integer" },
			direction: { type: "string", enum: [...DIRECTIONS] },
			enter: { type: "boolean" },
			lines: { type: "integer", minimum: 1, maximum: 400 },
			until: { type: "string" },
			timeout: { type: "integer", minimum: 1, maximum: 120 },
		},
	},
} as const;

export type Deps = {
	paneId: number;
	owned: Ownership;
	signal?: AbortSignal;
	inspect(): Promise<Inspect>;
	/** One `tern browser` JSON op; resolves to its `ok` answer. */
	browser(op: Record<string, unknown>): Promise<any>;
	/** Any other `tern` command; resolves to its stdout. */
	tern(args: string[]): Promise<string>;
	/** `tern ctl ARGS`, parsed. */
	ctl(args: string[]): Promise<any>;
	isDirectory(path: string): Promise<boolean>;
	saveCapture(block: number, png: Buffer): Promise<string>;
	delay(ms: number): Promise<void>;
};

type Scope = { caller: Tab; tabs: Tab[]; reachable: Tab[]; reachableBlocks: Set<number> };

/** Shown when the Tern session daemon no longer knows this agent's pane (closed, or the daemon restarted under it). */
export const DEAD_PANE_HINT = "this agent's Tern pane is gone from the session daemon (it closed, or the daemon restarted). Start the agent again from a live Tern pane.";

function allTabs(inspect: Inspect): Tab[] {
	return inspect.sessions.flatMap((s) => s.tabs.map((t) => ({ id: t.id, name: t.name, sessionId: s.id ?? null, blocks: t.blocks })));
}

/** Caller's tab plus agent-created tabs; prunes ownership records for things that no longer exist. */
function scopeOf(paneId: number, inspect: Inspect, owned: Ownership): Scope {
	const tabs = allTabs(inspect);
	const caller = tabs.find((t) => t.blocks.some((b) => b.id === paneId));
	if (!caller) throw new Error(`pane ${paneId} is not in any Tern tab; ${DEAD_PANE_HINT}`);
	const live = new Set(tabs.flatMap((t) => t.blocks.map((b) => b.id)));
	for (const id of [...owned.blocks]) if (!live.has(id)) owned.blocks.delete(id);
	for (const id of [...owned.tabs]) if (!tabs.some((t) => t.id === id)) owned.tabs.delete(id);
	const reachable = tabs.filter((t) => t.id === caller.id || owned.tabs.has(t.id));
	return { caller, tabs, reachable, reachableBlocks: new Set(reachable.flatMap((t) => t.blocks.map((b) => b.id))) };
}

function tabOf(tabs: Tab[], block: number): Tab {
	const tab = tabs.find((t) => t.blocks.some((b) => b.id === block));
	if (!tab) throw new Error(`block ${block} is not in any Tern tab`);
	return tab;
}

function required<T>(value: T | undefined, what: string): T {
	if (value === undefined || value === "") throw new Error(`${what} is required`);
	return value;
}

function webUrl(value: string): string {
	if (!/^https?:\/\/\S+$/.test(value)) throw new Error(`url must be an http or https address: ${value}`);
	return value;
}

function tabName(value: string): string {
	const name = value.trim();
	if (name.length === 0 || name.length > 80 || /[\u0000-\u001f]/.test(name) || name.startsWith("-")) {
		throw new Error("name must be 1-80 characters, no control characters, not starting with '-'");
	}
	return name;
}

function reach(scope: Scope, block: number): void {
	if (!scope.reachableBlocks.has(block)) throw new Error(`block ${block} is not in this pane's tab or an agent-created tab`);
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw new Error("cancelled");
}

export const NAV_START_MS = 3_000;
export const NAV_LOAD_MS = 30_000;
const POLL_MS = 250;

type PageState = { url: string; title?: string | null; loading: boolean };
const pageState = (deps: Deps, block: number): Promise<PageState> => deps.browser({ op: "state", block });

/** Polls until the page stops loading or the budget runs out. `loaded` is false only when the budget ran out first. */
async function waitForLoad(deps: Deps, block: number, budgetMs: number): Promise<PageState & { loaded: boolean }> {
	let s = await pageState(deps, block);
	for (let waited = 0; s.loading && waited < budgetMs; waited += POLL_MS) {
		throwIfAborted(deps.signal);
		await deps.delay(POLL_MS);
		s = await pageState(deps, block);
	}
	return { ...s, loaded: !s.loading };
}

/** After an action a navigation can start a moment later: wait briefly for it to start, then for it to finish. */
async function settleAfterAction(deps: Deps, block: number, before: string) {
	let s = await pageState(deps, block);
	for (let waited = 0; !s.loading && s.url === before && waited < NAV_START_MS; waited += POLL_MS) {
		throwIfAborted(deps.signal);
		await deps.delay(POLL_MS);
		s = await pageState(deps, block);
	}
	const navigated = s.loading || s.url !== before;
	const page = navigated ? await waitForLoad(deps, block, NAV_LOAD_MS) : { ...s, loaded: true };
	return { navigated, url: page.url, title: page.title ?? null, loaded: page.loaded };
}

async function browserBlocks(deps: Deps): Promise<BrowserBlock[]> {
	return (await deps.browser({ op: "blocks" })).blocks as BrowserBlock[];
}

async function requireBrowser(deps: Deps, scope: Scope, block: number): Promise<number> {
	reach(scope, block);
	if (!(await browserBlocks(deps)).some((b) => b.block === block)) throw new Error(`block ${block} is not a browser block`);
	return block;
}

/** Makes the target pane focused, since `ctl browser open` places its block beside the focused pane. */
async function focusBlock(block: number, deps: Deps): Promise<void> {
	const focusedId = async () => (await deps.ctl(["state"])).focused?.id;
	if ((await focusedId()) === block) return;
	await deps.tern(["focus", String(block)]);
	const now = await focusedId();
	if (now !== block) throw new Error(`could not focus block ${block}; focused is ${now}`);
}

/** Opens a regular browser beside `target`. Success requires exactly one new browser block, in the target's tab. */
async function openRegularBrowser(address: string, target: number, deps: Deps): Promise<unknown> {
	const before = new Set((await browserBlocks(deps)).map((b) => b.block));
	const scope = scopeOf(deps.paneId, await deps.inspect(), deps.owned);
	reach(scope, target);
	const targetTabId = tabOf(scope.tabs, target).id;
	await focusBlock(target, deps);
	const answer = await deps.ctl(["browser", "open", address]);
	if (answer?.ok !== true) throw new Error(`ctl browser open failed: ${JSON.stringify(answer)}`);
	let created: number[] = [];
	for (let attempt = 0; attempt < 40 && created.length === 0; attempt += 1) {
		throwIfAborted(deps.signal);
		await deps.delay(250);
		created = (await browserBlocks(deps)).map((b) => b.block).filter((id) => !before.has(id));
	}
	if (created.length === 0) throw new Error("ctl browser open answered ok but no browser block appeared");
	if (created.length > 1) {
		throw new Error(`${created.length} browser blocks appeared at once (${created.join(", ")}); cannot tell which is this agent's, so none was tracked or closed`);
	}
	const [block] = created;
	const landed = tabOf(allTabs(await deps.inspect()), block);
	if (landed.id !== targetTabId) throw new Error(`new browser block ${block} landed outside the target tab; left open, not tracked`);
	deps.owned.blocks.add(block);
	return { block, url: address, tab: landed.id };
}

/** TEMPORARY WORKAROUND, remove once fixed upstream (stencil-hq/tern-sdk#133). The native `act click` sends CSS
 *  coordinates without scaling by devicePixelRatio, so clicks land off target and navigated stays false.
 *  Here the element's center (CSS px) is scaled by dpr and clicked through the `input` op instead. */
export function dprScaledPoint(rect: { x: number; y: number; width: number; height: number }, dpr: number): { x: number; y: number } {
	return { x: (rect.x + rect.width / 2) * dpr, y: (rect.y + rect.height / 2) * dpr };
}

/** The accessible name of the snapshot node carrying `ref`, or null when the tree has no such node. */
export function refName(node: any, ref: string): string | null {
	if (!node || typeof node !== "object") return null;
	if (node.ref === ref) return typeof node.name === "string" ? node.name : null;
	for (const child of node.children ?? []) {
		const found = refName(child, ref);
		if (found !== null) return found;
	}
	return null;
}

/** TEMPORARY WORKAROUND (see dprScaledPoint). Resolves the click point for a snapshot ref by matching its name against
 *  visible links and buttons in the page; null when the element can't be resolved, so the caller falls back to native act. */
async function dprClickPoint(deps: Deps, block: number, ref: string): Promise<{ x: number; y: number } | null> {
	const snap = await deps.browser({ op: "snapshot", block, format: "tree" });
	const name = refName(snap?.tree, ref);
	if (name === null) return null;
	const found = await deps.browser({
		op: "eval",
		block,
		function: `() => { const want = ${JSON.stringify(name)};
			const el = [...document.querySelectorAll("a,button,[role=link],[role=button]")].find((e) => (e.textContent || "").trim() === want);
			if (!el) return null;
			const r = el.getBoundingClientRect();
			if (r.width === 0 || r.height === 0 || r.bottom < 0 || r.top > innerHeight) return null;
			return { x: r.x, y: r.y, width: r.width, height: r.height, dpr: window.devicePixelRatio }; }`,
	});
	const hit = found?.value;
	return hit ? dprScaledPoint(hit, hit.dpr) : null;
}

export async function runTern(p: Params, deps: Deps): Promise<unknown> {
	const current = async () => scopeOf(deps.paneId, await deps.inspect(), deps.owned);
	switch (p.op) {
		case "list": {
			const s = await current();
			const urls = new Map((await browserBlocks(deps)).map((b) => [b.block, b.url]));
			return {
				tabs: s.reachable.map((t) => ({
					tab: t.id,
					name: t.name,
					caller: t.id === s.caller.id,
					agentCreated: deps.owned.tabs.has(t.id),
					blocks: t.blocks.map((b) => ({
						block: b.id,
						title: b.title ?? null,
						cwd: b.cwd ?? null,
						program: b.program ?? null,
						caller: b.id === deps.paneId,
						agentCreated: deps.owned.blocks.has(b.id),
						url: urls.get(b.id) ?? null,
					})),
				})),
			};
		}
		case "new_tab": {
			const s = await current();
			const session = s.caller.sessionId;
			if (session === null) throw new Error("caller's session is unknown; cannot create a tab");
			if (p.cwd !== undefined && (!isAbsolute(p.cwd) || !(await deps.isDirectory(p.cwd)))) {
				throw new Error(`cwd must be an existing absolute directory: ${p.cwd}`);
			}
			const made = JSON.parse(await deps.tern(["new", "tab", String(session), ...(p.cwd ? ["--cwd", p.cwd] : []), "--json"]));
			deps.owned.tabs.add(made.tab);
			deps.owned.blocks.add(made.block);
			return { tab: made.tab, block: made.block, session: made.session };
		}
		case "rename_tab": {
			const s = await current();
			const block = required(p.block, "block");
			reach(s, block);
			const tab = tabOf(s.tabs, block);
			if (!deps.owned.tabs.has(tab.id)) throw new Error(`tab of block ${block} was not created by this agent; only agent-created tabs can be renamed`);
			const name = tabName(required(p.name, "name"));
			await deps.tern(["rename", String(block), name, "--json"]);
			return { tab: tab.id, name };
		}
		case "open":
			return openRegularBrowser(webUrl(required(p.url, "url")), p.block ?? deps.paneId, deps);
		case "blocks": {
			const s = await current();
			return { blocks: (await browserBlocks(deps)).filter((b) => s.reachableBlocks.has(b.block)) };
		}
		case "goto": {
			const s = await current();
			const block = await requireBrowser(deps, s, required(p.block, "block"));
			const answer = await deps.browser({ op: "goto", block, url: webUrl(required(p.url, "url")) });
			const page = await waitForLoad(deps, block, NAV_LOAD_MS);
			return { ...answer, url: page.url, title: page.title ?? null, loaded: page.loaded };
		}
		case "snapshot": {
			const s = await current();
			return deps.browser({ op: "snapshot", block: await requireBrowser(deps, s, required(p.block, "block")), root: p.root, depth: p.depth });
		}
		case "act": {
			const s = await current();
			const block = await requireBrowser(deps, s, required(p.block, "block"));
			if (!p.action || !(ACTIONS as readonly string[]).includes(p.action)) throw new Error(`unknown action: ${p.action}`);
			const before = (await pageState(deps, block)).url;
			if (p.action === "click") {
				const point = await dprClickPoint(deps, block, required(p.ref, "ref"));
				if (point) {
					const at = { type: "mouse", x: point.x, y: point.y, button: "left" };
					await deps.browser({ op: "input", block, events: [{ ...at, action: "down" }, { ...at, action: "up" }] });
					return { done: true, clickedAt: point, ...(await settleAfterAction(deps, block, before)) };
				}
			}
			const answer = await deps.browser({ op: "act", block, action: p.action, ref: required(p.ref, "ref"), text: p.text, keys: p.keys, dy: p.dy });
			return { ...answer, ...(await settleAfterAction(deps, block, before)) };
		}
		case "capture": {
			const s = await current();
			const block = await requireBrowser(deps, s, required(p.block, "block"));
			const shot = await deps.browser({ op: "capture", block });
			return { path: await deps.saveCapture(block, Buffer.from(shot.data, "base64")) };
		}
		case "close": {
			const s = await current();
			const block = required(p.block, "block");
			if (block === deps.paneId) throw new Error("refusing to close this agent's own pane");
			if (!deps.owned.blocks.has(block)) throw new Error(`block ${block} was not created by this agent; only blocks it created can be closed`);
			reach(s, block);
			await deps.tern(["close", String(block), "--json"]);
			deps.owned.blocks.delete(block);
			return { closed: block };
		}
		case "split": {
			const s = await current();
			const anchor = p.block ?? deps.paneId;
			reach(s, anchor);
			const direction = required(p.direction, "direction");
			if (!(DIRECTIONS as readonly string[]).includes(direction)) throw new Error(`unknown direction: ${direction}`);
			const tabId = tabOf(s.tabs, anchor).id;
			const before = new Set(tabOf(s.tabs, anchor).blocks.map((b) => b.id));
			await deps.tern(["split", String(anchor), direction]);
			const after = allTabs(await deps.inspect()).find((t) => t.id === tabId)!;
			const created = after.blocks.map((b) => b.id).filter((id) => !before.has(id));
			if (created.length !== 1) throw new Error(`split added ${created.length} blocks to the tab, expected 1`);
			deps.owned.blocks.add(created[0]);
			return { block: created[0], beside: anchor, direction };
		}
		case "focus": {
			const s = await current();
			const block = required(p.block, "block");
			reach(s, block);
			await focusBlock(block, deps);
			return { focused: block };
		}
		case "send": {
			const s = await current();
			const block = required(p.block, "block");
			reach(s, block);
			if (!deps.owned.blocks.has(block)) throw new Error(`block ${block} was not created by this agent; only blocks it created can receive input`);
			const text = required(p.text, "text");
			// Newlines and tabs are allowed and delivered as one bracketed paste; every other control character
			// (escape sequences, Ctrl-C, bells) is refused so a send can't drive the terminal outside its text.
			if (text.length > 20_000 || /[\u0000-\u0008\u000b-\u001f\u007f]/.test(text)) {
				throw new Error("text must be 1-20000 characters; newlines and tabs allowed, no other control characters");
			}
			const multiLine = /[\n\t]/.test(text);
			await deps.tern(["send", String(block), multiLine ? "paste" : "text", text]);
			const enter = p.enter !== false;
			if (enter) await deps.tern(["send", String(block), "keys", "Enter"]);
			return { sent: block, chars: text.length, mode: multiLine ? "paste" : "text", enter };
		}
		case "read": {
			const s = await current();
			const block = required(p.block, "block");
			reach(s, block);
			const lines = Math.min(Math.max(p.lines ?? 60, 1), 400);
			const tail = async () => {
				const all = (await deps.tern(["capture", String(block)])).replace(/\s+$/, "").split("\n");
				return all.slice(-lines).join("\n");
			};
			if (p.until === undefined) return { block, text: await tail() };
			const until = required(p.until, "until");
			const deadline = Math.min(Math.max(p.timeout ?? 30, 1), 120) * 1000;
			let text = await tail();
			for (let waited = 0; !text.includes(until) && waited < deadline; waited += 1000) {
				throwIfAborted(deps.signal);
				await deps.delay(1000);
				text = await tail();
			}
			return { block, text, matched: text.includes(until) };
		}
		default:
			throw new Error(`unknown op: ${String(p.op)}`);
	}
}

const MAX_ERROR = 400;
function bounded(text: string): string {
	const t = text.trim();
	return t.length > MAX_ERROR ? `${t.slice(0, MAX_ERROR)}...` : t;
}

/** The error for a failed `tern` command. A pane the daemon has never heard of, or has dropped, gets the actionable hint. */
export function ternFailure(command: string, text: string): Error {
	if (/no such pane/.test(text)) return new Error(`tern ${command}: ${DEAD_PANE_HINT}`);
	return new Error(`tern ${command} failed: ${bounded(text)}`);
}

/** Runs `tern ARGS` with no shell. Rejects with the bounded stderr; `stdout` is attached for JSON error answers. */
async function execTern(args: string[], signal?: AbortSignal): Promise<string> {
	try {
		return (await run("tern", args, { timeout: 60_000, maxBuffer: 128 * 1024 * 1024, signal })).stdout;
	} catch (err: any) {
		if (signal?.aborted) throw new Error(`tern ${args[0]} cancelled`);
		const text = String(err.stderr || err.message);
		throw Object.assign(ternFailure(args[0], text), {
			stdout: typeof err.stdout === "string" ? err.stdout : "",
		});
	}
}

const processOwnership = createOwnership();

/** Deps for the live window that runs this process. Fails outside a Tern pane. */
export function realDeps(env: NodeJS.ProcessEnv = process.env, signal?: AbortSignal): Deps {
	const paneId = Number(env.TERN_PANE);
	if (!env.TERN_PANE || !Number.isInteger(paneId)) {
		throw new Error("TERN_PANE is not set: the tern tool only runs inside a Tern pane");
	}
	return {
		paneId,
		owned: processOwnership,
		signal,
		inspect: async () => JSON.parse(await execTern(["inspect", "--json"], signal)),
		browser: async (op) => {
			const stdout = await execTern(["browser", JSON.stringify(op), "--timeout", "30"], signal).catch((e) => {
				if (e.stdout) return e.stdout as string;
				throw e;
			});
			const answer = JSON.parse(stdout);
			if (answer.error) throw new Error(`${String(op.op)}: ${answer.error.kind}: ${answer.error.message}`);
			return answer.ok;
		},
		tern: (args) => execTern(args, signal),
		ctl: async (args) => JSON.parse(await execTern(["ctl", ...args], signal)),
		isDirectory: async (path) => stat(path).then((s) => s.isDirectory(), () => false),
		saveCapture: async (block, png) => {
			const dir = join(process.cwd(), "artifacts", "tern-browser");
			await mkdir(dir, { recursive: true });
			const file = join(dir, `capture-${block}-${Date.now()}.png`);
			await writeFile(file, png);
			return file;
		},
		delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
	};
}
