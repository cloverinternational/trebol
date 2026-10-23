import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Real repos carry thousands of directories; a recursive watch on the whole root registers one inotify
// watch per directory and can hit fs.inotify.max_user_watches. That error is an async event, so the
// point of these tests is the wiring, not the filesystem: every watcher must own its 'error' event.
interface FakeWatcher { target: string; recursive: boolean; watcher: any }

const watched = vi.hoisted(() => [] as FakeWatcher[]);

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	const { EventEmitter } = await import("node:events");
	return {
		...actual,
		watch: (target: string, options: { recursive?: boolean } = {}, listener?: (event: string, name: string | null) => void) => {
			const watcher: any = new EventEmitter();
			watcher.close = vi.fn();
			if (listener) watcher.on("change", listener);
			watched.push({ target: String(target), recursive: options.recursive === true, watcher });
			return watcher;
		},
	};
});

const { watchRepo } = await import("../../lib/tern/startup-card.ts");

let root: string;

beforeEach(() => {
	watched.length = 0;
	root = mkdtempSync(join(tmpdir(), "trebol-watch-"));
	mkdirSync(join(root, "src", "deep"), { recursive: true });
	mkdirSync(join(root, "node_modules", "pkg", "dist"), { recursive: true });
	mkdirSync(join(root, ".git", "objects", "ab"), { recursive: true });
	writeFileSync(join(root, "src", "deep", "a.ts"), "a\n");
});

afterEach(() => {
	vi.useRealTimers();
	rmSync(root, { recursive: true, force: true });
});

describe("startup card watcher", () => {
	it("owns the async error that a reached watcher limit raises", () => {
		const dispose = watchRepo(root, join(root, ".git"), () => {});
		expect(watched.length).toBeGreaterThan(1);
		for (const entry of watched) expect(entry.watcher.listenerCount("error")).toBe(1);
		const first = watched[0]!;
		expect(() => first.watcher.emit("error", Object.assign(new Error("ENOSPC"), { code: "ENOSPC" }))).not.toThrow();
		expect(first.watcher.close).toHaveBeenCalled();
		dispose();
	});

	it("recurses into worktree entries but never over node_modules or the git directory", () => {
		const dispose = watchRepo(root, join(root, ".git"), () => {});
		const under = (name: string) => watched.filter((entry) => entry.target === join(root, name) || entry.target.startsWith(join(root, name) + "/"));
		expect(watched.filter((entry) => entry.target === root && entry.recursive)).toEqual([]);
		expect(under("node_modules")).toEqual([]);
		expect(under(".git").map((entry) => entry.recursive)).toEqual([false]);
		expect(watched.some((entry) => entry.target === root && !entry.recursive)).toBe(true);
		expect(watched.some((entry) => entry.target === join(root, "src") && entry.recursive)).toBe(true);
		dispose();
	});

	it("refreshes on worktree changes and ignores git lock files and dependency churn", () => {
		vi.useFakeTimers();
		const onChange = vi.fn();
		const dispose = watchRepo(root, join(root, ".git"), onChange);
		const atRoot = watched.find((entry) => entry.target === root && !entry.recursive)!;
		atRoot.watcher.emit("change", "change", "fresh.txt");
		vi.advanceTimersByTime(500);
		expect(onChange).toHaveBeenCalledTimes(1);
		onChange.mockClear();
		atRoot.watcher.emit("change", "change", "node_modules/pkg/dist/x.js");
		atRoot.watcher.emit("change", "change", ".git/index.lock");
		vi.advanceTimersByTime(500);
		expect(onChange).not.toHaveBeenCalled();
		dispose();
	});
});
