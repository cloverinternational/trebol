// The Tern git panel, following OMP's native git app (packages/tui/src/apps/git, v18.12.6) rather than its
// ANSI TUI: one bar (path, ±stats, scope, change navigation, view tabs, stage/discard, close), a diff body,
// and the changes sheet on the right with the commit composer. Tern draws and clocks it; this module only
// describes the data and the actions.
//
// Honest limits: Tern's `diff` has unified and split modes only, so OMP's File/Inline/Hunks views have no
// node here; a diff cannot expose per-hunk buttons or line selection; binary/media compare and AI staging
// would need sources this bridge does not have. Those are omitted rather than faked.
import type { GitEntry, GitSection, GitSnapshot, GitStat, HeadCommit } from "./git-status.ts";
import type { RepoStatus } from "./startup-card.ts";
import type { TspNode } from "./tsp.ts";

export type GitPanelSection = GitSection | "commit";
export type GitDiffMode = "unified" | "split";
export type GitSidebarStyle = "path" | "tree";

// OMP's git app is an opaque fullscreen surface. Tern's overlay card is glass, so without this the startup
// card and the composer show through; the dock is also hidden while the panel is open (`bridge.#render`).
export const PI_GIT_CSS = `
[data-role='pi.git.overlay'] .sf-ov-card,
[data-role='pi.git.overlay'] .sf-ov-body {
  background: var(--fog, var(--page));
  background-image: none;
  backdrop-filter: none;
}
[data-role='omp.app.git'], [data-role='omp.app.git-narrow'] {
  background: var(--fog, var(--page));
  min-height: 100%;
}
`;

export interface GitPanelRef {
	section: GitPanelSection;
	entry: GitEntry;
	stat?: GitStat;
	kind?: string;
}

export interface GitPanelState {
	selected?: GitPanelRef;
	diffText?: string;
	diffMode: GitDiffMode;
	style: GitSidebarStyle;
	collapsed: ReadonlySet<string>;
	status?: { text: string; tone: string };
	summary: string;
	body: string;
	amend: boolean;
	focus?: "summary" | "body";
	busy?: boolean;
}

const SECTION_LABEL: Record<GitPanelSection, string> = {
	conflicts: "Conflicts",
	staged: "Staged",
	unstaged: "Unstaged",
	untracked: "Untracked",
	commit: "Committed",
};
const SECTION_TONE: Record<GitPanelSection, string> = {
	conflicts: "error",
	staged: "success",
	unstaged: "warning",
	untracked: "muted",
	commit: "accent",
};
const KIND_LETTER: Record<string, string> = { added: "A", deleted: "D", modified: "M", renamed: "R", untracked: "?", conflicted: "U" };
const KIND_TONE: Record<string, string> = { added: "success", deleted: "error", modified: "warning", renamed: "accent", untracked: "muted", conflicted: "error" };
const SUMMARY_LIMIT = 72;

function commitEntry(path: string): GitEntry {
	return { path, x: " ", y: " ", conflict: false, untracked: false, staged: false, unstaged: false };
}

/** One list row per (section, file), in the order the panel draws them. Click values are indexes into this list. */
export function gitPanelRefs(repo: Extract<RepoStatus, { git: true }>): GitPanelRef[] {
	if (repo.snapshot.entries.length === 0 && repo.head) return headRefs(repo.head);
	// OMP's sidebar has two areas, unstaged and staged; untracked and conflicted files live in unstaged.
	const refs: GitPanelRef[] = [];
	for (const entry of repo.snapshot.entries) {
		const kind = entry.conflict
			? "conflicted"
			: entry.untracked
				? "untracked"
				: entry.x === "A" || entry.y === "A"
					? "added"
					: entry.x === "D" || entry.y === "D"
						? "deleted"
						: entry.x === "R" || entry.y === "R"
							? "renamed"
							: "modified";
		// A path can be in both areas (a staged edit plus a later unstaged edit); OMP lists it twice.
		if (entry.staged) refs.push({ section: "staged", entry, stat: entry.stagedStat, kind });
		if (entry.unstaged || entry.untracked || entry.conflict) refs.push({ section: "unstaged", entry, stat: entry.unstagedStat, kind });
	}
	return refs;
}

function headRefs(head: HeadCommit): GitPanelRef[] {
	return head.files.map((file) => ({
		section: "commit" as const,
		entry: commitEntry(file.path),
		stat: { add: file.add, del: file.del },
		kind: file.kind,
	}));
}

function codeOf(ref: GitPanelRef): string {
	if (ref.section === "commit") return KIND_LETTER[ref.kind ?? "modified"] ?? "M";
	if (ref.kind === "untracked") return "??";
	if (ref.kind === "conflicted") return `${ref.entry.x}${ref.entry.y}`;
	return (ref.section === "staged" ? ref.entry.x : ref.entry.y).replace(".", " ");
}

function statSpans(stat: GitStat | undefined): Array<{ t: string; s?: string }> {
	if (!stat) return [];
	if (stat.add === null || stat.del === null) return [{ t: "binary", s: "dim" }];
	const spans: Array<{ t: string; s?: string }> = [];
	if (stat.add) spans.push({ t: `+${stat.add}`, s: "success" });
	if (stat.del) spans.push({ t: `${spans.length ? " " : ""}−${stat.del}`, s: "error" });
	return spans;
}

function pathSpans(path: string): Array<{ t: string; s?: string }> {
	const slash = path.lastIndexOf("/");
	return slash < 0 ? [{ t: path }] : [{ t: path.slice(0, slash + 1), s: "dim" }, { t: path.slice(slash + 1) }];
}

/** Additions and deletions in a unified diff, ignoring file headers. */
export function diffStat(text: string): { add: number; del: number } {
	let add = 0;
	let del = 0;
	for (const line of text.split("\n")) {
		if (line.startsWith("+++") || line.startsWith("---")) continue;
		if (line.startsWith("+")) add++;
		else if (line.startsWith("-")) del++;
	}
	return { add, del };
}

function scopeBadge(ref: GitPanelRef | undefined, repo: Extract<RepoStatus, { git: true }>): { text: string; tone: string } {
	if (!ref) return { text: repo.snapshot.detached ? `detached ${repo.snapshot.oid.slice(0, 7)}` : repo.snapshot.branch, tone: "accent" };
	if (ref.section === "commit") return { text: repo.head?.short ?? "commit", tone: "accent" };
	if (ref.section === "staged") return { text: "Staged", tone: "success" };
	return { text: ref.kind === "untracked" ? "Untracked" : SECTION_LABEL[ref.section], tone: SECTION_TONE[ref.section] };
}

function actionButton(id: string, label: string, act: string, tone?: string, title?: string): TspNode {
	return {
		id,
		k: "text",
		p: {
			role: "omp.app.git.tool",
			spans: [{ t: label, ...(tone ? { s: tone } : {}) }],
			wrap: "none",
			actions: { click: act },
			...(title ? { title } : {}),
		},
	};
}

function bar(repo: Extract<RepoStatus, { git: true }>, view: GitPanelState): TspNode {
	const ref = view.selected;
	const left: TspNode[] = [];
	if (ref) {
		const stat = ref.stat ?? (view.diffText ? diffStat(view.diffText) : undefined);
		left.push({
			id: "git-bar-path",
			k: "text",
			p: {
				role: "omp.app.git.path",
				spans: pathSpans(ref.entry.path),
				truncate: "start",
				title: ref.entry.from ? `${ref.entry.from} → ${ref.entry.path}` : ref.entry.path,
			},
		});
		if (stat) left.push({ id: "git-bar-stat", k: "text", p: { role: "omp.app.git.stat", spans: statSpans(stat), wrap: "none" } });
		const scope = scopeBadge(ref, repo);
		left.push({ id: "git-bar-scope", k: "badge", p: { text: scope.text, tone: scope.tone, role: "omp.app.git.scope" } });
	} else {
		left.push({ id: "git-bar-path", k: "text", p: { role: "omp.app.git.path", text: repo.snapshot.detached ? `detached ${repo.snapshot.oid.slice(0, 7)}` : repo.snapshot.branch, tone: "muted" } });
	}
	const canStage = ref !== undefined && ref.section !== "commit" && ref.section !== "conflicts";
	const right: TspNode[] = [
		actionButton("git-bar-prev", "‹", "git.prev", "muted", "Previous change ([)"),
		actionButton("git-bar-next", "›", "git.next", "muted", "Next change (])"),
		{
			id: "git-diff-mode",
			k: "tabs",
			p: {
				role: "omp.app.seg",
				items: [
					{ id: "unified", label: "Unified" },
					{ id: "split", label: "Split" },
				],
				active: view.diffMode,
			},
		},
	];
	if (canStage) {
		right.push(
			actionButton(
				"git-bar-stage",
				ref.section === "staged" ? "Unstage file" : "Stage file",
				ref.section === "staged" ? "git.unstage" : "git.stage",
				undefined,
				`${ref.section === "staged" ? "Unstage" : "Stage"} ${ref.entry.path}`,
			),
		);
		right.push(actionButton("git-bar-discard", "Discard", "git.discard", "error", `Discard changes to ${ref.entry.path}`));
	}
	right.push(actionButton("git-bar-help", "?", "git.help", "muted", "Keyboard shortcuts"));
	right.push(actionButton("git-bar-close", "✕", "git.close", "muted", "Close (Esc)"));
	return {
		id: "git-bar",
		k: "row",
		p: { role: "omp.app.git.bar", justify: "between", align: "center", gap: "sm", wrap: true },
		c: [
			{ id: "git-bar-where", k: "row", p: { role: "omp.app.git.where", gap: "sm", align: "center" }, c: left },
			{ id: "git-bar-tools", k: "row", p: { role: "omp.app.git.tools", gap: "sm", align: "center" }, c: right },
		],
	};
}

function emptyBody(repo: Extract<RepoStatus, { git: true }>, view: GitPanelState): TspNode {
	const clean = repo.snapshot.entries.length === 0;
	return {
		id: "git-body-empty",
		k: "col",
		p: { role: "omp.app.git.empty", gap: "xs", grow: 1, min: { h: "12lines" } },
		c: [
			{ id: "git-body-empty-title", k: "text", p: { text: clean ? "No changes" : "No file selected", wrap: "word" } },
			{ id: "git-body-empty-hint", k: "text", p: { text: clean ? (repo.head ? `Working tree clean — showing committed ${repo.head.short}` : "The working tree is clean.") : "Pick a file on the right to see its changes.", tone: "muted", wrap: "word" } },
			...(view.status ? [{ id: "git-body-empty-status", k: "text", p: { text: view.status.text, tone: view.status.tone, wrap: "word" } }] : []),
		],
	};
}

function body(repo: Extract<RepoStatus, { git: true }>, view: GitPanelState): TspNode {
	if (!view.selected) return emptyBody(repo, view);
	if (!view.diffText) {
		return {
			id: "git-body-loading",
			k: "row",
			p: { role: "omp.app.git.state", gap: "sm", align: "center", grow: 1, min: { h: "12lines" } },
			c: [
				{ id: "git-body-spinner", k: "spinner", p: { style: "dots" } },
				{ id: "git-body-loading-text", k: "text", p: { text: `Loading ${view.selected.entry.path}…`, tone: "muted" } },
			],
		};
	}
	return {
		id: "git-diff",
		k: "diff",
		p: {
			role: "omp.app.git.diff",
			text: view.diffText,
			path: view.selected.entry.path,
			mode: view.diffMode,
			grow: 1,
			min: { h: "12lines" },
		},
	};
}

function itemLabel(ref: GitPanelRef): Array<{ t: string; s?: string }> {
	const tone = KIND_TONE[ref.kind ?? "modified"] ?? "muted";
	return [{ t: codeOf(ref), s: tone }, { t: " " }, ...pathSpans(ref.entry.path)];
}

function fileItem(ref: GitPanelRef, index: number, depth: number): TspNode {
	const tone = KIND_TONE[ref.kind ?? "modified"] ?? "muted";
	const base = ref.entry.path.slice(ref.entry.path.lastIndexOf("/") + 1);
	const spans = depth > 0
		? [{ t: codeOf(ref), s: tone }, { t: " " }, { t: `${"  ".repeat(depth)}${base}` }]
		: itemLabel(ref);
	return {
		id: `git-file-${index}`,
		k: "item",
		p: {
			label: spans,
			...(depth > 0 ? { detail: [{ t: ref.entry.path.slice(0, ref.entry.path.lastIndexOf("/") + 1), s: "dim" }] } : {}),
			...(ref.entry.from ? { detail: [{ t: `from ${ref.entry.from}`, s: "dim" }] } : {}),
			value: statSpans(ref.stat),
			role: "omp.app.git.file",
			title: `${ref.kind ?? SECTION_LABEL[ref.section]}: ${ref.entry.path}`,
			actions: { click: `git.file=${index}` },
		},
	};
}

interface TreeRow {
	depth: number;
	name: string;
	path: string;
	ref?: GitPanelRef;
	index?: number;
}

function treeRows(items: readonly { ref: GitPanelRef; index: number }[], collapsed: ReadonlySet<string>, area: string): TreeRow[] {
	const rows: TreeRow[] = [];
	const walk = (prefixes: string[], current: readonly { ref: GitPanelRef; index: number }[]) => {
		const dirs = new Map<string, { ref: GitPanelRef; index: number }[]>();
		const files: { ref: GitPanelRef; index: number }[] = [];
		for (const item of current) {
			const rel = prefixes.length ? item.ref.entry.path.slice(prefixes.join("/").length + 1) : item.ref.entry.path;
			const slash = rel.indexOf("/");
			if (slash < 0) files.push(item);
			else {
				const dir = rel.slice(0, slash);
				const list = dirs.get(dir) ?? [];
				list.push(item);
				dirs.set(dir, list);
			}
		}
		for (const [dir, children] of dirs) {
			const path = [...prefixes, dir].join("/");
			const key = `${area}:${path}`;
			rows.push({ depth: prefixes.length, name: dir, path: key });
			if (!collapsed.has(key)) walk([...prefixes, dir], children);
		}
		for (const item of files) rows.push({ depth: prefixes.length, name: item.ref.entry.path.slice(item.ref.entry.path.lastIndexOf("/") + 1), path: item.ref.entry.path, ref: item.ref, index: item.index });
	};
	walk([], items);
	return rows;
}

function sectionList(
	area: "unstaged" | "staged",
	refs: readonly GitPanelRef[],
	view: GitPanelState,
	selected: string | undefined,
): TspNode {
	const indexed = refs.map((ref, index) => ({ ref, index })).filter(({ ref }) => ref.section === area);
	const folded = view.collapsed.has(`section:${area}`);
	const items: TspNode[] = [];
	if (view.style === "tree") {
		for (const row of treeRows(indexed.map(({ ref, index }) => ({ ref, index })), view.collapsed, area)) {
			if (row.ref) items.push(fileItem(row.ref, row.index!, row.depth));
			else {
				const key = row.path;
				items.push({
					id: `git-dir-${area}-${key}`,
					k: "item",
					p: {
						label: [{ t: `${"  ".repeat(row.depth)}${view.collapsed.has(key) ? "▸" : "▾"} `, s: "muted" }, { t: `${row.name}/`, s: "dim" }],
						role: "omp.app.git.dir",
						actions: { click: `git.toggle=${key}` },
					},
				});
			}
		}
	} else {
		for (const { ref, index } of indexed) items.push(fileItem(ref, index, 0));
	}
	return {
		id: `git-list-${area}`,
		k: "list",
		p: {
			role: "omp.app.git.files",
			empty: area === "unstaged" ? "Nothing to stage" : "Nothing staged yet",
			...(items.some((item) => item.id === selected) ? { selected } : {}),
		},
		c: folded ? [] : items,
	};
}

function sectionHead(area: GitSection, count: number, view: GitPanelState): TspNode {
	const folded = view.collapsed.has(`section:${area}`);
	const all = area === "unstaged" && view.selected?.section !== "commit";
	return {
		id: `git-section-${area}-head`,
		k: "row",
		p: { role: "omp.app.git.sechead", justify: "between", align: "center", gap: "sm" },
		c: [
			{
				id: `git-section-${area}-label`,
				k: "text",
				p: {
					role: "omp.app.git.sechead-name",
					spans: [{ t: `${folded ? "▸" : "▾"} ${SECTION_LABEL[area]}`, s: SECTION_TONE[area] }, { t: ` ${count}`, s: "dim" }],
					actions: { click: `git.fold.${area}` },
					title: folded ? "Show" : "Hide",
				},
			},
			...(count > 0 && (area === "unstaged" || area === "staged")
				? [actionButton(`git-section-${area}-all`, area === "unstaged" ? "Stage all" : "Unstage all", area === "unstaged" ? "git.stageAll" : "git.unstageAll", area === "unstaged" ? "success" : "warning")]
				: []),
		],
	};
}

function fieldText(id: string, value: string, placeholder: string, act: string, role: string): TspNode {
	return {
		id,
		k: "text",
		p: {
			role,
			spans: value ? [{ t: value }] : [{ t: placeholder, s: "dim" }],
			truncate: "end",
			actions: { click: act },
		},
	};
}

function summaryField(view: GitPanelState): TspNode {
	if (view.focus === "summary") {
		return {
			id: "git-summary",
			k: "input",
			p: {
				role: "omp.app.git.field.on",
				text: view.summary,
				cursor: view.summary.length,
				placeholder: "Summary",
				aria: "Commit summary",
			},
		};
	}
	return fieldText("git-summary-text", view.summary, "Summary", "git.focus.summary", "omp.app.git.field");
}

function bodyField(view: GitPanelState): TspNode {
	if (view.focus === "body") {
		return {
			id: "git-body-field",
			k: "editor",
			p: {
				role: "omp.app.git.body.on",
				text: view.body,
				cursor: view.body.length,
				placeholder: "Description",
				maxLines: 4,
				aria: "Commit description",
			},
		};
	}
	const first = view.body.split("\n", 1)[0] + (view.body.includes("\n") ? " …" : "");
	return fieldText("git-body-text", first, "Description", "git.focus.body", "omp.app.git.body");
}

function commitForm(repo: Extract<RepoStatus, { git: true }>, view: GitPanelState): TspNode {
	const staged = repo.snapshot.entries.filter((entry) => entry.staged).length;
	const unstaged = repo.snapshot.entries.filter((entry) => !entry.staged).length;
	const hasChanges = staged + unstaged > 0 || view.amend;
	const summary = view.summary.trim();
	const body = view.body.trim();
	const canCommit = hasChanges && !view.busy && (summary.length > 0 || body.length === 0);
	const label = view.busy ? "Committing…" : view.amend ? "Amend commit" : staged > 0 ? "Commit" : "Stage all & commit";
	const left = SUMMARY_LIMIT - view.summary.length;
	return {
		id: "git-commit",
		k: "col",
		p: { role: "omp.app.git.commit", gap: "sm" },
		c: [
			{
				id: "git-commit-summary-row",
				k: "row",
				p: { role: "omp.app.git.summary.on", gap: "sm", align: "center" },
				c: [
					...(view.focus === "summary"
						? [{ ...summaryField(view), p: { ...summaryField(view).p, grow: 1 } }]
						: [summaryField(view)]),
					{ id: "git-commit-count", k: "text", p: { role: "omp.app.git.count", text: String(left), tone: left < 0 ? "warning" : "dim", wrap: "none" } },
				],
			},
			bodyField(view),
			{
				id: "git-commit-foot",
				k: "row",
				p: { role: "omp.app.git.foot", justify: "between", align: "center", gap: "sm" },
				c: [
					{
						id: "git-commit-amend",
						k: "text",
						p: {
							role: view.amend ? "omp.app.git.toggle.set" : "omp.app.git.toggle",
							spans: [{ t: `${view.amend ? "☑" : "☐"} Amend` }],
							actions: { click: "git.amend" },
							title: "Amend the previous commit",
						},
					},
					{
						id: "git-commit-button",
						k: "text",
						p: {
							role: "omp.btn",
							tone: canCommit ? "accent" : "muted",
							text: label,
							actions: canCommit ? { click: "git.commit" } : undefined,
							title: staged > 0 ? "Commit the staged changes" : "Stage everything, then commit",
						},
					},
				],
			},
		],
	};
}

function headView(repo: Extract<RepoStatus, { git: true }>, view: GitPanelState, refs: readonly GitPanelRef[], selected: string | undefined): TspNode[] {
	const head = repo.head;
	if (!head) return [{ id: "git-head-empty", k: "text", p: { role: "omp.app.git.empty", text: "No commits yet", tone: "muted" } }];
	const initials = head.author.split(/\s+/).filter(Boolean).slice(0, 2).map((word) => word[0]!.toUpperCase()).join("");
	const additions = head.files.reduce((sum, file) => sum + (file.add ?? 0), 0);
	const deletions = head.files.reduce((sum, file) => sum + (file.del ?? 0), 0);
	const when = head.date ? new Date(head.date) : null;
	const commitInfo: TspNode = {
		id: "git-head-commit",
		k: "col",
		p: { role: "omp.app.git.commit-info", gap: "sm" },
		c: [
			{ id: "git-head-subject", k: "text", p: { role: "omp.app.git.subject", text: head.subject, wrap: "word" } },
			...(head.body.trim() ? [{ id: "git-head-body", k: "text", p: { role: "omp.app.git.message", text: head.body.trim(), tone: "muted", wrap: "word", lines: 8 } }] : []),
			{
				id: "git-head-author",
				k: "row",
				p: { role: "omp.app.git.author", gap: "sm", align: "center" },
				c: [
					{ id: "git-head-avatar", k: "badge", p: { text: initials || "?", tone: "accent", title: head.email } },
					{
						id: "git-head-author-name",
						k: "col",
						p: { gap: "none" },
						c: [
							{ id: "git-head-author-n", k: "text", p: { text: head.author, truncate: "end" } },
							{ id: "git-head-author-e", k: "text", p: { text: head.email, tone: "dim", truncate: "end" } },
						],
					},
				],
			},
			{
				id: "git-head-meta",
				k: "kv",
				p: {
					role: "omp.app.git.meta",
					layout: "grid",
					items: [
						...(when && !Number.isNaN(when.getTime()) ? [{ k: "authored", v: when.toLocaleString() }] : []),
						...(head.parents.length ? [{ k: head.parents.length === 1 ? "parent" : "parents", v: head.parents.map((sha) => sha.slice(0, 8)).join(" ") }] : []),
					],
				},
			},
			{ id: "git-head-clean", k: "text", p: { role: "omp.app.git.clean", text: `Working tree clean — showing committed ${head.short}`, tone: "success" } },
			{ id: "git-head-rule", k: "rule" },
			{
				id: "git-head-files-head",
				k: "row",
				p: { role: "omp.app.git.head", justify: "between", align: "center", gap: "sm" },
				c: [
					{
						id: "git-head-files-count",
						k: "text",
						p: {
							role: "omp.app.git.count",
							spans: [
								{ t: `${head.files.length} file${head.files.length === 1 ? "" : "s"}`, s: "strong" },
								{ t: "  " },
								{ t: `+${additions}`, s: "success" },
								{ t: " " },
								{ t: `−${deletions}`, s: "error" },
								{ t: `  ${head.short}`, s: "dim" },
							],
						},
					},
					{
						id: "git-side-style",
						k: "tabs",
						p: {
							role: "omp.app.seg",
							items: [
								{ id: "path", label: "Path" },
								{ id: "tree", label: "Tree" },
							],
							active: view.style,
						},
					},
				],
			},
			{
				id: "git-head-files",
				k: "list",
				p: { role: "omp.app.git.files", ...(selected && refs.some((_, index) => `git-file-${index}` === selected) ? { selected } : {}) },
				c: view.style === "tree"
					? treeRows(refs.map((ref, index) => ({ ref, index })), view.collapsed, "commit").flatMap((row) => {
						if (row.ref) return [fileItem(row.ref, row.index!, row.depth)];
						return [{
							id: `git-dir-commit-${row.path}`,
							k: "item",
							p: {
								label: [{ t: `${"  ".repeat(row.depth)}${view.collapsed.has(row.path) ? "▸" : "▾"} `, s: "muted" }, { t: `${row.name}/`, s: "dim" }],
								role: "omp.app.git.dir",
								actions: { click: `git.toggle=${row.path}` },
							},
						} as TspNode];
					})
					: refs.map((ref, index) => fileItem(ref, index, 0)),
			},
		],
	};
	return [commitInfo];
}

/** The whole panel: OMP's bar, diff body and changes sheet, as one full Tern sheet. */
export function gitPanelNodes(repo: Extract<RepoStatus, { git: true }>, view: GitPanelState, columns = 120): TspNode {
	const refs = gitPanelRefs(repo);
	const selected = view.selected ? refs.findIndex((ref) => ref.section === view.selected!.section && ref.entry.path === view.selected!.entry.path) : -1;
	const selectedId = selected >= 0 ? `git-file-${selected}` : undefined;
	const clean = repo.snapshot.entries.length === 0;
	const stagedCount = repo.snapshot.entries.filter((entry) => entry.staged).length;
	const unstagedCount = repo.snapshot.entries.filter((entry) => entry.unstaged || entry.untracked || entry.conflict).length;
	const narrow = columns > 0 && columns < 100;
	const side: TspNode = {
		id: "git-side",
		k: "col",
		p: narrow
			? { role: "omp.app.git.side", gap: "sm", min: { w: "100%" } }
			: { role: "omp.app.git.side", gap: "sm", basis: "content", min: { w: "34ch" }, max: { w: "54ch" } },
		c: clean
			? headView(repo, view, refs, selectedId)
			: [
					{
						id: "git-side-head",
						k: "row",
						p: { role: "omp.app.git.head", justify: "between", align: "center", gap: "sm" },
						c: [
							{
								id: "git-side-title",
								k: "text",
								p: {
									role: "omp.app.git.title",
									spans: [
										{ t: `${unstagedCount + stagedCount} change${unstagedCount + stagedCount === 1 ? "" : "s"}`, s: "strong" },
										{ t: " on " },
										{ t: repo.snapshot.detached ? `detached ${repo.snapshot.oid.slice(0, 7)}` : repo.snapshot.branch, s: "mono" },
									],
								},
							},
							{
								id: "git-side-style",
								k: "tabs",
								p: {
									role: "omp.app.seg",
									items: [
										{ id: "path", label: "Path" },
										{ id: "tree", label: "Tree" },
									],
									active: view.style,
								},
							},
						],
					},
					sectionHead("unstaged", unstagedCount, view),
					sectionList("unstaged", refs, view, selectedId),
					sectionHead("staged", stagedCount, view),
					sectionList("staged", refs, view, selectedId),
					{ id: "git-side-rule", k: "rule" },
					commitForm(repo, view),
				],
	};
	const main: TspNode = {
		id: "git-main",
		k: "col",
		p: { role: "omp.app.git.main", gap: "sm", grow: 1, ...(narrow ? {} : { min: { w: "40ch" } }) },
		c: [
			bar(repo, view),
			...(view.status ? [{ id: "git-status-line", k: "text", p: { role: "omp.app.status", text: view.status.text, tone: view.status.tone, truncate: "end" } }] : []),
			body(repo, view),
		],
	};
	const root: TspNode = {
		id: "git-app",
		k: narrow ? "col" : "row",
		p: {
			role: narrow ? "omp.app.git-narrow" : "omp.app.git",
			gap: "sm",
			align: "stretch",
			grow: 1,
			...(narrow ? {} : { justify: "start" }),
		},
		c: [main, side],
	};
	return {
		id: "git-status",
		k: "overlay",
		p: { size: "full", modal: true, role: "pi.git.overlay" },
		c: [root],
	};
}

/** A compact keyboard sheet, mirroring OMP's `?` help rather than inventing bindings Tern cannot carry. */
export function gitHelpNodes(): TspNode {
	const rows: Array<[string, string]> = [
		["j / k", "move the file selection"],
		["[ / ]", "previous / next change"],
		["v", "cycle Unified / Split"],
		["s / u", "stage / unstage the selected file"],
		["x", "discard the selected file (twice to confirm)"],
		["a", "stage everything"],
		["c", "focus the commit summary"],
		["r", "refresh"],
		["Esc", "back to the list, then close"],
	];
	return {
		id: "git-help",
		k: "overlay",
		p: { head: "Git keys", role: "pi.git.help", size: "md" },
		c: [
			{
				id: "git-help-table",
				k: "table",
				p: {
					role: "omp.app.git.help",
					cols: [
						{ id: "key", head: "Key", width: "10ch" },
						{ id: "what", head: "Action", grow: 1 },
					],
					rows: rows.map(([key, what], index) => ({ id: `help-${index}`, cells: { key: [{ t: key, s: "accent" }], what: [{ t: what }] } })),
				},
			},
		],
	};
}
