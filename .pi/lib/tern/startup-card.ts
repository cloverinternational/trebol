// Tern startup card: the Trebol shamrock on the left (an SVG blob, faded in), the directory's git state on the right.
// The blob is sent once when the bridge starts; the node list only references it by SHA-256 id.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, watch, type FSWatcher } from "node:fs";
import type { ArtifactBlob } from "./artifact-previews.ts";
import { readGitSnapshot, type GitEntry, type GitSection, type GitSnapshot, type GitStat } from "./git-status.ts";
import type { McpStatus } from "../tools/mcp-status.ts";
import type { TspNode } from "./tsp.ts";

const SVG_BYTES = readFileSync(new URL("./assets/trebol-shamrock.svg", import.meta.url));
const PACKAGE_JSON = new URL("../../../package.json", import.meta.url);

// Fade-in only; the rest of the card is static text, badges and tables.
export const STARTUP_CSS = `
[data-role='pi.startup.mark'] { animation: pi-startup-in 0.9s ease-out both; }
@keyframes pi-startup-in {
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: none; }
}
@media (prefers-reduced-motion: reduce) {
  [data-role='pi.startup.mark'] { animation: none; }
}
`;

export interface CommitRow { hash: string; subject: string; when: string }

export type RepoStatus =
	| { cwd: string; git: false }
	| { cwd: string; git: true; root: string; gitDir?: string; worktrees: number; commits: CommitRow[]; snapshot: GitSnapshot };

export interface GitFileRef { section: GitSection; entry: GitEntry }

export function trebolVersion(): string {
	const version = JSON.parse(readFileSync(PACKAGE_JSON, "utf8")).version;
	return typeof version === "string" ? version : "unknown";
}

export function startupBlob(): ArtifactBlob {
	return {
		id: createHash("sha256").update(SVG_BYTES).digest("hex"),
		mime: "image/svg+xml",
		base64: SVG_BYTES.toString("base64"),
	};
}

function git(cwd: string, args: string[]): Promise<string | undefined> {
	return new Promise((resolve) => {
		execFile("git", ["--no-optional-locks", ...args], { cwd, timeout: 5000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => resolve(error ? undefined : stdout));
	});
}

export async function readRepoStatus(cwd: string): Promise<RepoStatus> {
	const [snapshot, log, top, gitDir, worktrees] = await Promise.all([
		readGitSnapshot(cwd),
		git(cwd, ["log", "-3", "--format=%h%x1f%s%x1f%cr"]),
		git(cwd, ["rev-parse", "--show-toplevel"]),
		git(cwd, ["rev-parse", "--absolute-git-dir"]),
		git(cwd, ["worktree", "list", "--porcelain"]),
	]);
	if (!snapshot) return { cwd, git: false };
	const commits = (log ?? "").split("\n").filter(Boolean).map((line) => {
		const [hash = "", subject = "", when = ""] = line.split("\x1f");
		return { hash, subject, when };
	});
	return {
		cwd,
		git: true,
		root: top?.trim() || cwd,
		gitDir: gitDir?.trim() || undefined,
		worktrees: (worktrees ?? "").split("\n").filter((line) => line.startsWith("worktree ")).length,
		commits,
		snapshot,
	};
}

// Debounced watch on the worktree and the git directory. Lock files, objects and node_modules are ignored.
// Returns a disposer; nothing polls.
export function watchRepo(root: string, gitDir: string | undefined, onChange: () => void): () => void {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const fire = () => {
		clearTimeout(timer);
		timer = setTimeout(onChange, 400);
	};
	const watchers: FSWatcher[] = [];
	const onWorktree = (name: string | null) => !name || !(name === ".git" || name.startsWith(".git/") || name.includes("node_modules/"));
	const onGitDir = (name: string | null) => !name || !(name.endsWith(".lock") || name.startsWith("objects/"));
	try {
		watchers.push(watch(root, { recursive: true }, (_event, name) => { if (onWorktree(name)) fire(); }));
	} catch { /* root is not watchable; the card keeps its last state */ }
	if (gitDir) {
		try {
			watchers.push(watch(gitDir, { recursive: true }, (_event, name) => { if (onGitDir(name)) fire(); }));
		} catch { /* same */ }
	}
	return () => {
		clearTimeout(timer);
		for (const w of watchers) w.close();
	};
}

// git reports symlink-resolved roots (macOS /var -> /private/var), so compare real paths.
function sameDirectory(a: string, b: string): boolean {
	try { return realpathSync(a) === realpathSync(b); } catch { return a === b; }
}

function counts(snapshot: GitSnapshot) {
	return {
		conflicts: snapshot.entries.filter((e) => e.conflict).length,
		changed: snapshot.entries.filter((e) => !e.untracked && !e.conflict).length,
		untracked: snapshot.entries.filter((e) => e.untracked).length,
	};
}

function headerRow(repo: Extract<RepoStatus, { git: true }>): TspNode {
	const { snapshot } = repo;
	const c = counts(snapshot);
	const badges: TspNode[] = [
		{ id: "tern-startup-branch", k: "badge", p: { text: snapshot.detached ? `detached at ${snapshot.oid.slice(0, 7)}` : snapshot.branch, tone: snapshot.detached ? "warning" : "accent", role: "pi.startup.branch" } },
	];
	let state: { text: string; tone: string };
	if (c.conflicts) state = { text: `${c.conflicts} conflicts`, tone: "error" };
	else if (c.changed + c.untracked === 0) state = { text: "clean", tone: "success" };
	else state = { text: [c.changed ? `${c.changed} changed` : "", c.untracked ? `${c.untracked} untracked` : ""].filter(Boolean).join(" · "), tone: "warning" };
	badges.push({ id: "tern-startup-state", k: "badge", p: { text: state.text, tone: state.tone, role: "pi.startup.state", actions: { click: "git.open" }, title: "Open git status" } });
	if (snapshot.ahead !== undefined && (snapshot.ahead || snapshot.behind)) {
		badges.push({ id: "tern-startup-sync", k: "badge", p: { text: `↑${snapshot.ahead} ↓${snapshot.behind}`, tone: "info", role: "pi.startup.sync" } });
	}
	return { id: "tern-startup-header", k: "row", p: { role: "pi.startup.header", gap: "sm", wrap: true }, c: badges };
}

function commitsTable(repo: Extract<RepoStatus, { git: true }>): TspNode {
	const rows = repo.commits.map((c, i) => ({
		id: `commit-${i}`,
		cells: { hash: [{ t: c.hash, s: "accent" }], subject: [{ t: c.subject }], when: [{ t: c.when, s: "dim" }] },
	}));
	return {
		id: "tern-startup-commits-table",
		k: "table",
		p: {
			role: "pi.startup.commits",
			grow: 1,
			min: { w: "40ch" },
			cols: [
				{ id: "hash", head: "Commit", priority: 1 },
				{ id: "subject", head: "Subject", grow: 1, truncate: "end", priority: 3 },
				{ id: "when", head: "When", align: "end", priority: 2 },
			],
			rows,
		},
	};
}

// Undefined status means unavailable (no MCP state published); an empty list means none connected.
function mcpNode(mcp: McpStatus | undefined): TspNode {
	if (!mcp) return { id: "tern-startup-mcp", k: "text", p: { role: "pi.startup.mcp", text: "MCP status unavailable", tone: "muted" } };
	if (mcp.connected.length === 0) return { id: "tern-startup-mcp", k: "text", p: { role: "pi.startup.mcp", text: "No MCP servers connected", tone: "muted" } };
	return { id: "tern-startup-mcp", k: "text", p: { role: "pi.startup.mcp", title: "Initialized clients with no observed disconnect; HTTP status reflects the last connection observation, not continuous health checks.", spans: [{ t: "MCP connected", s: "dim" }, { t: "  " }, { t: mcp.connected.join(" · "), s: "accent" }] } };
}

function infoNodes(repo: RepoStatus | undefined, mcp: McpStatus | undefined): TspNode[] {
	if (!repo) return [{ id: "tern-startup-reading", k: "text", p: { role: "pi.startup.status", text: "Reading repository…", tone: "muted" } }];
	if (!repo.git) {
		return [
			{ id: "tern-startup-path-kv", k: "kv", p: { role: "pi.startup.path", items: [{ k: "Path", v: repo.cwd }] } },
			{ id: "tern-startup-state", k: "text", p: { role: "pi.startup.status", text: "Not a git repository", tone: "muted" } },
		];
	}
	const items: Array<{ k: string; v: string }> = [{ k: "Path", v: repo.cwd }];
	if (!sameDirectory(repo.root, repo.cwd)) items.push({ k: "Root", v: repo.root });
	if (repo.worktrees > 1) items.push({ k: "Worktrees", v: `${repo.worktrees} in this repository` });
	const commits: TspNode = repo.snapshot.noCommits
		? { id: "tern-startup-commits-empty", k: "text", p: { role: "pi.startup.status", text: "No commits yet", tone: "muted" } }
		: { id: "tern-startup-commits", k: "col", p: { role: "pi.startup.commits", gap: "xs" }, c: [
			{ id: "tern-startup-commits-label", k: "text", p: { role: "pi.startup.label", spans: [{ t: "Recent commits", s: "dim" }] } },
			commitsTable(repo),
		] };
	return [
		headerRow(repo),
		{ id: "tern-startup-path", k: "col", p: { role: "pi.startup.path", gap: "xs" }, c: [{ id: "tern-startup-path-kv", k: "kv", p: { role: "pi.startup.path", items } }] },
		commits,
		mcpNode(mcp),
	];
}

export function startupNodes(blob: ArtifactBlob, version: string, repo?: RepoStatus, mcp?: McpStatus): TspNode[] {
	return [{
		id: "tern-startup",
		k: "row",
		p: { role: "pi.startup", gap: "lg", align: "start" },
		c: [
			{
				id: "tern-startup-mark",
				k: "col",
				p: { role: "pi.startup.mark", gap: "sm", align: "center", basis: "content" },
				c: [
					{ id: "tern-startup-logo", k: "image", p: { blob: blob.id, alt: "Trebol", title: "Trebol", max: { h: "7lines" }, role: "pi.startup.logo" } },
					{ id: "tern-startup-version", k: "text", p: { role: "pi.startup.version", text: `v${version}`, tone: "muted", wrap: "none" } },
				],
			},
			{ id: "tern-startup-info", k: "col", p: { role: "pi.startup.info", gap: "md", grow: 1, min: { w: "40ch" } }, c: infoNodes(repo, mcp) },
		],
	}];
}

const SECTIONS: GitSection[] = ["conflicts", "staged", "unstaged", "untracked"];
const SECTION_LABEL: Record<GitSection, string> = { conflicts: "Conflicts", staged: "Staged", unstaged: "Unstaged", untracked: "Untracked" };
const SECTION_TONE: Record<GitSection, string> = { conflicts: "error", staged: "success", unstaged: "warning", untracked: "muted" };

// One row per (section, file), in the order the view draws them. Click values are indexes into this list.
export function gitFileRefs(snapshot: GitSnapshot): GitFileRef[] {
	return SECTIONS.flatMap((section) => snapshot.entries
		.filter((entry) => (section === "conflicts" ? entry.conflict : section === "staged" ? entry.staged : section === "unstaged" ? entry.unstaged : entry.untracked))
		.map((entry) => ({ section, entry })));
}

function codeOf({ section, entry }: GitFileRef): string {
	if (section === "conflicts") return `${entry.x}${entry.y}`;
	if (section === "untracked") return "??";
	return (section === "staged" ? entry.x : entry.y).replace(".", " ");
}

function statSpans(stat: GitStat | undefined): Array<{ t: string; s?: string }> {
	if (!stat) return [];
	if (stat.add === null || stat.del === null) return [{ t: "binary", s: "dim" }];
	return [{ t: `+${stat.add}`, s: "success" }, { t: " " }, { t: `−${stat.del}`, s: "error" }];
}

function fileRow(ref: GitFileRef, index: number): TspNode {
	const stat = ref.section === "staged" ? ref.entry.stagedStat : ref.section === "unstaged" ? ref.entry.unstagedStat : undefined;
	const movedFrom = ref.entry.from ? [{ t: `  ← ${ref.entry.from}`, s: "dim" }] : [];
	return {
		id: `git-file-${index}`,
		k: "row",
		p: { role: "pi.git.file", gap: "sm", align: "center", title: ref.entry.path, actions: { click: `git.file=${index}` } },
		c: [
			{ id: `git-file-${index}-code`, k: "text", p: { role: "pi.git.code", tone: SECTION_TONE[ref.section], spans: [{ t: codeOf(ref), s: SECTION_TONE[ref.section] }], wrap: "none" } },
			{ id: `git-file-${index}-path`, k: "text", p: { role: "pi.git.path", grow: 1, min: { w: "20ch" }, truncate: "middle", spans: [{ t: ref.entry.path, s: "path" }, ...movedFrom] } },
			{ id: `git-file-${index}-stat`, k: "text", p: { role: "pi.git.stat", spans: statSpans(stat), wrap: "none" } },
		],
	};
}

// The status overlay: summary, sections of files, one click per file to its diff.
export function gitStatusNodes(repo: Extract<RepoStatus, { git: true }>, refs: GitFileRef[]): TspNode {
	const { snapshot } = repo;
	const branch = snapshot.detached ? `detached at ${snapshot.oid.slice(0, 7)}` : snapshot.branch;
	const upstream = snapshot.upstream ? ` → ${snapshot.upstream}` : "";
	const sync = snapshot.ahead !== undefined ? ` · ↑${snapshot.ahead} ↓${snapshot.behind}` : "";
	const body: TspNode[] = [{ id: "git-summary", k: "text", p: { role: "pi.git.summary", spans: [{ t: `${branch}${upstream}${sync}`, s: "strong" }] } }];
	if (refs.length === 0) body.push({ id: "git-clean", k: "text", p: { role: "pi.git.empty", text: "Working tree clean", tone: "muted" } });
	for (const section of SECTIONS) {
		const rows = refs.map((ref, i) => ({ ref, i })).filter(({ ref }) => ref.section === section);
		if (rows.length === 0) continue;
		body.push({ id: `git-section-${section}`, k: "col", p: { role: "pi.git.section", gap: "xs" }, c: [
			{ id: `git-section-${section}-label`, k: "text", p: { role: "pi.git.label", spans: [{ t: `${SECTION_LABEL[section]} (${rows.length})`, s: SECTION_TONE[section] }] } },
			...rows.map(({ ref, i }) => fileRow(ref, i)),
		] });
	}
	body.push({ id: "git-hint", k: "text", p: { role: "pi.git.hint", spans: [{ t: "Click a file for its diff · ", s: "dim" }, { t: "Close", s: "accent" }, { t: " · Esc", s: "dim" }], actions: { click: "git.close" } } });
	return { id: "git-status", k: "overlay", p: { head: "Git status", role: "pi.git.overlay" }, c: [{ id: "git-status-body", k: "col", p: { gap: "sm" }, c: body }] };
}

// A transparent full-layer node under the git overlay: a click outside the card sends git.close.
export function gitDismissNode(): TspNode {
	return { id: "git-dismiss", k: "text", p: { role: "pi.git.dismiss", text: "", grow: 1, min: { w: "100%", h: "100%" }, actions: { click: "git.close" } } };
}

export function gitDiffNodes(ref: GitFileRef, text: string): TspNode {
	return {
		id: "git-status", k: "overlay",
		p: { head: `${SECTION_LABEL[ref.section]} · ${ref.entry.path}`, role: "pi.git.overlay" },
		c: [{ id: "git-status-body", k: "col", p: { gap: "sm" }, c: [
			{ id: "git-back", k: "text", p: { role: "pi.git.back", spans: [{ t: "← Back to status", s: "accent" }], actions: { click: "git.back" } } },
			{ id: "git-diff", k: "diff", p: { text, path: ref.entry.path, mode: "unified" } },
		] }],
	};
}
