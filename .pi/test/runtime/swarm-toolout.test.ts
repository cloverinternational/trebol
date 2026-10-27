import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, mkdtempSync, statSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BASH_OUTPUT_TOKENS_ENV,
  MAX_BASH_OUTPUT_TOKENS,
  MAX_TOOL_OUTPUT_LINES,
  MAX_TOOL_OUTPUT_TOKENS,
  MIN_TOOL_OUTPUT_TOKENS,
  SPILL_DIR,
  TOOL_OUTPUT_TOKENS_ENV,
  allocateBudget,
  bashOutputBudgetTokens,
  boundOversizedToolOutput,
  boundToolTextWithRecovery,
  clipSpan,
  configuredOutputTokens,
  defaultSpillIo,
  estimateOutputTokens,
  persistToolOutput,
  toolOutputBudgetTokens,
  type SpillIo,
} from "../../lib/runtime/swarm-toolout.ts";

const tempRoot = () => mkdtempSync(join(tmpdir(), "toolout-"));
const spillDir = (root: string) => join(root, SPILL_DIR);
const mode = (path: string) => statSync(path).mode & 0o777;

describe("estimated token counting", () => {
  it("is ceil(UTF-8 bytes / 4), not a tokenizer count", () => {
    expect(estimateOutputTokens("")).toBe(0);
    expect(estimateOutputTokens("abcd")).toBe(1);
    expect(estimateOutputTokens("abcde")).toBe(2);
    expect(estimateOutputTokens("α")).toBe(1);        // 2 bytes
    expect(estimateOutputTokens("αα")).toBe(1);       // 4 bytes
    expect(estimateOutputTokens("ααα")).toBe(2);      // 6 bytes
    expect(estimateOutputTokens("😀")).toBe(1);       // 4 bytes
  });
});

describe("configuration", () => {
  const env = (value?: string, name = TOOL_OUTPUT_TOKENS_ENV) => (value === undefined ? {} : { [name]: value });

  it("uses the documented defaults", () => {
    expect(toolOutputBudgetTokens({})).toBe(MAX_TOOL_OUTPUT_TOKENS);
    expect(bashOutputBudgetTokens({})).toBe(MAX_BASH_OUTPUT_TOKENS);
    expect(MAX_TOOL_OUTPUT_TOKENS).toBe(25_000);
    expect(MAX_BASH_OUTPUT_TOKENS).toBe(12_500);
    expect(MAX_TOOL_OUTPUT_LINES).toBe(1000);
    expect(MIN_TOOL_OUTPUT_TOKENS).toBe(500);
  });

  it("accepts a positive integer at or above the minimum", () => {
    expect(toolOutputBudgetTokens(env("500"))).toBe(500);
    expect(toolOutputBudgetTokens(env(" 4096 "))).toBe(4096);
    expect(bashOutputBudgetTokens(env("2000", BASH_OUTPUT_TOKENS_ENV))).toBe(2000);
  });

  it("ignores invalid or too-small values instead of clamping them", () => {
    for (const bad of ["", "abc", "0", "-5", "3.5", "1e6", String(MIN_TOOL_OUTPUT_TOKENS - 1), "99999999999999999999"]) {
      expect(configuredOutputTokens(env(bad))).toBe(MAX_TOOL_OUTPUT_TOKENS);
    }
    expect(toolOutputBudgetTokens(env("400", BASH_OUTPUT_TOKENS_ENV))).toBe(MAX_TOOL_OUTPUT_TOKENS);
  });
});

describe("clipSpan", () => {
  it("treats zero as a hard limit, unlike boundToolOutput", () => {
    expect(clipSpan("abcdef", 0, 0)).toMatchObject({ head: "", tail: "", clipped: true });
    const bounded = clipSpan("abcdef", 2, 10);
    expect(bounded.head + bounded.tail).toHaveLength(2);
  });

  it("keeps both ends and never splits a rune", () => {
    const text = "αααααααααα";
    const clipped = clipSpan(text, 8, 10);
    expect(clipped.head).toBe("αα");
    expect(clipped.tail).toBe("αα");
    expect(Buffer.byteLength(clipped.head + clipped.tail, "utf8")).toBeLessThanOrEqual(8);
    expect(`${clipped.head}${clipped.tail}`).not.toContain("\uFFFD");
  });

  it("applies the line limit to both ends", () => {
    const text = Array.from({ length: 40 }, (_, i) => `line${i + 1}`).join("\n");
    const clipped = clipSpan(text, 10_000, 6);
    // The head keeps its trailing newline, so it reads as three rows plus "".
    expect(clipped.head.split("\n")).toHaveLength(4);
    expect(clipped.tail.split("\n")).toHaveLength(3);
    expect(clipped.head.startsWith("line1")).toBe(true);
    expect(clipped.tail.endsWith("line40")).toBe(true);
  });
});

describe("allocateBudget", () => {
  it("keeps everything that fits and shares the rest without overspending", () => {
    const shares = allocateBudget([10, 1000, 10], 120);
    expect(shares[0]).toBe(10);
    expect(shares[2]).toBe(10);
    expect(shares[1]).toBe(100);
    expect(shares.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(120);
  });

  it("returns a non-negative share for every block when nothing fits", () => {
    expect(allocateBudget([50, 60, 70], 3)).toEqual([1, 1, 1]);
    expect(allocateBudget([50, 60], 0)).toEqual([0, 0]);
    expect(allocateBudget([], 100)).toEqual([]);
  });
});

describe("recoverable bounding", () => {
  it("leaves text at or below the budget untouched", () => {
    const root = tempRoot();
    const atLimit = "a".repeat(MIN_TOOL_OUTPUT_TOKENS * 4);
    const below = boundToolTextWithRecovery(atLimit, { maxTokens: MIN_TOOL_OUTPUT_TOKENS, root });
    expect(below.truncated).toBe(false);
    expect(below.text).toBe(atLimit);
    expect(below.outputPath).toBe("");
    expect(() => readdirSync(spillDir(root))).toThrow(/ENOENT/);
  });

  it("spills one byte over the budget and keeps the preview inside it", () => {
    const root = tempRoot();
    const over = "a".repeat(MIN_TOOL_OUTPUT_TOKENS * 4 + 1);
    const bounded = boundToolTextWithRecovery(over, { maxTokens: MIN_TOOL_OUTPUT_TOKENS, root });
    expect(bounded.truncated).toBe(true);
    expect(Buffer.byteLength(bounded.text, "utf8")).toBeLessThanOrEqual(MIN_TOOL_OUTPUT_TOKENS * 4);
    expect(bounded.text).toContain("Full output saved to: ");
    expect(bounded.text).toContain("Use `sed -n 'START,ENDp' FILE`");
    expect(readFileSync(bounded.outputPath, "utf8")).toBe(over);
  });

  it("bounds a huge single-line output without splitting a rune", () => {
    const root = tempRoot();
    const over = "😀".repeat(20_000);
    const bounded = boundToolTextWithRecovery(over, { maxTokens: MIN_TOOL_OUTPUT_TOKENS, root });
    expect(Buffer.byteLength(bounded.text, "utf8")).toBeLessThanOrEqual(MIN_TOOL_OUTPUT_TOKENS * 4);
    expect(bounded.text).not.toContain("\uFFFD");
    expect(bounded.text.startsWith("😀")).toBe(true);
    expect(readFileSync(bounded.outputPath)).toEqual(Buffer.from(over, "utf8"));
  });

  it("bounds a multiline output to the line guard", () => {
    const root = tempRoot();
    const over = Array.from({ length: 5000 }, (_, i) => `row-${i}`).join("\n");
    const bounded = boundToolTextWithRecovery(over, { maxTokens: MAX_TOOL_OUTPUT_TOKENS, maxLines: 20, root });
    expect(bounded.text.split("\n").length).toBeLessThanOrEqual(20 + 6);
    expect(bounded.text.startsWith("row-0")).toBe(true);
    expect(bounded.text).toContain("row-4999");
    expect(bounded.text).toContain("bytes elided from the middle of this output");
  });

  it("keeps the head only when asked (Bash parity shape)", () => {
    const root = tempRoot();
    const over = Array.from({ length: 200 }, (_, i) => `row-${i}`).join("\n");
    const bounded = boundToolTextWithRecovery(over, { maxTokens: MIN_TOOL_OUTPUT_TOKENS, maxLines: 50, keep: "head", root });
    expect(bounded.text.startsWith("row-0")).toBe(true);
    expect(bounded.text).not.toContain("row-199");
  });

  it("reports an unwritable spill root honestly and still returns a bounded preview", () => {
    const root = tempRoot();
    const notADir = join(root, "blocked");
    writeFileSync(notADir, "x");
    const over = "b".repeat(MIN_TOOL_OUTPUT_TOKENS * 4 * 2);
    const bounded = boundToolTextWithRecovery(over, { maxTokens: MIN_TOOL_OUTPUT_TOKENS, root: notADir });
    expect(bounded.truncated).toBe(true);
    expect(bounded.outputPath).toBe("");
    expect(bounded.failure).toBeTruthy();
    expect(bounded.text).toContain("Full output could not be saved (");
    expect(bounded.text).not.toContain("Full output saved to:");
    expect(Buffer.byteLength(bounded.text, "utf8")).toBeLessThanOrEqual(MIN_TOOL_OUTPUT_TOKENS * 4);
  });

  it("removes a partially written file and reports the failure", () => {
    const root = tempRoot();
    let written: string | undefined;
    const io: SpillIo = {
      ...defaultSpillIo,
      write: (fd, text) => {
        written = text;
        defaultSpillIo.write(fd, text.slice(0, 10));
        throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      },
    };
    const result = persistToolOutput("z".repeat(5000), { prefix: "tool-full-", root, io });
    expect(result.ok).toBe(false);
    expect(written).toHaveLength(5000);
    expect(result.ok === false && result.error).toContain("ENOSPC");
    expect(readdirSync(spillDir(root))).toEqual([]);
  });
});

describe("spill persistence", () => {
  it("writes privately, uniquely, and byte-for-byte", () => {
    const root = tempRoot();
    const text = "héllo\n😀\n\"quoted\"\n";
    const result = persistToolOutput(text, { prefix: "tool-full-", root });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(mode(spillDir(root))).toBe(0o700);
    expect(mode(result.path)).toBe(0o600);
    expect(readFileSync(result.path)).toEqual(Buffer.from(text, "utf8"));
    expect(result.bytes).toBe(Buffer.byteLength(text, "utf8"));
  });

  it("allocates a distinct path for every concurrent spill", () => {
    const root = tempRoot();
    const results = Array.from({ length: 50 }, (_, i) => persistToolOutput(`payload-${i}`, { prefix: "tool-full-", root }));
    const paths = results.map(result => (result.ok ? result.path : `failed:${result.error}`));
    expect(new Set(paths).size).toBe(50);
    expect(readdirSync(spillDir(root))).toHaveLength(50);
    results.forEach((result, i) => { if (result.ok) expect(readFileSync(result.path, "utf8")).toBe(`payload-${i}`); });
  });

  it("reuses one path when the entropy source collides", () => {
    const root = tempRoot();
    let calls = 0;
    const io: SpillIo = { ...defaultSpillIo, entropy: () => (calls++ === 0 ? 7 : 8) };
    const first = persistToolOutput("a", { prefix: "tool-full-", root, io });
    const second = persistToolOutput("b", { prefix: "tool-full-", root, io });
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(first.path).not.toBe(second.path);
      expect(readFileSync(first.path, "utf8")).toBe("a");
      expect(readFileSync(second.path, "utf8")).toBe("b");
    }
  });

  it("does not delete an existing file when the new name collides at open", () => {
    const root = tempRoot();
    const io: SpillIo = { ...defaultSpillIo, entropy: () => 1 };
    const first = persistToolOutput("keep me", { prefix: "tool-full-", root, io });
    const second = persistToolOutput("second", { prefix: "tool-full-", root, io });
    expect(second.ok).toBe(false);
    if (first.ok) expect(readFileSync(first.path, "utf8")).toBe("keep me");
  });
});

describe("boundOversizedToolOutput", () => {
  it("returns undefined when the result is unchanged", () => {
    expect(boundOversizedToolOutput("small")).toBeUndefined();
  });

  it("returns a recoverable bound when it is not", () => {
    const root = tempRoot();
    const bounded = boundOversizedToolOutput("x".repeat(200_000), { root })!;
    expect(bounded.truncated).toBe(true);
    expect(bounded.outputPath.startsWith(spillDir(root))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });
});
