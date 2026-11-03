import { describe, expect, it } from "vitest";
import { gitPanelNodes, type GitPanelState } from "../../lib/tern/git-panel.ts";
import type { GitEntry } from "../../lib/tern/git-status.ts";
import type { RepoStatus } from "../../lib/tern/startup-card.ts";
import type { TspNode } from "../../lib/tern/tsp.ts";

function entry(path: string, x: string, y: string, extra: Partial<GitEntry> = {}): GitEntry {
	return { path, x, y, conflict: false, untracked: false, staged: false, unstaged: false, ...extra };
}

function repo(entries: GitEntry[]): Extract<RepoStatus, { git: true }> {
	return {
		cwd: "/repo",
		git: true,
		root: "/repo",
		worktrees: 1,
		commits: [],
		snapshot: { branch: "main", oid: "abc1234", detached: false, noCommits: false, entries },
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

function spansOf(node: TspNode | undefined): Array<{ t: string; s?: string }> {
	return ((node?.p as { spans?: Array<{ t: string; s?: string }> } | undefined)?.spans) ?? [];
}

const textOf = (node: TspNode | undefined): string => spansOf(node).map((span) => span.t).join("");

describe("git panel pending-change totals", () => {
	it("sums distinct files and line counts, counting a staged-then-edited file once", () => {
		const nodes = gitPanelNodes(repo([
			entry("a.ts", "M", "M", { staged: true, unstaged: true, stagedStat: { add: 3, del: 1 }, unstagedStat: { add: 2, del: 2 } }),
			entry("b.bin", "M", ".", { staged: true, stagedStat: { add: null, del: null } }),
			entry("new.txt", "?", "?", { untracked: true }),
		]), state());
		const title = find(nodes, "git-side-title");
		// 4 rows, 3 distinct paths: a.ts appears once per section.
		expect(textOf(title)).toBe("4 changes on main · 3 files · +5 −3");
		expect(spansOf(title)).toContainEqual({ t: "+5", s: "success" });
		expect(spansOf(title)).toContainEqual({ t: "−3", s: "error" });
	});

	it("says one file and omits line counts when no row has a stat", () => {
		expect(textOf(find(gitPanelNodes(repo([entry("new.txt", "?", "?", { untracked: true })]), state()), "git-side-title")))
			.toBe("1 change on main · 1 file");
	});

	it("does not invent line counts for binary-only changes", () => {
		const nodes = gitPanelNodes(repo([entry("b.bin", "M", ".", { staged: true, stagedStat: { add: null, del: null } })]), state());
		expect(textOf(find(nodes, "git-side-title"))).toBe("1 change on main · 1 file");
	});
});
