// Reads the working tree the way git reports it: `status --porcelain=v2 -z` for entries, `diff --numstat -z` for line counts.
// Every read passes --no-optional-locks, so a refresh never writes .git/index or takes index.lock.
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

// One file's diff in the section it is listed under. Untracked files diff against /dev/null (exit 1 means "differs").
export async function readFileDiff(cwd: string, entry: GitEntry, section: GitSection): Promise<string> {
	const out = section === "untracked"
		? await run(cwd, ["diff", "--no-index", "--no-color", "--no-ext-diff", "--", "/dev/null", entry.path], [0, 1])
		: await run(cwd, ["diff", ...(section === "staged" ? ["--cached"] : []), "--no-color", "--no-ext-diff", "--", entry.path]);
	if (out === undefined) return "Diff unavailable.";
	return out.length > MAX_DIFF_CHARS ? `${out.slice(0, MAX_DIFF_CHARS)}\n… diff truncated` : out;
}
