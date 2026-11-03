import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PiTernBridge, type PiSessionLike } from "../../lib/tern/bridge.ts";
import { commitIndex, discardPaths, readCommitDiff, readFileDiff, stagePaths, unstagePaths, type GitEntry, type HeadCommit } from "../../lib/tern/git-status.ts";
import { readRepoStatus, watchRepo } from "../../lib/tern/startup-card.ts";
import { ESC, parseTspMessages } from "../../lib/tern/tsp.ts";

vi.mock("../../lib/tern/git-status.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../lib/tern/git-status.ts")>()),
	readFileDiff: vi.fn(),
	readCommitDiff: vi.fn(),
	stagePaths: vi.fn(),
	unstagePaths: vi.fn(),
	discardPaths: vi.fn(),
	commitIndex: vi.fn(),
}));

vi.mock("../../lib/tern/startup-card.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../lib/tern/startup-card.ts")>()),
	readRepoStatus: vi.fn(),
	watchRepo: vi.fn(() => () => {}),
}));

function entry(path: string, x: string, y: string, extra: Partial<GitEntry> = {}): GitEntry {
	return { path, x, y, conflict: false, untracked: false, staged: false, unstaged: false, ...extra };
}

function repo(entries: GitEntry[], head?: HeadCommit) {
	return {
		cwd: "/repo", git: true as const, root: "/repo", worktrees: 1, commits: [],
		snapshot: { branch: "main", oid: "abc1234", detached: false, noCommits: false, entries },
		head,
	};
}

function session(): PiSessionLike {
	return {
		sessionManager: { getCwd: () => "/repo" },
		subscribe: () => () => {},
		prompt: async () => {},
		abort: async () => {},
		dispose() {},
	} as unknown as PiSessionLike;
}

interface Open { bridge: PiTernBridge; nodes: () => Map<string, { parent?: string; node: { id: string; k: string; p?: Record<string, unknown>; c?: unknown[] } }> }

function openBridge(): Open {
	const writes: string[] = [];
	const bridge = new PiTernBridge(session(), { write: (d: string) => writes.push(d), surfaceId: "pi", credits: 1000 });
	bridge.start("pi");
	const nodes = () => {
		const map = new Map<string, { parent?: string; node: { id: string; k: string; p?: Record<string, unknown>; c?: unknown[] } }>();
		const drop = (id: string) => { for (const [child, item] of map) if (item.parent === id) drop(child); map.delete(id); };
		const put = (parent: string, node: { id: string; k: string; p?: Record<string, unknown>; c?: unknown[] }) => {
			map.set(node.id, { parent, node });
			for (const child of (node.c ?? []) as Array<{ id: string; k: string; p?: Record<string, unknown>; c?: unknown[] }>) put(node.id, child);
		};
		for (const write of writes) {
			for (const message of parseTspMessages(write)) {
				if (message.verb !== "f") continue;
				for (const op of (message.body.ops ?? []) as unknown[][]) {
					if (op[0] === "add" && op[4]) put(String(op[2]), op[4] as never);
					else if (op[0] === "set" && map.has(String(op[1]))) Object.assign(map.get(String(op[1]))!.node.p ??= {}, op[2]);
					else if (op[0] === "del") drop(String(op[1]));
				}
			}
		}
		return map;
	};
	return { bridge, nodes };
}

function action(act: string, value?: string) {
	return { verb: "e", body: { ev: "action", sf: "pi", act, ...(value !== undefined ? { value } : {}) } };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

beforeEach(() => {
	vi.mocked(readRepoStatus).mockResolvedValue(repo([
		entry("src/a.ts", " ", "M", { unstaged: true, unstagedStat: { add: 2, del: 1 } }),
		entry("b.ts", "M", " ", { staged: true, stagedStat: { add: 1, del: 0 } }),
	]) as never);
	vi.mocked(watchRepo).mockImplementation(() => () => {});
	vi.mocked(readFileDiff).mockImplementation(async (_cwd, e) => `@@ -1 +1 @@\n-old\n+new ${e.path}\n`);
	vi.mocked(readCommitDiff).mockResolvedValue("@@ -1 +1 @@\n-old\n+new\n");
	vi.mocked(stagePaths).mockResolvedValue(undefined);
	vi.mocked(unstagePaths).mockResolvedValue(undefined);
	vi.mocked(discardPaths).mockResolvedValue(undefined);
	vi.mocked(commitIndex).mockResolvedValue(undefined);
});

afterEach(() => vi.clearAllMocks());

describe("git panel actions", () => {
	it("opens OMP's sheet with the first change selected and a live diff", async () => {
		const { bridge, nodes } = openBridge();
		await flush();
		bridge.handle(action("git.open"));
		await flush();
		const map = nodes();
		expect(map.get("git-status")?.node.p).toMatchObject({ size: "full", modal: true });
		expect(map.get("git-diff")?.node.p).toMatchObject({ path: "src/a.ts", mode: "split" });
		expect(map.get("git-file-0")?.node.p?.actions).toEqual({ click: "git.file=0" });
	});

	it("changes the diff mode from the native tabs", async () => {
		const { bridge, nodes } = openBridge();
		await flush();
		bridge.handle(action("git.open"));
		await flush();
		bridge.handle({ verb: "e", body: { ev: "select", sf: "pi", id: "git-diff-mode", item: "unified" } });
		await flush();
		expect(nodes().get("git-diff")?.node.p?.mode).toBe("unified");
	});

	it("stages the selected file through git and reports it", async () => {
		const { bridge, nodes } = openBridge();
		await flush();
		bridge.handle(action("git.open"));
		await flush();
		bridge.handle(action("git.stage"));
		await flush();
		expect(stagePaths).toHaveBeenCalledWith("/repo", ["src/a.ts"]);
		expect(nodes().get("git-status-line")?.node.p).toMatchObject({ text: "Staged src/a.ts", tone: "success" });
	});

	it("unstage all uses every staged path", async () => {
		const { bridge, nodes } = openBridge();
		await flush();
		bridge.handle(action("git.open"));
		await flush();
		bridge.handle(action("git.unstageAll"));
		await flush();
		expect(unstagePaths).toHaveBeenCalledWith("/repo", ["b.ts"]);
		expect(nodes().get("git-status-line")?.node.p).toMatchObject({ text: "Unstaged all changes" });
	});

	it("discards only after the second click, keyed on the selected file", async () => {
		const { bridge, nodes } = openBridge();
		await flush();
		bridge.handle(action("git.open"));
		await flush();
		bridge.handle(action("git.discard"));
		await flush();
		expect(discardPaths).not.toHaveBeenCalled();
		expect(nodes().get("git-status-line")?.node.p).toMatchObject({ tone: "warning" });
		bridge.handle(action("git.discard"));
		await flush();
		expect(discardPaths).toHaveBeenCalledWith("/repo", [expect.objectContaining({ path: "src/a.ts" })]);
	});

	it("writes the commit summary through Tern's native editor and commits", async () => {
		const { bridge } = openBridge();
		await flush();
		bridge.handle(action("git.open"));
		await flush();
		bridge.handle(action("git.focus.summary"));
		await flush();
		bridge.handle({ verb: "e", body: { ev: "edit", sf: "pi", id: "git-summary", from: 0, to: 0, text: "feat: panel", cursor: 11, len: 0 } });
		await flush();
		bridge.handle(action("git.commit"));
		await flush();
		expect(commitIndex).toHaveBeenCalledWith("/repo", "feat: panel", { amend: false, stageAll: false });
	});

	it("types into the focused commit field from pty keys, as a real Tern pane sends them", async () => {
		const { bridge, nodes } = openBridge();
		await flush();
		bridge.handle(action("git.open"));
		await flush();
		bridge.handle(action("git.focus.summary"));
		await flush();
		for (const text of ["f", "i", "x", ":", " ", "p"]) expect(bridge.applyGitKey({ kind: "text", text })).toBe(true);
		expect(nodes().get("git-summary")?.node.p?.text).toBe("fix: p");
		expect(bridge.applyGitKey({ kind: "backspace" })).toBe(true);
		expect(nodes().get("git-summary")?.node.p?.text).toBe("fix: ");
		bridge.applyGitPaste("panel");
		expect(nodes().get("git-summary")?.node.p?.text).toBe("fix: panel");
		expect(bridge.applyGitKey({ kind: "submit" })).toBe(true);
		expect(nodes().get("git-body-field")?.node.k).toBe("editor");
		expect(bridge.applyGitKey({ kind: "escape" })).toBe(true);
		expect(nodes().get("git-summary-text")).toBeDefined();
	});

	it("shows the HEAD commit when the tree is clean", async () => {
		const head: HeadCommit = {
			sha: "abcdef1", short: "abcdef1", subject: "fix: thing", body: "", author: "Ada", email: "ada@example.com",
			parents: [], files: [{ path: "a.ts", kind: "modified", add: 1, del: 1 }],
		};
		vi.mocked(readRepoStatus).mockResolvedValue(repo([], head) as never);
		const { bridge, nodes } = openBridge();
		await flush();
		bridge.handle(action("git.open"));
		await flush();
		const map = nodes();
		expect(map.get("git-head-subject")?.node.p?.text).toBe("fix: thing");
		expect(map.get("git-commit")).toBeUndefined();
		expect(readCommitDiff).toHaveBeenCalledWith("/repo", "a.ts");
	});
});
