// Real git facts for the composer's git segment, from `git status --porcelain=v1 -b` in Pi's cwd.
import { execFile } from "node:child_process";
import type { GitFacts } from "./composer-view.ts";

export function parseGitStatus(out: string): GitFacts | undefined {
	const lines = out.split("\n").filter(Boolean);
	if (lines.length === 0 || !lines[0].startsWith("## ")) return undefined;
	const head = lines[0].slice(3);
	let branch: string | undefined;
	const initial = /^No commits yet on (.+)$/.exec(head);
	if (initial) branch = initial[1];
	else if (!head.startsWith("HEAD (no branch)")) branch = head.split("...")[0].split(" ")[0] || undefined;
	const facts: GitFacts = { branch, staged: 0, unstaged: 0, untracked: 0 };
	for (const line of lines.slice(1)) {
		const x = line[0];
		const y = line[1];
		if (x === "?" && y === "?") facts.untracked++;
		else {
			if (x && x !== " ") facts.staged++;
			if (y && y !== " ") facts.unstaged++;
		}
	}
	return facts;
}

export function readGitFacts(cwd: string): Promise<GitFacts | undefined> {
	return new Promise((resolve) => {
		execFile("git", ["status", "--porcelain=v1", "-b"], { cwd, timeout: 5000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
			resolve(error ? undefined : parseGitStatus(stdout));
		});
	});
}
