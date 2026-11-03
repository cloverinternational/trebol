import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gitPanelRefs } from "../../lib/tern/git-panel.ts";
import { commitIndex, discardPaths, readHeadCommit, stagePaths, unstagePaths } from "../../lib/tern/git-status.ts";
import { readRepoStatus } from "../../lib/tern/startup-card.ts";

let root: string;

function git(...args: string[]): string {
	return execFileSync("git", args, { cwd: root, stdio: "pipe" }).toString();
}

function write(path: string, text: string): void {
	writeFileSync(join(root, path), text);
}

function status(): string {
	return git("status", "--porcelain=v1");
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "trebol-git-panel-"));
	git("init", "-q", "-b", "main");
	git("config", "user.email", "t@example.com");
	git("config", "user.name", "Tester");
	write("a.ts", "one\n");
	git("add", "a.ts");
	git("commit", "-qm", "feat: base");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("git panel against real git", () => {
	it("reads the first commit's files, where diff-tree needs --root", async () => {
		const head = await readHeadCommit(root);
		expect(head?.subject).toBe("feat: base");
		expect(head?.files).toEqual([{ path: "a.ts", kind: "added", add: 1, del: 0 }]);
	});

	it("lists a path in both areas when it has staged and unstaged edits", async () => {
		write("a.ts", "one\nstaged\n");
		git("add", "a.ts");
		write("a.ts", "one\nstaged\nworktree\n");
		write("new.ts", "new\n");
		const repo = await readRepoStatus(root);
		expect(repo.git).toBe(true);
		if (!repo.git) return;
		const refs = gitPanelRefs(repo);
		expect(refs.filter((ref) => ref.entry.path === "a.ts").map((ref) => ref.section)).toEqual(["staged", "unstaged"]);
		expect(refs.find((ref) => ref.entry.path === "new.ts")).toMatchObject({ section: "unstaged", kind: "untracked" });
	});

	it("stages, unstages and discards through git, with git status as the oracle", async () => {
		write("a.ts", "one\nworktree\n");
		write("new.ts", "new\n");
		expect(status()).toContain(" M a.ts");
		expect(await stagePaths(root, ["a.ts", "new.ts"])).toBeUndefined();
		expect(status()).toContain("M  a.ts");
		expect(status()).toContain("A  new.ts");
		expect(await unstagePaths(root, ["a.ts"])).toBeUndefined();
		expect(status()).toContain(" M a.ts");
		const repo = await readRepoStatus(root);
		if (!repo.git) throw new Error("not a repo");
		const refs = gitPanelRefs(repo);
		const unstaged = refs.find((ref) => ref.section === "unstaged" && ref.entry.path === "a.ts");
		if (!unstaged) throw new Error("no unstaged a.ts");
		expect(await discardPaths(root, [unstaged.entry])).toBeUndefined();
		// new.ts is still staged; a.ts is back to HEAD and leaves the status list.
		expect(status()).not.toContain("a.ts");
		expect(git("diff", "--", "a.ts")).toBe("");
	});

	it("commits the index, stages everything when asked, and reads the resulting HEAD", async () => {
		write("a.ts", "one\nworktree\n");
		write("new.ts", "new\n");
		expect(await commitIndex(root, "feat: panel", { stageAll: true })).toBeUndefined();
		expect(status()).toBe("");
		const head = await readHeadCommit(root);
		expect(head?.subject).toBe("feat: panel");
		expect(head?.files.map((file) => `${file.kind}:${file.path}`).sort()).toEqual(["added:new.ts", "modified:a.ts"]);
		const repo = await readRepoStatus(root);
		if (!repo.git) throw new Error("not a repo");
		expect(gitPanelRefs(repo).map((ref) => ref.section)).toEqual(Array(2).fill("commit"));
	});

	it("amends the previous commit", async () => {
		git("commit", "--amend", "-qm", "feat: base");
		write("a.ts", "one\nmore\n");
		expect(await commitIndex(root, "feat: amended", { amend: true, stageAll: true })).toBeUndefined();
		expect(git("log", "-1", "--format=%s").trim()).toBe("feat: amended");
	});
});
