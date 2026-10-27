import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bashTruncateOutput,
  buildResultXML,
  commandFailedMessage,
  runSwarmBash,
} from "../../lib/tools/swarm-bash.ts";
import { BASH_OUTPUT_TOKENS_ENV, MIN_TOOL_OUTPUT_TOKENS, SPILL_DIR } from "../../lib/runtime/swarm-toolout.ts";

const tempRoot = () => mkdtempSync(join(tmpdir(), "bash-spill-"));
const spillDir = (root: string) => join(root, SPILL_DIR);
const outputFileOf = (xml: string) => /<output_file path="([^"]*)"\/>/.exec(xml)?.[1];

describe("bashTruncateOutput", () => {
  it("returns small output untouched and writes nothing", () => {
    const root = tempRoot();
    const result = bashTruncateOutput("line one\nline two\n", root, {});
    expect(result).toEqual({ output: "line one\nline two\n", outputPath: "", truncated: false });
    expect(() => readdirSync(spillDir(root))).toThrow(/ENOENT/);
  });

  it("persists the complete output before clipping and bounds the preview", () => {
    const root = tempRoot();
    const full = Array.from({ length: 40_000 }, (_, i) => `row-${i + 1}`).join("\n") + "\n";
    const result = bashTruncateOutput(full, root, {});
    expect(result.truncated).toBe(true);
    expect(result.outputPath.startsWith(spillDir(root))).toBe(true);
    expect(readFileSync(result.outputPath, "utf8")).toBe(full);
    expect(Buffer.byteLength(result.output, "utf8")).toBeLessThanOrEqual(12_500 * 4);
    expect(result.output.startsWith("row-1\n")).toBe(true);
    expect(result.output).toContain("Full output saved to: " + result.outputPath);
  });

  it("honours the documented environment override", () => {
    const root = tempRoot();
    const full = "z".repeat(MIN_TOOL_OUTPUT_TOKENS * 4 + 10);
    const result = bashTruncateOutput(full, root, { [BASH_OUTPUT_TOKENS_ENV]: String(MIN_TOOL_OUTPUT_TOKENS) });
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.output, "utf8")).toBeLessThanOrEqual(MIN_TOOL_OUTPUT_TOKENS * 4);
  });

  it("reports a failed write honestly instead of an empty path", () => {
    const root = tempRoot();
    const notADir = join(root, "blocked");
    writeFileSync(notADir, "x");
    const full = "q".repeat(120_000);
    const result = bashTruncateOutput(full, notADir, {});
    expect(result.truncated).toBe(true);
    expect(result.outputPath).toBe("");
    expect(result.failure).toBeTruthy();
    expect(result.output).toContain("Full output could not be saved (");
    expect(result.output).not.toContain("Full output saved to:");
  });
});

describe("bash result envelope", () => {
  const outcome = (over: Partial<Parameters<typeof buildResultXML>[0]>) => ({
    exitCode: 0, durationMs: 12, stdout: "", stderr: "", timedOut: false,
    requestedSecs: 90, effectiveSecs: 90, ...over,
  });

  it("points at the spill file and keeps exit metadata", () => {
    const xml = buildResultXML(outcome({ stdout: Array.from({ length: 5000 }, (_, i) => `l${i}`).join("\n") }));
    const path = outputFileOf(xml);
    expect(path).toBeTruthy();
    expect(xml).toContain('exit_code="0"');
    expect(xml).toContain('timed_out="false"');
    expect(xml).toContain("(output truncated — full content saved to output_path)");
    expect(xml).toContain("Full output saved to: " + path);
    expect(xml).not.toContain('path=""');
    expect(readFileSync(path!, "utf8")).toContain("l4999");
  });

  it("omits output_file and shows a bounded preview when the spill fails", () => {
    const root = tempRoot();
    const notADir = join(root, "blocked");
    writeFileSync(notADir, "x");
    const previous = process.env.TMPDIR;
    process.env.TMPDIR = notADir;
    try {
      const xml = buildResultXML(outcome({ exitCode: 2, stdout: "p".repeat(120_000) }));
      expect(outputFileOf(xml)).toBeUndefined();
      expect(xml).toContain("Full output could not be saved (");
      expect(xml).not.toContain('path=""');
      expect(xml).toContain('exit_code="2"');
      expect(xml.length).toBeLessThan(60_000);
    } finally {
      if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous;
    }
  });

  it("keeps timeout semantics on the failure message", () => {
    const plain = commandFailedMessage(143, "x".repeat(120_000), "");
    expect(plain).toContain("Command exited with code 143: exit status 143");
    expect(plain).toContain("Full output saved to: ");
    // ProcessState.ExitCode() is -1 for a signalled process; the note names it.
    const message = commandFailedMessage(-1, "x".repeat(120_000), "", undefined, "SIGTERM");
    expect(message).toContain("Command exited with code -1: signal: term");
    expect(message).toContain("Full output saved to: ");
  });
});

describe("real shell end to end", () => {
  it("runs an over-threshold command, then recovers the full output with sed and a line search", async () => {
    const root = tempRoot();
    const command = "seq 1 20000";
    const outcome = await runSwarmBash({ command, timeout_seconds: 60 }, { defaultCwd: root });
    expect("error" in outcome).toBe(false);
    if ("error" in outcome) return;
    expect(outcome.exitCode).toBe(0);
    const xml = buildResultXML(outcome);
    const path = outputFileOf(xml);
    expect(path).toBeTruthy();
    const recovered = readFileSync(path!, "utf8");
    expect(recovered).toBe(outcome.stdout);
    expect(recovered.split("\n").filter(Boolean)).toHaveLength(20_000);
    expect(execFileSync("sed", ["-n", "1,3p", path!], { encoding: "utf8" })).toBe("1\n2\n3\n");
    // The notice suggests `rg`, but a bare CI runner ships neither rg nor an
    // equivalent, so the retrieval assertion uses POSIX grep (present on every
    // supported host) and a direct read proves the same line is in the file.
    expect(execFileSync("grep", ["-c", "^19999$", path!], { encoding: "utf8" }).trim()).toBe("1");
    expect(recovered.split("\n").filter((line) => line === "19999")).toHaveLength(1);
    expect(xml).toContain("exit_code=\"0\"");
  });

  it("keeps a failed command's full stderr recoverable", async () => {
    const root = tempRoot();
    const command = "seq 1 20000 >&2; exit 3";
    const outcome = await runSwarmBash({ command, timeout_seconds: 60 }, { defaultCwd: root });
    expect("error" in outcome).toBe(false);
    if ("error" in outcome) return;
    expect(outcome.exitCode).toBe(3);
    const message = commandFailedMessage(outcome.exitCode, outcome.stdout, outcome.stderr);
    expect(message).toContain("Command exited with code 3");
    const path = /Full output saved to: (.+)/.exec(message)![1]!.trim();
    expect(readFileSync(path, "utf8")).toContain("20000");
  });
});
