/** Code identity of the Claw supervisor process.
 *
 *  The daemon must outlive the Pi session, but it must not outlive its own code. After `/reload`, a branch switch or a
 *  merge, a daemon started from the previous sources keeps running the old behaviour while the extension around it is
 *  already new; that is exactly how merged Claw fixes stayed "not running" behind a stale PID. Every daemon stamps the
 *  fingerprint it was started from in `daemon.lock`, and a stamp that differs from the code on disk means the live
 *  process is stale: it is stopped so the next call spawns a daemon from the current sources.
 *
 *  A fingerprint is the HEAD commit of the checkout that holds this library (`git rev-parse HEAD`, or `nogit` when the
 *  tree is not a git checkout) plus a sha256 over every `*.ts` file in the Claw library, relative path and bytes
 *  included. The commit catches branch and merge changes; the source hash catches uncommitted edits to the same tree.
 *  Only the daemon of the same workspace store is affected: the lock is per workspace. */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const FINGERPRINT_VERSION = 1;
/** A code fingerprint never contains a secret: a commit id and a digest of sources already in this repository. */
export type ClawFingerprint = {
	version: typeof FINGERPRINT_VERSION;
	/** HEAD commit of the checkout holding the Claw library; null when it is not a git checkout. */
	head: string | null;
	/** sha256 over the library sources, so uncommitted edits change it too. */
	sources: string;
	/** The single value written to the lock and compared later. */
	key: string;
};
/** current: the daemon runs this code. stale: it runs other code. unstamped: it cannot say what it runs (a daemon
 *  older than this check, or a malformed lock). unknown: this code cannot be fingerprinted, so nothing may be decided. */
export type FingerprintState = "current" | "stale" | "unstamped" | "unknown";
export type FingerprintComparison = { state: FingerprintState; detail: string; stamped?: string; current?: string };

const SKIP = new Set(["node_modules", "dist", ".git"]);

function sourceFiles(dir: string, base = dir): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (SKIP.has(entry.name)) continue;
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...sourceFiles(full, base));
		else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(relative(base, full));
	}
	return out.sort();
}

/** sha256 over every source file, path and bytes, in sorted path order. Deterministic across platforms and machines. */
export function sourcesHash(dir: string): string {
	const hash = createHash("sha256");
	for (const rel of sourceFiles(dir)) {
		const bytes = readFileSync(join(dir, rel));
		hash.update(rel.split(sep).join("/"));
		hash.update("\0");
		hash.update(String(bytes.length));
		hash.update("\0");
		hash.update(bytes);
		hash.update("\n");
	}
	return hash.digest("hex");
}

/** `git rev-parse HEAD` for the checkout holding `dir`; null when that is not possible (no git, not a work tree). */
export function gitHead(dir: string): string | null {
	try {
		const out = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] }).trim();
		return /^[0-9a-f]{7,64}$/i.test(out) ? out : null;
	} catch { return null; }
}

/** The directory that holds the Claw library the running process actually loaded. */
export const clawCodeDir = (): string => fileURLToPath(new URL(".", import.meta.url));

export function fingerprintKey(input: { head: string | null; sources: string }): string {
	return `${FINGERPRINT_VERSION}:${input.head ?? "nogit"}:${input.sources}`;
}

/** Undefined when the sources cannot be read: an unreadable tree must never be reported as a code change. */
export function computeClawFingerprint(options: { codeDir?: string; head?: (dir: string) => string | null } = {}): ClawFingerprint | undefined {
	const dir = options.codeDir ?? clawCodeDir();
	try {
		const sources = sourcesHash(dir);
		const head = (options.head ?? gitHead)(dir);
		return { version: FINGERPRINT_VERSION, head, sources, key: fingerprintKey({ head, sources }) };
	} catch { return undefined; }
}

/** Judges a lock's stamp against the code on disk. Pure: the caller decides what to do with the state. */
export function compareFingerprint(stamped: unknown, currentKey: string | undefined): FingerprintComparison {
	if (!currentKey) return { state: "unknown", detail: "the Claw code on disk cannot be fingerprinted, so a running daemon cannot be judged stale" };
	const value = typeof stamped === "string" ? stamped.trim() : "";
	if (!value) return { state: "unstamped", detail: "the running daemon does not stamp its code, so it predates this check and its code cannot be proven current", current: currentKey };
	if (value === currentKey) return { state: "current", detail: "the running daemon was started from this code", stamped: value, current: currentKey };
	return { state: "stale", detail: "the running daemon was started from different code", stamped: value, current: currentKey };
}

/** Whether a live daemon in this state must be replaced. `unknown` is deliberately not replaceable: never signal a
 *  process on a guess. `unstamped` is: a daemon that cannot name its code was built before this check existed. */
export const needsReplacement = (comparison: FingerprintComparison): boolean =>
	comparison.state === "stale" || comparison.state === "unstamped";
