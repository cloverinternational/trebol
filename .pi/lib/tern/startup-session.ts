// Which session a Tern pane's Pi runner opens when it starts.
//
// Resuming is deliberately narrow: only after the machine itself went down. A pane closed on
// purpose, ctrl-c, /new or a Tern-only restart all mean the user is done with that conversation, and
// bringing it back would be the pane arguing with them. A reboot is the one case where the
// conversation was lost by the machine rather than by the user, so the record carries the boot it
// was written in and a start on a later boot is the only start that reopens it.
//
// Records are keyed by Tern's pane id — persisted in the daemon state, so a restored pane keeps its
// id — and carry the owner pid, because the one thing worse than losing a transcript is two runners
// appending to it: a session a live runner still owns is never opened twice. PI_TERN_FRESH=1 (or
// PI_TERN_RESUME=0) always starts a new session.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface PaneSessionRecord {
	sessionFile: string;
	pid: number;
	cwd: string;
	updatedAt: number;
	/** Boot the record was written in, see bootGeneration. */
	boot: number;
}

/** Pane id → the session that pane's runner had open when it last wrote a record. */
export type PaneSessionBook = Record<string, PaneSessionRecord>;

/** How long a record of a dead runner stays useful for resuming a pane after a reboot. */
export const PANE_RECORD_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Identifies the current boot, rounded to the minute so a system clock step cannot split one boot in
 * two. Two starts on the same boot agree; after a reboot this changes, which is what allows a resume.
 */
export function bootGeneration(now: number, uptimeSeconds: number): number {
	const bootedAt = now - Math.max(0, uptimeSeconds) * 1000;
	return Math.round(bootedAt / 60_000);
}

/** Tern's pane id, when the runner is in a pane that reports one. */
export function paneKey(env: Record<string, string | undefined>): string | undefined {
	const pane = env.TERN_PANE?.trim();
	return pane ? pane : undefined;
}

/**
 * Parses a record book, keeping only complete records. A truncated or hand-edited file must resume
 * nothing rather than point at half a path.
 */
export function parsePaneBook(text: string | undefined): PaneSessionBook {
	if (!text) return {};
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return {};
	}
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
	const book: PaneSessionBook = {};
	for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
		if (typeof value !== "object" || value === null) continue;
		const record = value as Record<string, unknown>;
		if (typeof record.sessionFile !== "string" || record.sessionFile === "") continue;
		if (typeof record.pid !== "number" || !Number.isInteger(record.pid) || record.pid <= 0) continue;
		// A record without a boot generation cannot tell a reboot from a deliberate exit, and a resume
		// the user did not ask for is the worse failure: drop it.
		if (typeof record.boot !== "number" || !Number.isInteger(record.boot)) continue;
		book[key] = {
			sessionFile: record.sessionFile,
			pid: record.pid,
			cwd: typeof record.cwd === "string" ? record.cwd : "",
			updatedAt: typeof record.updatedAt === "number" && Number.isFinite(record.updatedAt) ? record.updatedAt : 0,
			boot: record.boot,
		};
	}
	return book;
}

export interface StartupInput {
	/** The user asked for a new conversation (PI_TERN_FRESH=1 or PI_TERN_RESUME=0). */
	fresh: boolean;
	key: string | undefined;
	book: PaneSessionBook;
	selfPid: number;
	/** Whether a session file is still on disk. */
	exists: (sessionFile: string) => boolean;
	/** Whether a pid is a live process on this machine. */
	alive: (pid: number) => boolean;
	/** The boot this start runs in (bootGeneration). */
	boot: number;
}

export type StartupDecision =
	| { kind: "open"; path: string }
	| { kind: "new"; reason: "fresh" | "same-boot" | "owner-alive" | "missing" | "no-candidate" };

/**
 * Picks the session this start should open. A pane reopens its conversation only when the record was
 * written on an earlier boot and nobody still owns it; everything else starts a new conversation.
 */
export function chooseStartupSession(input: StartupInput): StartupDecision {
	if (input.fresh) return { kind: "new", reason: "fresh" };
	const pane = input.key ? input.book[input.key] : undefined;
	// Same boot means the pane outlived its program: the user closed it, or is starting over.
	if (pane && pane.boot === input.boot) return { kind: "new", reason: "same-boot" };
	// A session a live runner owns is never opened twice: two writers would interleave one JSONL.
	// This is the detached-window case, where the old pane is still running somewhere.
	const ownedElsewhere = (sessionFile: string): boolean =>
		Object.values(input.book).some(
			(record) => record.sessionFile === sessionFile && record.pid !== input.selfPid && input.alive(record.pid),
		);
	if (!pane) return { kind: "new", reason: "no-candidate" };
	if (ownedElsewhere(pane.sessionFile)) return { kind: "new", reason: "owner-alive" };
	// Pi removes a session that never held a message, so a record can outlive its file.
	if (!input.exists(pane.sessionFile)) return { kind: "new", reason: "missing" };
	return { kind: "open", path: pane.sessionFile };
}

/** Whether a pid is a live process here. EPERM means it exists but belongs to another user. */
export function pidAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

export function readPaneBook(path: string): PaneSessionBook {
	try {
		return parsePaneBook(readFileSync(path, "utf8"));
	} catch {
		// No book yet, or unreadable: a start from nothing is the safe reading.
		return {};
	}
}

/** The parts of Pi's SessionManager the startup decision needs, so a test can drive the same path. */
export interface SessionOpener<T> {
	open(path: string): T;
	create(cwd: string): T;
	continueRecent(cwd: string): { getSessionFile(): string | undefined };
}

/**
 * Opens the session this start should use: the decision above, then the file. An unreadable or
 * vanished session starts fresh instead of failing to launch the pane.
 */
export function openStartupSession<T>(
	input: StartupInput & { sessionManager: SessionOpener<T>; cwd: string },
): T {
	const decision = chooseStartupSession(input);
	if (decision.kind === "open") {
		try {
			return input.sessionManager.open(decision.path);
		} catch {
			// Fall through: a pane with a broken resume point must still open.
		}
	}
	return input.sessionManager.create(input.cwd);
}

/**
 * Records that this pane's runner owns `record.sessionFile`. Atomic and owner-only: the file names
 * private conversations, and a torn write must leave the previous book intact. Records of dead
 * runners older than the TTL are dropped on the way.
 */
export function recordPaneSession(
	path: string,
	key: string,
	record: PaneSessionRecord,
	alive: (pid: number) => boolean = pidAlive,
): void {
	const book = readPaneBook(path);
	book[key] = record;
	for (const [other, entry] of Object.entries(book)) {
		if (other === key || entry.pid === record.pid) continue;
		if (!alive(entry.pid) && record.updatedAt - entry.updatedAt > PANE_RECORD_TTL_MS) delete book[other];
	}
	writeBook(path, book);
}

/**
 * Forgets a pane's session, so no later start — not even one after a reboot — reopens it. Written when
 * the pane starts over (/new) or when the session has not been persisted yet.
 */
export function clearPaneRecord(path: string, key: string): boolean {
	const book = readPaneBook(path);
	if (!(key in book)) return false;
	delete book[key];
	writeBook(path, book);
	return true;
}

function writeBook(path: string, book: PaneSessionBook): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = `${path}.${process.pid}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(book, null, 2)}\n`, { mode: 0o600 });
	renameSync(temporary, path);
}
