import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PiTernBridge, type PiSessionLike } from "../../lib/tern/bridge.ts";
import { readFileDiff, type GitEntry } from "../../lib/tern/git-status.ts";
import { readRepoStatus, watchRepo } from "../../lib/tern/startup-card.ts";
import { ESC, parseTspMessages, type TspMessage } from "../../lib/tern/tsp.ts";

vi.mock("../../lib/tern/git-status.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../lib/tern/git-status.ts")>()),
	readFileDiff: vi.fn(),
}));

vi.mock("../../lib/tern/startup-card.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../lib/tern/startup-card.ts")>()),
	readRepoStatus: vi.fn(),
	watchRepo: vi.fn(() => () => {}),
}));

interface Pending { path: string; resolve(text: string): void; reject(error: unknown): void }

let pending: Pending[];
let bridges: PiTernBridge[];

function entry(path: string): GitEntry {
	return { path, x: " ", y: "M", conflict: false, untracked: false, staged: false, unstaged: true };
}

function repoStatus() {
	return {
		cwd: "/repo", git: true as const, root: "/repo", worktrees: 1, commits: [],
		snapshot: { branch: "main", oid: "abc", detached: false, noCommits: false, entries: [entry("a.ts"), entry("b.ts")] },
	};
}

function fakeSession(): PiSessionLike {
	return {
		sessionManager: { getCwd: () => "/repo" },
		subscribe: () => () => {},
		prompt: async () => {},
		abort: async () => {},
		dispose() {},
	} as unknown as PiSessionLike;
}

function action(body: Record<string, unknown>): TspMessage {
	return { verb: "e", body: { ev: "action", sf: "pi", ...body } };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function openBridge() {
	const writes: string[] = [];
	const bridge = new PiTernBridge(fakeSession(), { write: (d: string) => writes.push(d), surfaceId: "pi", credits: 1000 });
	bridges.push(bridge);
	bridge.start();
	return { bridge, writes };
}

function lastFrameText(writes: string[]): string {
	const frame = writes.filter((w) => w.startsWith(`${ESC}_tsp;f;`)).at(-1);
	if (!frame) throw new Error("no frame written");
	return JSON.stringify(parseTspMessages(frame)[0]?.body);
}

function settle(path: string, text: string): void {
	const request = pending.find((p) => p.path === path);
	if (!request) throw new Error(`no pending read for ${path}`);
	pending = pending.filter((p) => p !== request);
	request.resolve(text);
}

async function openListWithFiles() {
	const opened = openBridge();
	await flush();
	opened.bridge.handle(action({ act: "git.open" }));
	return opened;
}

beforeEach(() => {
	pending = [];
	bridges = [];
	vi.mocked(readRepoStatus).mockResolvedValue(repoStatus() as never);
	vi.mocked(watchRepo).mockImplementation(() => () => {});
	vi.mocked(readFileDiff).mockImplementation((_cwd, e) => new Promise<string>((resolve, reject) => {
		pending.push({ path: e.path, resolve, reject });
	}));
});

afterEach(() => {
	for (const bridge of bridges) bridge.close();
	vi.clearAllMocks();
});

describe("Git modal async diff reads", () => {
	it("a slower read for an earlier file does not overwrite the newer selection", async () => {
		const { bridge, writes } = await openListWithFiles();
		bridge.handle(action({ act: "git.file", value: "0" }));
		bridge.handle(action({ act: "git.file", value: "1" }));
		settle("b.ts", "DIFF-B");
		await flush();
		settle("a.ts", "DIFF-A");
		await flush();
		const frame = lastFrameText(writes);
		expect(frame).toContain("DIFF-B");
		expect(frame).not.toContain("DIFF-A");
	});

	it("a read that resolves after git.back does not reopen the diff", async () => {
		const { bridge, writes } = await openListWithFiles();
		bridge.handle(action({ act: "git.file", value: "0" }));
		bridge.handle(action({ act: "git.back" }));
		settle("a.ts", "DIFF-A");
		await flush();
		expect(lastFrameText(writes)).not.toContain("DIFF-A");
	});

	it("a read that resolves after git.close does not reopen the overlay", async () => {
		const { bridge, writes } = await openListWithFiles();
		bridge.handle(action({ act: "git.file", value: "0" }));
		bridge.handle(action({ act: "git.close" }));
		const before = writes.length;
		settle("a.ts", "DIFF-A");
		await flush();
		expect(writes.length).toBe(before);
		expect(lastFrameText(writes)).not.toContain("DIFF-A");
	});

	it("a read started before Esc closes the diff does not land after it", async () => {
		const { bridge, writes } = await openListWithFiles();
		bridge.handle(action({ act: "git.file", value: "0" }));
		bridge.escape();
		settle("a.ts", "DIFF-A");
		await flush();
		expect(lastFrameText(writes)).not.toContain("DIFF-A");
	});

	it("a read started before git.close does not land after the list is reopened", async () => {
		const { bridge, writes } = await openListWithFiles();
		bridge.handle(action({ act: "git.file", value: "0" }));
		bridge.handle(action({ act: "git.close" }));
		bridge.handle(action({ act: "git.open" }));
		settle("a.ts", "DIFF-A");
		await flush();
		expect(lastFrameText(writes)).not.toContain("DIFF-A");
	});

	it("a read that resolves after close writes nothing", async () => {
		const { bridge, writes } = await openListWithFiles();
		bridge.handle(action({ act: "git.file", value: "0" }));
		bridge.close();
		const before = writes.length;
		settle("a.ts", "DIFF-A");
		await flush();
		expect(writes.length).toBe(before);
	});

	it("a rejected read is handled and shows the unavailable fallback for the current selection", async () => {
		const { bridge, writes } = await openListWithFiles();
		bridge.handle(action({ act: "git.file", value: "0" }));
		const request = pending.find((p) => p.path === "a.ts");
		pending = pending.filter((p) => p !== request);
		request?.reject(new Error("boom"));
		await flush();
		expect(bridge.closed).toBe(false);
		expect(lastFrameText(writes)).toContain("Diff unavailable.");
	});
});
