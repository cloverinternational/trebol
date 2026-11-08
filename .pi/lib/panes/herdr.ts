/**
 * Herdr CLI adapter: tabs and panes for a herdr workspace manager.
 *
 * Herdr is the fallback pane runtime for when Tern is not installed: it lists, creates and drives
 * terminals, and it cannot drive a browser at all (decision D1 in
 * docs/plans/active/2026-11-07-pane-runtime-detection-and-herdr-fallback.md).
 *
 * Four facts shape this file, each verified against herdr 0.9.5:
 *
 *  1. **Exit status does not say whether the call worked.** `herdr pane list` with no server answers
 *     `{"error":{"code":"server_not_running"}}` — observed here with exit status 1 and the envelope
 *     on **stderr**, while the plan's fact table recorded exit status 0 on stdout. Both are handled
 *     the same way: the envelope decides, the status is ignored. Every failure throws, so a refusal
 *     can never read as success.
 *  2. **Output shape is per command.** `tab list`, `pane list`, `tab create`, `pane split` and
 *     `pane wait-output` print a JSON envelope; `pane read` prints the terminal text itself;
 *     `pane send-text`, `pane send-keys`, `pane run` and `pane close` print nothing at all.
 *     `execCommand` is told which shape to expect instead of guessing, so an empty terminal is never
 *     mistaken for a broken pipe and a silent write is not parsed as JSON.
 *  3. **Ids are strings, the tool contract speaks numbers.** Herdr names panes `w1:p1` and tabs
 *     `w1:t1`; Tern's ops take numeric blocks. `Ids` keeps a process-local string<->number map and
 *     hands out increasing integers for the panes and tabs this process created or observed. The
 *     mapping does not survive a restart — the same lifetime rule as Tern's `Ownership` in
 *     `.pi/lib/tern/browser.ts`, and the reason `keyFor` says so when it rejects an unknown number.
 *  4. **`pane focus` is not "focus this pane".** 0.9.5 offers `pane focus --direction <dir>` (focus
 *     the *neighbour* of a pane) and `tab focus <tab_id>`. `focus` therefore raises the pane's tab
 *     and reports `level: "tab"`, rather than claiming a pane focus it cannot perform.
 *
 * The adapter never starts a server: `herdr server` is a long-lived process and a silent spawn
 * would leak it. `server_not_running` surfaces as a `HerdrError` with exactly that code, for the
 * caller to report or offer to start one.
 *
 * Ownership: as in Tern, `close`, `rename_tab` and `send` act only on panes and tabs this process
 * created, and are refused otherwise. `createHerdrBackend(run, { enforceOwnership: false })` turns
 * that guard off for callers that already track scope themselves.
 */
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import { herdrServerRunning, resolveBinary } from "./install-probe.ts";

/** A CLI call can hang on a wedged socket; nothing here is worth waiting longer than this. */
export const RUN_TIMEOUT_MS = 30_000;
export const DEFAULT_LINES = 60;
export const MAX_LINES = 400;
export const DEFAULT_WAIT_SECONDS = 30;
export const MAX_WAIT_SECONDS = 120;
export const DIRECTIONS = ["right", "down"] as const;

/**
 * One `herdr` invocation. Injectable so tests need no binary and no socket.
 *
 * `stderr` and `code` are optional members beyond the bare stdout contract because herdr 0.9.5
 * reports a failed command on stderr with a non-zero status: a fake that only returns `{ stdout }`
 * is still a valid `HerdrRun`, and the default implementation fills all three in.
 */
export type HerdrRun = (args: string[], signal?: AbortSignal) => Promise<{ stdout: string; stderr?: string; code?: number }>;

export type HerdrOutput = { stdout: string; stderr?: string; code?: number };

/**
 * A herdr refusal, carrying herdr's own `error.code` unchanged (`server_not_running`,
 * `pane_not_found`, …) so callers can branch on it instead of matching message text.
 *
 * Codes this file raises itself are not herdr's: `empty_output`, `unparseable_output`,
 * `unexpected_result`, `spawn_failed`, `timeout`, `unknown_block`, `invalid_argument` and
 * `not_owned` all describe a malformed answer or a locally refused call.
 */
export class HerdrError extends Error {
	code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "HerdrError";
		this.code = code;
	}
}

const MAX_SNIPPET = 240;

/** A bounded, control-free excerpt of what herdr printed, for an error message. */
function snippet(text: string): string {
	const flat = text.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
	return flat.length > MAX_SNIPPET ? `${flat.slice(0, MAX_SNIPPET)}…` : flat;
}

type Envelope = { ok: true; result: unknown } | { ok: false; error: HerdrError };

/** A parsed envelope, or undefined when the text is not one (plain terminal text, empty output). */
function envelopeOf(text: string | undefined, command: string): Envelope | undefined {
	const trimmed = (text ?? "").trim();
	if (!trimmed.startsWith("{")) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return undefined;
	}

	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
	const record = parsed as { error?: unknown; result?: unknown };
	if (record.error !== undefined && record.error !== null) {
		const failure = record.error as { code?: unknown; message?: unknown };
		const code = typeof failure.code === "string" && failure.code !== "" ? failure.code : "unknown_error";
		const detail = typeof failure.message === "string" && failure.message !== "" ? failure.message : JSON.stringify(record.error);
		return { ok: false, error: new HerdrError(code, `herdr ${command}: ${detail} (${code})`) };
	}

	if (!("result" in record)) return undefined;
	return { ok: true, result: record.result };
}

/**
 * The `result` of a herdr JSON envelope, or a thrown `HerdrError` carrying the envelope's error code.
 *
 * Exit status is deliberately not consulted: a refusal arrives with status 0 on some builds and 1 on
 * others, and only the body is authoritative.
 */
export function parseEnvelope(stdout: string, command: string): unknown {
	const text = (stdout ?? "").trim();
	if (text === "") throw new HerdrError("empty_output", `herdr ${command} printed nothing; expected a JSON envelope`);
	const parsed = envelopeOf(text, command);
	if (!parsed) throw new HerdrError("unparseable_output", `herdr ${command} did not answer with a JSON envelope: ${snippet(text)}`);
	if (!parsed.ok) throw parsed.error;
	return parsed.result;
}

/** How a command answers: an envelope, plain terminal text, or nothing on success. */
type Expectation = "envelope" | "text" | "silent";

/**
 * Run one command and interpret its answer according to `expect`.
 *
 * Both streams are inspected for an error envelope before anything is returned, because herdr 0.9.5
 * writes its refusals to stderr while other builds write them to stdout.
 */
async function execCommand(run: HerdrRun, args: string[], expect: Expectation, signal?: AbortSignal): Promise<{ result: unknown; text: string }> {
	const command = args.slice(0, 2).join(" ");
	const out = await run(args, signal);
	const stdout = out.stdout ?? "";
	const stderr = out.stderr ?? "";
	const envelopes = [stdout, stderr].map((stream) => envelopeOf(stream, command));
	const failure = envelopes.find((envelope) => envelope !== undefined && !envelope.ok);
	if (failure && !failure.ok) throw failure.error;
	const success = envelopes.find((envelope) => envelope !== undefined && envelope.ok);

	if (expect === "envelope") {
		if (!success || !success.ok) {
			const printed = stdout.trim() || stderr.trim();
			if (printed === "") throw new HerdrError("empty_output", `herdr ${command} printed nothing; expected a JSON envelope`);
			throw new HerdrError("unparseable_output", `herdr ${command} did not answer with a JSON envelope: ${snippet(printed)}`);
		}
		return { result: success.result, text: "" };
	}

	// `pane read` prints the snapshot itself, and an empty pane is an empty string, not a failure.
	if (expect === "text") return { result: undefined, text: stdout.replace(/\s+$/, "") };
	return { result: undefined, text: "" };
}

/**
 * A process-local string<->number map, so callers keep speaking Tern's numeric blocks.
 *
 * Numbers are allocated in observation order, never reused, and stay stable for as long as this
 * process lives. A restart starts again at 1: numbers from a previous process mean nothing here.
 *
 * A closure rather than a class: `.pi` modules are also loaded through node's type stripping, which
 * rejects TypeScript-only syntax such as parameter properties.
 */
function createIds(what: string) {
	let next = 1;
	const byKey = new Map<string, number>();
	const byId = new Map<number, string>();
	return {
		idFor(key: string): number {
			const existing = byKey.get(key);
			if (existing !== undefined) return existing;
			const id = next;
			next += 1;
			byKey.set(key, id);
			byId.set(id, key);
			return id;
		},
		keyFor(id: number): string {
			const key = byId.get(id);
			if (key === undefined) {
				throw new HerdrError(
					"unknown_block",
					`${what} ${id} is not one herdr showed this process; these ids are process-local, so run list again after a restart`,
				);
			}
			return key;
		},
		forget(id: number): void {
			const key = byId.get(id);
			if (key === undefined) return;
			byId.delete(id);
			byKey.delete(key);
		},
	};
}

type TabRow = { tab_id: string; label?: string; number?: number; workspace_id?: string; focused: boolean };
type PaneRow = { pane_id: string; tab_id: string; cwd?: string; foreground_cwd?: string; focused: boolean; title?: string };

/** Tern's inspect answer, which is what the pane tool's `list` op is built on. */
export type Inspect = {
	sessions: { id?: number; tabs: { id: number; name: string | null; blocks: { id: number; title?: string; cwd?: string; program?: string }[] }[] }[];
};

/**
 * A tab's name, or null when it has none.
 *
 * Herdr always carries a label, and the default label is just the tab's number ("1"), so a tab whose
 * label equals its number is reported as unnamed — the same thing Tern says with `name: null` — and
 * an agent-given label is reported as-is.
 */
export function tabDisplayName(label: string | undefined, number: number | undefined): string | null {
	const name = (label ?? "").trim();
	if (name === "") return null;
	if (number !== undefined && name === String(number)) return null;
	return name;
}

/** Herdr's label rules, matching the tern tool's: visible, short, and never mistaken for a flag. */
function tabName(value: string): string {
	const name = (value ?? "").trim();
	if (name.length === 0 || name.length > 80 || /[\u0000-\u001f]/.test(name) || name.startsWith("-")) {
		throw new HerdrError("invalid_argument", "name must be 1-80 characters, no control characters, not starting with '-'");
	}
	return name;
}

/** The text a `send` is allowed to type: everything printable, plus newlines and tabs, as one paste. */
function sendable(value: string): string {
	if (value === "") throw new HerdrError("invalid_argument", "text is required");
	if (value.length > 20_000 || /[\u0000-\u0008\u000b-\u001f\u007f]/.test(value)) {
		throw new HerdrError("invalid_argument", "text must be 1-20000 characters; newlines and tabs allowed, no other control characters");
	}
	return value;
}

const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), max);

const textOf = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);
const countOf = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
const objectOf = (value: unknown): Record<string, unknown> | undefined =>
	value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

function rowsOf(result: unknown, key: string, command: string): Record<string, unknown>[] {
	const holder = objectOf(result);
	if (!holder) throw new HerdrError("unexpected_result", `herdr ${command} answered without a result object`);
	const rows = holder[key];
	if (!Array.isArray(rows)) throw new HerdrError("unexpected_result", `herdr ${command} answered without a '${key}' array`);
	return rows.map((row) => {
		const record = objectOf(row);
		if (!record) throw new HerdrError("unexpected_result", `herdr ${command} answered a malformed '${key}' row`);
		return record;
	});
}

function tabRow(row: Record<string, unknown>): TabRow {
	const tab_id = textOf(row.tab_id);
	if (!tab_id) throw new HerdrError("unexpected_result", "herdr tab list answered a tab without a tab_id");
	return { tab_id, label: textOf(row.label), number: countOf(row.number), workspace_id: textOf(row.workspace_id), focused: row.focused === true };
}

function paneRow(row: Record<string, unknown>): PaneRow {
	const pane_id = textOf(row.pane_id);
	const tab_id = textOf(row.tab_id);
	if (!pane_id || !tab_id) throw new HerdrError("unexpected_result", "herdr pane list answered a pane without pane_id and tab_id");
	return {
		pane_id,
		tab_id,
		cwd: textOf(row.cwd),
		foreground_cwd: textOf(row.foreground_cwd),
		focused: row.focused === true,
		title: textOf(row.label) ?? textOf(row.title),
	};
}

/**
 * The id a create answered with.
 *
 * `tab create`'s payload is the one shape in the verified fact set that was not captured verbatim,
 * so both shapes herdr uses elsewhere are accepted — `{ tab: { tab_id } }` and a bare row — and
 * anything else is a named `unexpected_result` rather than a silent undefined.
 */
function createdId(result: unknown, field: "tab_id" | "pane_id", command: string): string {
	const nested = objectOf(objectOf(result)?.[field === "tab_id" ? "tab" : "pane"]);
	const row = nested ?? objectOf(result);
	const id = row ? textOf(row[field]) : undefined;
	if (!id) throw new HerdrError("unexpected_result", `herdr ${command} answered without a ${field}`);
	return id;
}

function readText(result: unknown): string | undefined {
	const read = objectOf(objectOf(result)?.read);
	if (!read) return undefined;
	return typeof read.text === "string" ? read.text : undefined;
}

/** A wait that ran out of time is an answer ("nothing matched yet"), not a failure. */
const isTimeoutCode = (code: string): boolean => /timeout|timed[_ ]?out|deadline/i.test(code);

export type HerdrBackendOptions = {
	/** Aborts every call this backend makes. */
	signal?: AbortSignal;
	/** Refuse close/rename/send on panes and tabs this process did not create. Default true. */
	enforceOwnership?: boolean;
};

export type SplitRequest = { pane?: number; direction: (typeof DIRECTIONS)[number] };
export type ReadOptions = { lines?: number; until?: string; timeout?: number };

/**
 * Resolve the herdr binary the way the install probe does: an explicit `PI_SWARM_HERDR_BIN`, then
 * PATH, then the install directories, and a bare `herdr` as the last resort so `execFile`'s own
 * lookup still gets a chance.
 */
function resolveHerdr(): string {
	return resolveBinary(["herdr"], { env: process.env, home: homedir(), override: process.env.PI_SWARM_HERDR_BIN }) ?? "herdr";
}

/**
 * The default runner: `execFile` with no shell, a bounded timeout and both streams kept.
 *
 * A numeric exit status is herdr's own answer, so it resolves with both streams for the envelope
 * parser to judge. A spawn failure (ENOENT) or a timeout is not an answer, so it rejects.
 */
export const herdrRun: HerdrRun = (args, signal) =>
	new Promise<HerdrOutput>((resolvePromise, reject) => {
		execFile(resolveHerdr(), args, { timeout: RUN_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, signal }, (error, stdout, stderr) => {
			const out: HerdrOutput = { stdout: String(stdout ?? ""), stderr: String(stderr ?? "") };
			if (!error) return resolvePromise(out);
			const code = (error as { code?: unknown }).code;
			if (typeof code === "number") return resolvePromise({ ...out, code });
			if (error.name === "AbortError") return reject(error);
			const command = args.slice(0, 2).join(" ");
			if ((error as { killed?: boolean }).killed === true) {
				return reject(new HerdrError("timeout", `herdr ${command} did not answer within ${RUN_TIMEOUT_MS / 1000}s`));
			}
			return reject(new HerdrError("spawn_failed", `could not run herdr ${command}: ${error.message}`));
		});
	});

export function createHerdrBackend(run: HerdrRun = herdrRun, options: HerdrBackendOptions = {}) {
	const signal = options.signal;
	const enforceOwnership = options.enforceOwnership !== false;
	const tabIds = createIds("tab");
	const paneIds = createIds("block");
	const owned = { tabs: new Set<string>(), panes: new Set<string>() };

	const envelope = async (args: string[]): Promise<unknown> => (await execCommand(run, args, "envelope", signal)).result;

	/** One consistent read of tabs and panes: both lists come from the same moment. */
	async function state(): Promise<{ tabs: TabRow[]; panes: PaneRow[] }> {
		const [tabResult, paneResult] = await Promise.all([envelope(["tab", "list"]), envelope(["pane", "list"])]);
		return { tabs: rowsOf(tabResult, "tabs", "tab list").map(tabRow), panes: rowsOf(paneResult, "panes", "pane list").map(paneRow) };
	}

	const requireOwnedPane = (key: string): void => {
		if (!enforceOwnership || owned.panes.has(key)) return;
		throw new HerdrError(
			"not_owned",
			`pane ${key} was not created by this process; only panes it created can be closed or driven (pass enforceOwnership: false to relax this)`,
		);
	};

	return {
		/** Tern's inspect answer: one synthetic session holding every herdr tab, with numeric ids. */
		async inspect(): Promise<Inspect> {
			const { tabs, panes } = await state();
			const blocks = new Map<string, { id: number; title?: string; cwd?: string }[]>();
			for (const tab of tabs) blocks.set(tab.tab_id, []);
			for (const pane of panes) {
				const into = blocks.get(pane.tab_id);
				// A pane outside every listed tab has no place in an inspect tree; it stays unreachable
				// rather than being invented into a tab of its own.
				if (!into) continue;
				const block: { id: number; title?: string; cwd?: string } = { id: paneIds.idFor(pane.pane_id) };
				if (pane.title !== undefined) block.title = pane.title;
				const cwd = pane.cwd ?? pane.foreground_cwd;
				if (cwd !== undefined) block.cwd = cwd;
				into.push(block);
			}

			return {
				sessions: [
					{
						tabs: tabs.map((tab) => ({
							id: tabIds.idFor(tab.tab_id),
							name: tabDisplayName(tab.label, tab.number),
							blocks: blocks.get(tab.tab_id) ?? [],
						})),
					},
				],
			};
		},

		/** The pane tool's `list` answer: every tab with its panes, and what this process created. */
		async tabList() {
			const { tabs, panes } = await state();
			return {
				tabs: tabs.map((tab) => ({
					tab: tabIds.idFor(tab.tab_id),
					name: tabDisplayName(tab.label, tab.number),
					number: tab.number ?? null,
					workspace: tab.workspace_id ?? null,
					focused: tab.focused,
					agentCreated: owned.tabs.has(tab.tab_id),
					blocks: panes
						.filter((pane) => pane.tab_id === tab.tab_id)
						.map((pane) => ({
							block: paneIds.idFor(pane.pane_id),
							cwd: pane.cwd ?? pane.foreground_cwd ?? null,
							title: pane.title ?? null,
							focused: pane.focused,
							agentCreated: owned.panes.has(pane.pane_id),
						})),
				})),
			};
		},

		async newTab(request: { cwd?: string; label?: string } = {}) {
			if (request.cwd !== undefined && !isAbsolute(request.cwd)) {
				throw new HerdrError("invalid_argument", `cwd must be an absolute directory: ${request.cwd}`);
			}
			const label = request.label === undefined ? undefined : tabName(request.label);
			// `--no-focus` keeps the user's attention where it was: an agent's new tab must not steal it.
			const made = await envelope([
				"tab",
				"create",
				...(request.cwd ? ["--cwd", request.cwd] : []),
				...(label ? ["--label", label] : []),
				"--no-focus",
			]);
			const tabKey = createdId(made, "tab_id", "tab create");
			owned.tabs.add(tabKey);
			// The create answer carries the tab, not its pane: the tab's first pane is read back.
			const after = await state();
			const pane = after.panes.find((row) => row.tab_id === tabKey);
			if (!pane) throw new HerdrError("unexpected_result", `herdr tab create made tab ${tabKey} but no pane appeared in it`);
			owned.panes.add(pane.pane_id);
			return { tab: tabIds.idFor(tabKey), block: paneIds.idFor(pane.pane_id) };
		},

		async renameTab(id: number, name: string) {
			const key = tabIds.keyFor(id);
			if (enforceOwnership && !owned.tabs.has(key)) {
				throw new HerdrError("not_owned", `tab ${id} was not created by this process; only tabs it created can be renamed`);
			}
			// Verified positional order: TAB_ID first, then the label (`herdr tab rename <TAB_ID> <LABEL>...`).
			const label = tabName(name);
			await envelope(["tab", "rename", key, label]);
			return { tab: id, name: label };
		},

		async split(request: SplitRequest) {
			const direction = request.direction;
			if (!(DIRECTIONS as readonly string[]).includes(direction)) {
				throw new HerdrError("invalid_argument", `unknown direction: ${String(direction)}`);
			}
			// Without an anchor the split is relative to an explicit pane, never "whatever the client
			// happens to consider current": `--current` names that pane and herdr decides it.
			const anchor = request.pane === undefined ? ["--current"] : [paneIds.keyFor(request.pane)];
			const made = await envelope(["pane", "split", ...anchor, "--direction", direction, "--no-focus"]);
			const paneKey = createdId(made, "pane_id", "pane split");
			owned.panes.add(paneKey);
			return { block: paneIds.idFor(paneKey), beside: request.pane ?? null, direction };
		},

		/** Focus the pane's tab: herdr 0.9.5 has no "focus this pane" verb, only neighbour directions. */
		async focus(id: number) {
			const key = paneIds.keyFor(id);
			const { panes } = await state();
			const row = panes.find((pane) => pane.pane_id === key);
			if (!row) throw new HerdrError("unknown_block", `block ${id} (${key}) is not in any herdr tab`);
			await envelope(["tab", "focus", row.tab_id]);
			return { focused: id, tab: tabIds.idFor(row.tab_id), level: "tab" as const };
		},

		async close(id: number) {
			const key = paneIds.keyFor(id);
			requireOwnedPane(key);
			// `pane close` prints nothing on success, so the absence of an error envelope is the proof.
			await execCommand(run, ["pane", "close", key], "silent", signal);
			owned.panes.delete(key);
			paneIds.forget(id);
			return { closed: id };
		},

		async send(id: number, text: string, sendOptions: { enter?: boolean } = {}) {
			const key = paneIds.keyFor(id);
			requireOwnedPane(key);
			const body = sendable(text);
			const enter = sendOptions.enter !== false;
			// `pane run` types the text and presses Enter in one call; without Enter the literal write is
			// `send-text`. Both print nothing on success.
			await execCommand(run, enter ? ["pane", "run", key, body] : ["pane", "send-text", key, body], "silent", signal);
			return { sent: id, chars: body.length, enter };
		},

		async read(id: number, readOptions: ReadOptions = {}) {
			const key = paneIds.keyFor(id);
			const lines = clamp(readOptions.lines ?? DEFAULT_LINES, 1, MAX_LINES);
			if (readOptions.until === undefined) {
				const { text } = await execCommand(run, ["pane", "read", "--lines", String(lines), key], "text", signal);
				return { block: id, text };
			}

			if (readOptions.until === "") throw new HerdrError("invalid_argument", "until is required");
			// wait-output polls forever without --timeout, so the bound is always sent, in milliseconds.
			const budgetMs = clamp(readOptions.timeout ?? DEFAULT_WAIT_SECONDS, 1, MAX_WAIT_SECONDS) * 1000;
			try {
				const result = await envelope(["pane", "wait-output", "--match", readOptions.until, "--lines", String(lines), "--timeout", String(budgetMs), key]);
				return { block: id, matched: true, text: readText(result) };
			} catch (error) {
				// A wait that ran out of budget means the text never appeared: answer that, and let every
				// other refusal (a dead server above all) through unchanged.
				if (error instanceof HerdrError && isTimeoutCode(error.code)) return { block: id, matched: false };
				throw error;
			}
		},

		/** Whether a server is running, from the server block of `herdr status`. Never starts one. */
		async status() {
			try {
				const { text } = await execCommand(run, ["status"], "text", signal);
				return { running: herdrServerRunning(text), raw: text };
			} catch (error) {
				if (error instanceof HerdrError && error.code === "server_not_running") return { running: false, raw: error.message };
				throw error;
			}
		},
	};
}

export type HerdrBackend = ReturnType<typeof createHerdrBackend>;
