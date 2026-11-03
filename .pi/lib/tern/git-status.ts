// Reads the working tree the way git reports it: `status --porcelain=v2 -z` for entries, `diff --numstat -z` for line counts.
// Every read passes --no-optional-locks, so a refresh never writes .git/index or takes index.lock.
// Writes (stage, unstage, discard, commit) are the explicit actions the git panel offers; they are the only
// functions here that may take git's locks.
import { execFile } from "node:child_process";

export type GitSection = "conflicts" | "staged" | "unstaged" | "untracked";
export type GitStat = { add: number | null; del: number | null };

export interface GitEntry {
	path: string;
	from?: string;
	x: string;
	y: string;
	conflict: boolean;
	untracked: boolean;
	staged: boolean;
	unstaged: boolean;
	stagedStat?: GitStat;
	unstagedStat?: GitStat;
}

export interface GitSnapshot {
	branch: string;
	oid: string;
	detached: boolean;
	noCommits: boolean;
	upstream?: string;
	ahead?: number;
	behind?: number;
	entries: GitEntry[];
}

/** HEAD commit shown by the panel when the working tree is clean. */
export interface HeadCommitFile {
	path: string;
	from?: string;
	kind: "added" | "deleted" | "modified" | "renamed";
	add: number | null;
	del: number | null;
}

export interface HeadCommit {
	sha: string;
	short: string;
	subject: string;
	body: string;
	author: string;
	email: string;
	date?: string;
	parents: string[];
	files: HeadCommitFile[];
}

const MAX_DIFF_CHARS = 400_000;

function run(cwd: string, args: string[], okCodes: number[] = [0]): Promise<string | undefined> {
	return new Promise((resolve) => {
		execFile("git", ["--no-optional-locks", ...args], { cwd, timeout: 10_000, maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {
			if (!error) return resolve(stdout);
			const code = (error as NodeJS.ErrnoException & { code?: number | string }).code;
			resolve(typeof code === "number" && okCodes.includes(code) ? stdout : undefined);
		});
	});
}

// Splits a porcelain line into its first n-1 space-separated fields and the rest, so paths may contain spaces.
function fields(line: string, n: number): string[] {
	const out: string[] = [];
	let rest = line;
	for (let k = 0; k < n - 1; k++) {
		const at = rest.indexOf(" ");
		out.push(rest.slice(0, at));
		rest = rest.slice(at + 1);
	}
	out.push(rest);
	return out;
}

function entry(path: string, xy: string, conflict: boolean): GitEntry {
	const x = xy[0] ?? ".";
	const y = xy[1] ?? ".";
	return { path, x, y, conflict, untracked: false, staged: !conflict && x !== ".", unstaged: !conflict && y !== "." };
}

export function parseStatusV2(out: string): GitSnapshot {
	const tokens = out.split("\0");
	let branch = "";
	let oid = "";
	let upstream: string | undefined;
	let ahead: number | undefined;
	let behind: number | undefined;
	const entries: GitEntry[] = [];
	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i];
		if (!t) continue;
		if (t.startsWith("# branch.oid ")) oid = t.slice("# branch.oid ".length);
		else if (t.startsWith("# branch.head ")) branch = t.slice("# branch.head ".length);
		else if (t.startsWith("# branch.upstream ")) upstream = t.slice("# branch.upstream ".length);
		else if (t.startsWith("# branch.ab ")) {
			const m = /^# branch\.ab \+(\d+) -(\d+)$/.exec(t);
			if (m) { ahead = Number(m[1]); behind = Number(m[2]); }
		} else if (t.startsWith("1 ")) {
			const f = fields(t, 9);
			entries.push(entry(f[8], f[1], false));
		} else if (t.startsWith("2 ")) {
			const f = fields(t, 10);
			const from = tokens[++i] ?? "";
			entries.push({ ...entry(f[9], f[1], false), from });
		} else if (t.startsWith("u ")) {
			const f = fields(t, 11);
			entries.push(entry(f[10], f[1], true));
		} else if (t.startsWith("? ")) {
			entries.push({ path: t.slice(2), x: "?", y: "?", conflict: false, untracked: true, staged: false, unstaged: false });
		}
	}
	return { branch, oid, detached: branch === "(detached)", noCommits: oid === "(initial)", upstream, ahead, behind, entries };
}

// `--numstat -z`: "added\tdeleted\tpath\0", or for a rename "added\tdeleted\t\0from\0to\0". Binary files give "-".
export function parseNumstat(out: string): Map<string, GitStat> {
	const stats = new Map<string, GitStat>();
	const tokens = out.split("\0");
	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i];
		if (!t) continue;
		const [add, del, ...rest] = t.split("\t");
		let path = rest.join("\t");
		if (path === "") {
			i += 2;
			path = tokens[i] ?? "";
		}
		stats.set(path, { add: add === "-" ? null : Number(add), del: del === "-" ? null : Number(del) });
	}
	return stats;
}

export async function readGitSnapshot(cwd: string): Promise<GitSnapshot | undefined> {
	const [status, staged, unstaged] = await Promise.all([
		run(cwd, ["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all"]),
		run(cwd, ["diff", "--cached", "--numstat", "-z"]),
		run(cwd, ["diff", "--numstat", "-z"]),
	]);
	if (status === undefined) return undefined;
	const snapshot = parseStatusV2(status);
	const stagedStats = parseNumstat(staged ?? "");
	const unstagedStats = parseNumstat(unstaged ?? "");
	for (const e of snapshot.entries) {
		if (e.staged) e.stagedStat = stagedStats.get(e.path);
		if (e.unstaged) e.unstagedStat = unstagedStats.get(e.path);
	}
	return snapshot;
}

function headKind(code: string): HeadCommitFile["kind"] {
	const letter = code[0];
	if (letter === "A") return "added";
	if (letter === "D") return "deleted";
	if (letter === "R" || letter === "C") return "renamed";
	return "modified";
}

/** `git show --numstat --format= --no-renames HEAD`: "12\t3\tsrc/a.ts". */
export function parseHeadNumstat(out: string): Map<string, { add: number | null; del: number | null }> {
	const stats = new Map<string, { add: number | null; del: number | null }>();
	for (const line of out.split("\n")) {
		if (!line) continue;
		const [add, del, ...rest] = line.split("\t");
		const path = rest.join("\t");
		if (!path) continue;
		stats.set(path, { add: add === "-" ? null : Number(add), del: del === "-" ? null : Number(del) });
	}
	return stats;
}

/** `git diff-tree --no-commit-id --name-status -r --no-renames HEAD`: "M\tsrc/a.ts". */
export function parseHeadNames(out: string): Map<string, HeadCommitFile["kind"]> {
	const kinds = new Map<string, HeadCommitFile["kind"]>();
	for (const line of out.split("\n")) {
		if (!line) continue;
		const [code = "", ...rest] = line.split("\t");
		// A rename/copy carries two paths; the destination is the one the commit added.
		const path = (code.startsWith("R") || code.startsWith("C")) && rest.length >= 2 ? rest[rest.length - 1]! : rest.join("\t");
		if (path) kinds.set(path, headKind(code));
	}
	return kinds;
}

/** The HEAD commit, its author and the files it changed (when the panel's clean view needs them). */
export async function readHeadCommit(cwd: string): Promise<HeadCommit | undefined> {
	const format = "%H%x1f%h%x1f%s%x1f%b%x1f%an%x1f%ae%x1f%aI%x1f%P";
	const [log, names, numstat] = await Promise.all([
		run(cwd, ["log", "-1", `--format=${format}`]),
		// `--root` makes a repository's first commit list its files; without it diff-tree prints nothing.
		run(cwd, ["diff-tree", "--root", "--no-commit-id", "--name-status", "-r", "--no-renames", "HEAD"]),
		run(cwd, ["show", "--numstat", "--format=", "--no-renames", "HEAD"]),
	]);
	if (!log?.trim()) return undefined;
	const [sha = "", short = "", subject = "", body = "", author = "", email = "", date = "", parents = ""] = log.replace(/\n$/, "").split("\x1f");
	const kinds = parseHeadNames(names ?? "");
	const stats = parseHeadNumstat(numstat ?? "");
	const files = [...kinds].map(([path, kind]) => {
		const stat = stats.get(path);
		return { path, kind, add: stat?.add ?? null, del: stat?.del ?? null };
	});
	for (const [path, stat] of stats) {
		if (!kinds.has(path)) files.push({ path, kind: "modified", add: stat.add, del: stat.del });
	}
	return {
		sha,
		short,
		subject,
		body,
		author,
		email,
		date: date || undefined,
		parents: parents.split(" ").filter(Boolean),
		files,
	};
}

// One file's diff in the section it is listed under. Untracked files diff against /dev/null (exit 1 means "differs").
export async function readFileDiff(cwd: string, entry: GitEntry, section: GitSection): Promise<string> {
	const out = section === "untracked"
		? await run(cwd, ["diff", "--no-index", "--no-color", "--no-ext-diff", "--", "/dev/null", entry.path], [0, 1])
		: await run(cwd, ["diff", ...(section === "staged" ? ["--cached"] : []), "--no-color", "--no-ext-diff", "--", entry.path]);
	if (out === undefined) return "Diff unavailable.";
	return out.length > MAX_DIFF_CHARS ? `${out.slice(0, MAX_DIFF_CHARS)}\n… diff truncated` : out;
}

/**
 * The HEAD commit's patch for one path. Used by the panel's clean view, where the sidebar lists the files of
 * HEAD rather than working-tree changes.
 */
export async function readCommitDiff(cwd: string, path: string): Promise<string> {
	const out = await run(cwd, ["show", "--format=", "--no-color", "--no-ext-diff", "--no-renames", "HEAD", "--", path]);
	if (out === undefined) return "Diff unavailable.";
	return out.length > MAX_DIFF_CHARS ? `${out.slice(0, MAX_DIFF_CHARS)}\n… diff truncated` : out;
}

function gitWrite(cwd: string, args: string[]): Promise<string | undefined> {
	return new Promise((resolve) => {
		execFile("git", args, { cwd, timeout: 20_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
			if (!error) return resolve(undefined);
			const message = `${stderr ?? ""}`.trim() || error.message;
			resolve(message);
		});
	});
}

/** Stage the paths (including deletions and untracked files); resolves to git's error text, if any. */
export function stagePaths(cwd: string, paths: readonly string[]): Promise<string | undefined> {
	return gitWrite(cwd, ["add", "-A", "--", ...paths]);
}

/** Unstage the paths, including on an unborn branch where `git restore --staged` has no HEAD to read. */
export async function unstagePaths(cwd: string, paths: readonly string[]): Promise<string | undefined> {
	const restored = await gitWrite(cwd, ["restore", "--staged", "--", ...paths]);
	if (restored === undefined) return undefined;
	// No commits yet: `git restore --staged` complains about HEAD; remove the index entries instead.
	return gitWrite(cwd, ["rm", "--cached", "-r", "--quiet", "--", ...paths]);
}

/** Throw away a path's changes: index and worktree for staged files, worktree for unstaged, the file for untracked. */
export async function discardPaths(cwd: string, entries: readonly Pick<GitEntry, "path" | "untracked" | "staged">[]): Promise<string | undefined> {
	const untracked = entries.filter((entry) => entry.untracked).map((entry) => entry.path);
	const staged = entries.filter((entry) => !entry.untracked && entry.staged).map((entry) => entry.path);
	const unstaged = entries.filter((entry) => !entry.untracked && !entry.staged).map((entry) => entry.path);
	if (untracked.length) {
		const error = await gitWrite(cwd, ["clean", "-f", "--", ...untracked]);
		if (error !== undefined) return error;
	}
	if (staged.length) {
		const error = await gitWrite(cwd, ["restore", "--staged", "--worktree", "--", ...staged]);
		if (error !== undefined) return error;
	}
	if (unstaged.length) {
		const error = await gitWrite(cwd, ["restore", "--worktree", "--", ...unstaged]);
		if (error !== undefined) return error;
	}
	return undefined;
}

/** Commit the index. `stageAll` stages the whole worktree first (the panel's "Stage all & commit"). */
export async function commitIndex(cwd: string, message: string, options: { amend?: boolean; stageAll?: boolean } = {}): Promise<string | undefined> {
	if (options.stageAll) {
		const staged = await gitWrite(cwd, ["add", "-A"]);
		if (staged !== undefined) return staged;
	}
	return gitWrite(cwd, ["commit", ...(options.amend ? ["--amend"] : []), "-m", message]);
}
