import { describe, expect, it } from "vitest";
import { diffStat, gitPanelNodes, gitPanelRefs, type GitPanelState } from "../../lib/tern/git-panel.ts";
import { parseHeadNames, parseHeadNumstat, type GitEntry, type HeadCommit } from "../../lib/tern/git-status.ts";
import type { RepoStatus } from "../../lib/tern/startup-card.ts";
import type { TspNode } from "../../lib/tern/tsp.ts";

function entry(path: string, x: string, y: string, extra: Partial<GitEntry> = {}): GitEntry {
	return { path, x, y, conflict: false, untracked: false, staged: false, unstaged: false, ...extra };
}

function repo(entries: GitEntry[], head?: HeadCommit): Extract<RepoStatus, { git: true }> {
	return {
		cwd: "/repo",
		git: true,
		root: "/repo",
		worktrees: 1,
		commits: [],
		snapshot: { branch: "main", oid: "abc1234", detached: false, noCommits: false, ahead: 1, behind: 0, entries },
		head,
	};
}

function state(over: Partial<GitPanelState> = {}): GitPanelState {
	return { diffMode: "split", style: "path", collapsed: new Set(), summary: "", body: "", amend: false, ...over };
}

function find(node: TspNode, id: string): TspNode | undefined {
	if (node.id === id) return node;
	for (const child of node.c ?? []) {
		const hit = find(child, id);
		if (hit) return hit;
	}
	return undefined;
}

describe("git panel refs", () => {
	it("puts untracked and conflicted files in the unstaged sheet, as OMP's two-area sidebar does", () => {
		const refs = gitPanelRefs(repo([
			entry("a.ts", " ", "M", { unstaged: true }),
			entry("new.ts", "?", "?", { untracked: true }),
			entry("both.ts", "M", "M", { staged: true, unstaged: true }),
			entry("conflict.ts", "U", "U", { conflict: true }),
		]));
		expect(refs.map((ref) => `${ref.section}|${ref.kind}|${ref.entry.path}`)).toEqual([
			"unstaged|modified|a.ts",
			"unstaged|untracked|new.ts",
			"staged|modified|both.ts",
			"unstaged|modified|both.ts",
			"unstaged|conflicted|conflict.ts",
		]);
	});

	it("lists the HEAD commit's files when the tree is clean", () => {
		const head: HeadCommit = {
			sha: "abc", short: "abc", subject: "one", body: "", author: "A", email: "a@example.com", parents: [],
			files: [{ path: "src/a.ts", kind: "modified", add: 2, del: 1 }],
		};
		const refs = gitPanelRefs(repo([], head));
		expect(refs).toHaveLength(1);
		expect(refs[0]).toMatchObject({ section: "commit", stat: { add: 2, del: 1 }, kind: "modified" });
	});
});

describe("git panel nodes", () => {
	it("is a full sheet with OMP's bar, diff, changes sheet and commit composer", () => {
		const entries = [
			entry("src/a.ts", " ", "M", { unstaged: true, unstagedStat: { add: 3, del: 1 } }),
			entry("b.ts", "M", " ", { staged: true, stagedStat: { add: 1, del: 0 } }),
		];
		const refs = gitPanelRefs(repo(entries));
		const node = gitPanelNodes(repo(entries), state({
			selected: refs[0],
			diffText: "@@ -1 +1 @@\n-old\n+new\n",
			summary: "feat: panel",
		}));
		expect(node.k).toBe("overlay");
		expect(node.p).toMatchObject({ size: "full", modal: true, role: "pi.git.overlay" });
		expect(find(node, "git-bar")?.k).toBe("row");
		expect(find(node, "git-bar-path")?.p?.spans).toEqual([{ t: "src/", s: "dim" }, { t: "a.ts" }]);
		expect(find(node, "git-bar-stat")?.p?.spans).toEqual([{ t: "+3", s: "success" }, { t: " −1", s: "error" }]);
		expect(find(node, "git-bar-scope")?.p).toMatchObject({ text: "Unstaged", tone: "warning" });
		expect(find(node, "git-diff-mode")?.p).toMatchObject({ active: "split" });
		expect(find(node, "git-diff")?.p).toMatchObject({ mode: "split", path: "src/a.ts" });
		expect(find(node, "git-side-title")?.p?.spans?.[0]).toEqual({ t: "2 changes", s: "strong" });
		expect(find(node, "git-section-unstaged-head")).toBeDefined();
		expect(find(node, "git-section-staged-head")).toBeDefined();
		expect(find(node, "git-summary-text")?.p?.spans).toEqual([{ t: "feat: panel" }]);
		expect(find(node, "git-commit-button")?.p).toMatchObject({ text: "Commit", tone: "accent" });
	});

	it("renders the clean tree as the HEAD commit view OMP shows", () => {
		const head: HeadCommit = {
			sha: "abcdef1", short: "abcdef1", subject: "fix: thing", body: "details", author: "Ada Lovelace",
			email: "ada@example.com", date: "2026-01-02T03:04:05Z", parents: ["0123456789abcdef"],
			files: [{ path: "a.ts", kind: "added", add: 4, del: 0 }],
		};
		const clean = repo([], head);
		const refs = gitPanelRefs(clean);
		const node = gitPanelNodes(clean, state({ selected: refs[0], diffText: "@@ -0,0 +1 @@\n+x\n" }));
		expect(find(node, "git-head-subject")?.p?.text).toBe("fix: thing");
		expect(find(node, "git-head-author-n")?.p?.text).toBe("Ada Lovelace");
		expect(find(node, "git-head-files-count")?.p?.spans?.[0]).toEqual({ t: "1 file", s: "strong" });
		expect(find(node, "git-file-0")?.p?.label).toEqual([{ t: "A", s: "success" }, { t: " " }, { t: "a.ts" }]);
		expect(find(node, "git-commit")).toBeUndefined();
	});

	it("stacks the sheet under the diff in a narrow pane and keeps both widths honest", () => {
		const entries = [entry("a.ts", " ", "M", { unstaged: true })];
		const refs = gitPanelRefs(repo(entries));
		const wide = gitPanelNodes(repo(entries), state({ selected: refs[0] }), 120);
		const narrow = gitPanelNodes(repo(entries), state({ selected: refs[0] }), 80);
		expect(find(wide, "git-app")?.k).toBe("row");
		expect(find(narrow, "git-app")?.k).toBe("col");
		expect(find(wide, "git-side")?.p).toMatchObject({ basis: "content", min: { w: "34ch" }, max: { w: "54ch" } });
	});
});

describe("git panel facts", () => {
	it("counts only diff lines, not file headers", () => {
		expect(diffStat("--- a\n+++ b\n@@ -1 +1,2 @@\n-old\n+new\n+more\n context\n")).toEqual({ add: 2, del: 1 });
	});

	it("parses HEAD numstat and name-status output", () => {
		expect([...parseHeadNumstat("2\t1\tsrc/a.ts\n-\t-\tlogo.png\n")]).toEqual([
			["src/a.ts", { add: 2, del: 1 }],
			["logo.png", { add: null, del: null }],
		]);
		expect([...parseHeadNames("M\tsrc/a.ts\nA\tnew.ts\nD\told.ts\nR100\tbefore.ts\tnow.ts\n")]).toEqual([
			["src/a.ts", "modified"],
			["new.ts", "added"],
			["old.ts", "deleted"],
			["now.ts", "renamed"],
		]);
	});
});
