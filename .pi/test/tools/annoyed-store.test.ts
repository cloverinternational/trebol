import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AnnoyedStore, boundTranscript, TRANSCRIPT_BUDGET_BYTES } from "../../extensions/30-tools/annoyed/store.ts";

const home = () => mkdtempSync(join(tmpdir(), "annoyed-store-"));
const entries = (count: number, bytes: number) =>
  Array.from({ length: count }, (_, index) => ({ index, text: "x".repeat(bytes) }));

describe("annoyed transcript bounding", () => {
  it("keeps a small transcript intact", () => {
    const small = entries(3, 100);
    expect(boundTranscript(small)).toEqual(small);
  });

  it("truncates an oversized transcript and keeps the most recent entries", () => {
    const bounded: any = boundTranscript(entries(200, 10_000));
    expect(bounded.truncated).toBe(true);
    expect(bounded.omittedEntries).toBeGreaterThan(0);
    expect(JSON.stringify(bounded).length).toBeLessThanOrEqual(TRANSCRIPT_BUDGET_BYTES * 1.1);
    // The entries nearest the failure are the ones worth keeping.
    expect(bounded.entries.at(-1).index).toBe(199);
  });

  it("treats a missing transcript as absent rather than empty", () => {
    expect(boundTranscript(undefined)).toBeUndefined();
    expect(boundTranscript(null)).toBeUndefined();
  });
});

describe("annoyed JSON export", () => {
  it("never serializes transcripts, so the export cannot grow past V8's string limit", async () => {
    const store = new AnnoyedStore({ home: home() });
    await store.upsert({ issue: "first issue", transcript: entries(100, 20_000) });
    await store.upsert({ issue: "second issue", transcript: entries(100, 20_000) });

    const raw = await readFile(store.exportPath, "utf8");
    expect(raw).not.toContain("transcript");
    // Two issues carrying 2 MB of raw transcript must not produce a large export.
    expect(raw.length).toBeLessThan(200_000);

    const parsed = JSON.parse(raw);
    expect(parsed.issues).toHaveLength(2);
    expect(parsed.issues.every((issue: any) => !("transcript" in issue))).toBe(true);
    store.close();
  });

  it("still retains the bounded transcript in the database", async () => {
    const store = new AnnoyedStore({ home: home() });
    const { issue } = await store.upsert({ issue: "keeps transcript", transcript: entries(5, 50) });
    const stored = (await store.list()).find(candidate => candidate.id === issue.id);
    expect(stored?.transcript).toBeDefined();
    store.close();
  });
});
