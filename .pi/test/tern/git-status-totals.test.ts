import { describe, expect, it } from "vitest";
import { gitFileRefs, gitStatusNodes, type RepoStatus } from "../../lib/tern/startup-card.ts";
import type { GitEntry, GitSnapshot } from "../../lib/tern/git-status.ts";
import type { TspNode } from "../../lib/tern/tsp.ts";

function file(path: string, xy: string, extra: Partial<GitEntry> = {}): GitEntry {
	const x = xy[0] ?? ".";
	const y = xy[1] ?? ".";
	const untracked = x === "?";
	return { path, x, y, conflict: false, untracked, staged: !untracked && x !== ".", unstaged: !untracked && y !== ".", ...extra };
}

function overlay(entries: GitEntry[], snapshot: Partial<GitSnapshot> = {}): TspNode {
	const full: GitSnapshot = { branch: "main", oid: "abc1234", detached: false, noCommits: false, entries, ...snapshot };
	const repo = {
		cwd: "/repo", git: true, root: "/repo", worktrees: 1, commits: [], snapshot: full,
	} as unknown as Extract<RepoStatus, { git: true }>;
	return gitStatusNodes(repo, gitFileRefs(full));
}

function find(root: TspNode, id: string): TspNode | undefined {
	if (root.id === id) return root;
	for (const node of root.c ?? []) {
		if (node.id === id) return node;
		const hit = find(node, id);
		if (hit) return hit;
	}
	return undefined;
}

function spansOf(node: TspNode | undefined): Array<{ t: string; s?: string }> {
	return ((node?.p as { spans?: Array<{ t: string; s?: string }> } | undefined)?.spans) ?? [];
}

function textOf(node: TspNode | undefined): string {
	return spansOf(node).map((span) => span.t).join("");
}

describe("git status overlay totals", () => {
	it("sums files and line counts in the summary, counting a staged-then-edited file once", () => {
		const nodes = overlay([
			file("a.ts", "MM", { stagedStat: { add: 3, del: 1 }, unstagedStat: { add: 2, del: 2 } }),
			file("b.bin", "M.", { stagedStat: { add: null, del: null } }),
			file("new.txt", "??"),
		], { upstream: "origin/main", ahead: 1, behind: 2 });
		const summary = find(nodes, "git-summary");
		expect(textOf(summary)).toBe("main → origin/main · ↑1 ↓2 · 3 files · +5 −3");
		expect(spansOf(summary)).toContainEqual({ t: "+5", s: "success" });
		expect(spansOf(summary)).toContainEqual({ t: "−3", s: "error" });
	});

	it("says one file and omits line counts when no row has a stat", () => {
		expect(textOf(find(overlay([file("new.txt", "??")]), "git-summary"))).toBe("main · 1 file");
	});

	it("does not invent line counts for binary-only changes", () => {
		const nodes = overlay([file("b.bin", "M.", { stagedStat: { add: null, del: null } })]);
		expect(textOf(find(nodes, "git-summary"))).toBe("main · 1 file");
	});

	it("keeps the branch line alone for a clean tree", () => {
		const nodes = overlay([]);
		expect(textOf(find(nodes, "git-summary"))).toBe("main");
		expect(find(nodes, "git-clean")).toBeDefined();
	});
});
