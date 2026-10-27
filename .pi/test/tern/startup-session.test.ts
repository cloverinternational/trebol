import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	bootGeneration,
	chooseStartupSession,
	clearPaneRecord,
	PANE_RECORD_TTL_MS,
	parsePaneBook,
	paneKey,
	pidAlive,
	readPaneBook,
	recordPaneSession,
	type PaneSessionBook,
} from "../../lib/tern/startup-session.ts";

const roots: string[] = [];
function tempRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "trebol-tern-startup-"));
	roots.push(root);
	return root;
}
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const BOOT = 30_000_000;
const record = (sessionFile: string, pid: number, boot = BOOT - 1) => ({ sessionFile, pid, cwd: "/work/app", updatedAt: 1_000, boot });

function decide(overrides: Partial<Parameters<typeof chooseStartupSession>[0]> = {}) {
	return chooseStartupSession({
		fresh: false,
		key: "42",
		book: {},
		selfPid: 900,
		exists: () => true,
		alive: () => false,
		boot: BOOT,
		...overrides,
	});
}

describe("chooseStartupSession", () => {
	it("reopens the pane's session only when the record came from an earlier boot", () => {
		const book: PaneSessionBook = { "42": record("/s/pane.jsonl", 500) };
		expect(decide({ book })).toEqual({ kind: "open", path: "/s/pane.jsonl" });
	});

	it("starts a new conversation when the pane outlived its program in this boot", () => {
		const book: PaneSessionBook = { "42": record("/s/pane.jsonl", 500, BOOT) };
		expect(decide({ book })).toEqual({ kind: "new", reason: "same-boot" });
	});

	it("never opens a session a live runner still owns (a detached window is still running)", () => {
		const book: PaneSessionBook = { "42": record("/s/pane.jsonl", 500) };
		expect(decide({ book, alive: (pid) => pid === 500 })).toEqual({ kind: "new", reason: "owner-alive" });
	});

	it("starts new when the recorded file is gone, or when the pane has no record at all", () => {
		expect(decide({ book: { "42": record("/s/pane.jsonl", 500) }, exists: () => false })).toEqual({ kind: "new", reason: "missing" });
		expect(decide()).toEqual({ kind: "new", reason: "no-candidate" });
		expect(decide({ key: undefined, book: { "42": record("/s/pane.jsonl", 500) } })).toEqual({ kind: "new", reason: "no-candidate" });
	});

	it("starts new when the user asks for it, whatever the record says", () => {
		expect(decide({ fresh: true, book: { "42": record("/s/pane.jsonl", 500) } })).toEqual({ kind: "new", reason: "fresh" });
	});

	it("identifies one boot by whole minutes, so clock steps do not split it", () => {
		const bootedAt = 1_700_000_000_000;
		const first = bootGeneration(bootedAt + 60_000, 60);
		expect(bootGeneration(bootedAt + 60_000 + 20_000, 80)).toBe(first);
		expect(bootGeneration(bootedAt + 3_600_000, 3_600)).toBe(first);
		expect(bootGeneration(bootedAt + 3_600_000, 60)).not.toBe(first);
	});
});

describe("pane record book", () => {
	it("keeps only complete records, so a truncated or hand-edited book resumes nothing", () => {
		expect(parsePaneBook(undefined)).toEqual({});
		expect(parsePaneBook('{"42": {"sessionFile": "/s/a.j')).toEqual({});
		expect(parsePaneBook("[]")).toEqual({});
		expect(parsePaneBook(JSON.stringify({ "42": { sessionFile: "", pid: 5 }, "43": { pid: 5 }, "44": { sessionFile: "/s/c", pid: 0 } }))).toEqual({});
		// No boot generation: it cannot tell a reboot from a deliberate exit, so it resumes nothing.
		expect(parsePaneBook(JSON.stringify({ "42": { sessionFile: "/s/a", pid: 5 } }))).toEqual({});
		expect(parsePaneBook(JSON.stringify({ "42": { sessionFile: "/s/a", pid: 5, boot: 7 } }))).toEqual({
			"42": { sessionFile: "/s/a", pid: 5, cwd: "", updatedAt: 0, boot: 7 },
		});
	});

	it("writes atomically, owner-only, and leaves no temporary file behind", () => {
		const root = tempRoot();
		const path = join(root, "nested", "tern-panes.json");
		recordPaneSession(path, "42", record("/s/a.jsonl", 5), () => true);
		expect(readPaneBook(path)["42"].sessionFile).toBe("/s/a.jsonl");
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(readdirSync(join(root, "nested"))).toEqual(["tern-panes.json"]);
	});

	it("keeps a dead runner's recent record for the next boot and drops stale ones", () => {
		const path = join(tempRoot(), "tern-panes.json");
		const stale = { ...record("/s/stale.jsonl", 7), updatedAt: 0 };
		const recent = { ...record("/s/recent.jsonl", 8), updatedAt: 100 };
		writeFileSync(path, JSON.stringify({ "1": stale, "2": recent }));
		recordPaneSession(path, "42", { ...record("/s/mine.jsonl", 9), updatedAt: PANE_RECORD_TTL_MS + 1 }, () => false);
		const book = JSON.parse(readFileSync(path, "utf8"));
		expect(book["2"]).toBeDefined();
		expect(book["1"]).toBeUndefined();
		expect(book["42"].sessionFile).toBe("/s/mine.jsonl");
		expect(book["42"].boot).toBe(BOOT - 1);
	});

	it("forgets a pane on request, so no later start reopens it", () => {
		const path = join(tempRoot(), "tern-panes.json");
		recordPaneSession(path, "42", record("/s/a.jsonl", 5), () => true);
		recordPaneSession(path, "7", record("/s/b.jsonl", 6), () => true);
		expect(clearPaneRecord(path, "42")).toBe(true);
		expect(Object.keys(readPaneBook(path))).toEqual(["7"]);
		expect(clearPaneRecord(path, "42")).toBe(false);
	});

	it("keeps a record whose owner is alive, however old", () => {
		const path = join(tempRoot(), "tern-panes.json");
		const live = { ...record("/s/live.jsonl", 7), updatedAt: 1 };
		writeFileSync(path, JSON.stringify({ "1": live }));
		recordPaneSession(path, "42", { ...record("/s/mine.jsonl", 9), updatedAt: 10 * 365 * 24 * 3600 * 1000 }, (pid) => pid === 7);
		expect(JSON.parse(readFileSync(path, "utf8"))["1"]).toBeDefined();
	});
});

describe("pane key and liveness", () => {
	it("accepts only a non-empty Tern pane id", () => {
		expect(paneKey({ TERN_PANE: " 42 " })).toBe("42");
		expect(paneKey({ TERN_PANE: "  " })).toBeUndefined();
		expect(paneKey({})).toBeUndefined();
	});

	it("reports this process as alive and a just-exited child as gone", async () => {
		expect(pidAlive(process.pid)).toBe(true);
		expect(pidAlive(0)).toBe(false);
		expect(pidAlive(-1)).toBe(false);
		expect(pidAlive(process.pid + 1_000_000)).toBe(false);
	});
});
