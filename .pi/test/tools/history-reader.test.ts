import { mkdtemp, mkdir, symlink, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverHistoryFiles, readHistoryRecords, type HistoryBudget } from "../../lib/tools/history-reader.js";

const roots: string[] = [];
async function fixture() { const root = await mkdtemp(join(tmpdir(), "history-reader-")); roots.push(root); return root; }
function budget(overrides: Partial<HistoryBudget> = {}): HistoryBudget { return { maxTotalBytes: 10_000_000, maxFiles: 100, maxDirectoryEntries: 100, maxDepth: 10, ...overrides }; }
async function collect<T>(iter: AsyncIterable<T>) { const out: T[] = []; for await (const x of iter) out.push(x); return out; }
afterEach(async () => { await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true }))); });

describe("bounded history reader", () => {
	it("reads UTF-8 records across tiny boundaries and ignores invalid JSON and primitives", async () => {
		const root = await fixture(), path = join(root, "history");
		await writeFile(path, '{"x":"🌱"}\nnull\n3\nnot-json\n{"ok":true}');
		const records = await collect(readHistoryRecords(path, budget()));
		expect(records).toEqual([{ value: { x: "🌱" }, line: 1 }, { value: { ok: true }, line: 5 }]);
	});
	it("drains giant no-newline records and continues at next newline", async () => {
		const root = await fixture(), path = join(root, "history");
		await writeFile(path, `${"x".repeat(2_000_000)}\n{"ok":1}\n`);
		const b = budget(), records = await collect(readHistoryRecords(path, b));
		expect(records).toEqual([{ value: { ok: 1 }, line: 2 }]); expect(b.counters?.bytes).toBeGreaterThan(2_000_000);
		expect(b.partialReasons).toContain("maxRecordBytes");
	});
	it("bounds total bytes and marks an interrupted final record partial", async () => {
		const root = await fixture(), path = join(root, "h"); await writeFile(path, '{"a":1}\n{"b":2}\n');
		const b = budget({ maxTotalBytes: 10 }); await collect(readHistoryRecords(path, b));
		expect(b.counters?.bytes).toBe(10); expect(b.partialReasons).toContain("maxTotalBytes");
	});
	it("discovers incrementally and skips symlinks", async () => {
		const root = await fixture(), sub = join(root, "sub"); await mkdir(sub); await writeFile(join(root, "a"), ""); await writeFile(join(sub, "b"), "");
		await symlink(sub, join(root, "link"));
		// A budget that covers the tree: opendir yields filesystem order, so a tight cap would make
		// *which* entries are visited — and so the discovered set — depend on that order.
		const files = (await collect(discoverHistoryFiles(root, budget()))).map((file) => relative(root, file)).sort();
		expect(files).toEqual(["a", join("sub", "b")]);
	});
	it("stops at the directory-entry and file caps", async () => {
		const root = await fixture(), sub = join(root, "sub"); await mkdir(sub); await writeFile(join(root, "a"), ""); await writeFile(join(sub, "b"), "");
		// One entry: exactly one is consumed whichever one readdir returns first, and the cap is reported.
		const entries = budget({ maxDirectoryEntries: 1 });
		const seen = await collect(discoverHistoryFiles(root, entries));
		expect(entries.counters?.directoryEntries).toBe(1); expect(seen.length).toBeLessThanOrEqual(1);
		expect(entries.partialReasons).toContain("maxDirectoryEntries");
		// One file: the second regular file is refused whichever order the tree is visited in.
		const capped = budget({ maxFiles: 1 });
		expect((await collect(discoverHistoryFiles(root, capped))).length).toBe(1);
		expect(capped.counters?.files).toBe(1); expect(capped.partialReasons).toContain("maxFiles");
	});
	it("handles missing roots and pre-aborted reads", async () => {
		const root = await fixture(), controller = new AbortController(); controller.abort();
		const b = budget({ signal: controller.signal });
		expect(await collect(discoverHistoryFiles(join(root, "missing"), b))).toEqual([]);
		const path = join(root, "h"); await writeFile(path, '{"x":1}\n');
		expect(await collect(readHistoryRecords(path, b))).toEqual([]); expect(b.partialReasons).toContain("aborted");
	});
	it("never modifies source files", async () => {
		const root = await fixture(), path = join(root, "h"), source = '{"safe":true}\n'; await writeFile(path, source);
		await collect(readHistoryRecords(path, budget())); expect(await readFile(path, "utf8")).toBe(source);
	});
});
