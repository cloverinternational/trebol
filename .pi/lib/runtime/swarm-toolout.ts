/**
 * Shared tool-output bounding and spill persistence.
 *
 * Port of swarm-sdk internal/toolout/bound.go and the oversized-tool-result
 * guard in internal/agent/agent_tools.go, extended with recoverable spillover:
 * an oversized tool text is written in full to a private temporary file before
 * the model-facing text is clipped, and the clipped text names that file.
 *
 * The budget is an ESTIMATE, not a provider token count:
 *   estimated tokens = ceil(UTF-8 bytes / 4)
 * It covers tool text only. Images, other non-text blocks, provider protocol
 * overhead, and structured content are outside the bound.
 *
 * Retention: spill files survive session exit but are ordinary OS temporary
 * files, so they can be removed by tmp cleaning, reboot, or an OS policy.
 */
import { chmodSync, lstatSync, closeSync, fstatSync, mkdirSync, openSync, unlinkSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const CHARS_PER_TOKEN = 4;
/** Estimated-token budget for the general tool_result boundary. */
export const MAX_TOOL_OUTPUT_TOKENS = 25_000;
/** Legacy byte form of the general budget (25,000 estimated tokens). */
export const MAX_TOOL_OUTPUT_CHARS = MAX_TOOL_OUTPUT_TOKENS * CHARS_PER_TOKEN; // 100,000
export const MAX_TOOL_OUTPUT_LINES = 1000;
/** Estimated-token budget for the Bash tool's own spill path. */
export const MAX_BASH_OUTPUT_TOKENS = 12_500;
export const MAX_BASH_OUTPUT_LINES = 2000;
/**
 * Smallest accepted override. Below this a mis-set variable would leave the
 * model with a useless preview, so such a value is ignored (never clamped).
 */
export const MIN_TOOL_OUTPUT_TOKENS = 500;
/** Environment overrides, validated as positive integers in estimated tokens. */
export const TOOL_OUTPUT_TOKENS_ENV = "PI_SWARM_TOOL_OUTPUT_TOKENS";
export const BASH_OUTPUT_TOKENS_ENV = "PI_SWARM_BASH_OUTPUT_TOKENS";
/** Directory (under the OS temp root) that holds every spilled tool text. */
export const SPILL_DIR = "swarm-tool-output";
export const SPILL_DIR_MODE = 0o700;
export const SPILL_FILE_MODE = 0o600;
/** Worst-case room for the elision marker, spill path, and retrieval hint. */
export const NOTICE_RESERVE_CHARS = 1024;
export const NOTICE_RESERVE_LINES = 12;

/** ceil(UTF-8 bytes / 4): the documented estimate, distinct from any tokenizer. */
export function estimateOutputTokens(text: string): number {
  const bytes = Buffer.byteLength(text, "utf8");
  return bytes === 0 ? 0 : Math.ceil(bytes / CHARS_PER_TOKEN);
}

/**
 * Resolve a configured budget. Invalid, zero, negative, non-integer, or
 * below-minimum values are ignored so a typo cannot silently shrink the budget.
 */
export function configuredOutputTokens(
  env: NodeJS.ProcessEnv = process.env,
  name: string = TOOL_OUTPUT_TOKENS_ENV,
  fallback: number = MAX_TOOL_OUTPUT_TOKENS,
): number {
  const raw = (env?.[name] ?? "").trim();
  if (!/^\d+$/.test(raw)) return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= MIN_TOOL_OUTPUT_TOKENS ? value : fallback;
}

/** Effective estimated-token budget of the general tool_result boundary. */
export const toolOutputBudgetTokens = (env: NodeJS.ProcessEnv = process.env): number =>
  configuredOutputTokens(env, TOOL_OUTPUT_TOKENS_ENV, MAX_TOOL_OUTPUT_TOKENS);

/** Effective estimated-token budget of the Bash spill path. */
export const bashOutputBudgetTokens = (env: NodeJS.ProcessEnv = process.env): number =>
  configuredOutputTokens(env, BASH_OUTPUT_TOKENS_ENV, MAX_BASH_OUTPUT_TOKENS);

export interface BoundResult { output: string; head: string; tail: string; elidedChars: number; elidedLines: number; truncated: boolean }

const NL = 0x0a;
const isRuneStart = (b: number) => (b & 0xc0) !== 0x80;
const countLines = (buf: Buffer) => buf.length === 0 ? 0 : buf.filter(b => b === NL).length + 1;
function utf8SafePrefixEnd(buf: Buffer, budget: number): number {
  if (budget >= buf.length) return buf.length;
  if (budget <= 0) return 0;
  let end = budget;
  while (end > 0 && !isRuneStart(buf[end])) end--;
  return end;
}
function utf8SafeSuffixStart(buf: Buffer, budget: number): number {
  if (budget >= buf.length) return 0;
  if (budget <= 0) return buf.length;
  let start = buf.length - budget;
  while (start < buf.length && !isRuneStart(buf[start])) start++;
  return start;
}
function prefixEndForLines(buf: Buffer, lines: number): number {
  if (lines <= 0) return 0;
  let end = 0;
  for (let i = 0; i < lines; i++) {
    const index = buf.indexOf(NL, end);
    if (index < 0) return buf.length;
    end = index + 1;
  }
  return end;
}
function suffixStartForLines(buf: Buffer, lines: number): number {
  if (lines <= 0) return buf.length;
  let start = buf.length;
  for (let i = 0; i < lines; i++) {
    const index = buf.lastIndexOf(NL, start - 1);
    if (index < 0 || start === 0) return 0;
    start = index;
  }
  return start + 1;
}

/** One clip decision: head/tail pieces whose UTF-8 bytes never split a rune. */
export interface ClipSpan { head: string; tail: string; elidedBytes: number; elidedLines: number; clipped: boolean }

/**
 * Clip text to a hard byte limit and a hard line limit (both are real limits:
 * 0 keeps nothing, unlike boundToolOutput where 0 means "no limit"). The
 * removed span is taken from the middle so the head and the tail both survive.
 */
export function clipSpan(text: string, maxBytes: number, maxLines: number, keep: "head" | "head-tail" = "head-tail"): ClipSpan {
  const bytes = Buffer.byteLength(text, "utf8");
  const lines = text === "" ? 0 : text.split("\n").length;
  if (bytes <= Math.max(0, maxBytes) && lines <= Math.max(0, maxLines)) {
    return { head: text, tail: "", elidedBytes: 0, elidedLines: 0, clipped: false };
  }
  const buf = Buffer.from(text, "utf8");
  const headBudget = keep === "head" ? Math.max(0, maxBytes) : Math.floor((Math.max(0, maxBytes) + 1) / 2);
  const tailBudget = keep === "head" ? 0 : Math.floor(Math.max(0, maxBytes) / 2);
  const headLines = keep === "head" ? Math.max(0, maxLines) : Math.floor((Math.max(0, maxLines) + 1) / 2);
  const tailLines = keep === "head" ? 0 : Math.floor(Math.max(0, maxLines) / 2);
  let headEnd = Math.min(utf8SafePrefixEnd(buf, headBudget), prefixEndForLines(buf, headLines));
  let tailStart = Math.max(utf8SafeSuffixStart(buf, tailBudget), suffixStartForLines(buf, tailLines));
  if (headEnd > tailStart) headEnd = tailStart;
  const head = buf.subarray(0, headEnd).toString("utf8");
  const tail = buf.subarray(tailStart).toString("utf8");
  const kept = Buffer.byteLength(head, "utf8") + Buffer.byteLength(tail, "utf8");
  const keptLines = (head === "" ? 0 : head.split("\n").length) + (tail === "" ? 0 : tail.split("\n").length);
  return { head, tail, elidedBytes: bytes - kept, elidedLines: Math.max(0, lines - keptLines), clipped: true };
}

/**
 * Distribute `budget` across `sizes` so that callers whose size already fits
 * keep everything and the remainder is shared by the rest. Never exceeds the
 * budget, never returns a negative share.
 */
export function allocateBudget(sizes: number[], budget: number): number[] {
  const shares = sizes.map(() => 0);
  let remaining = Math.max(0, budget);
  let pending = sizes.map((_, index) => index).filter(index => sizes[index] > 0);
  while (pending.length > 0) {
    const share = Math.floor(remaining / pending.length);
    const next: number[] = [];
    for (const index of pending) {
      if (sizes[index] <= share) { shares[index] = sizes[index]; remaining -= sizes[index]; }
      else next.push(index);
    }
    if (next.length === pending.length) {
      // Nobody fits the equal share: hand each the equal share and stop.
      for (const index of next) shares[index] = Math.max(0, share);
      break;
    }
    pending = next;
  }
  return shares;
}

/** Filesystem seam so a write failure can be injected in tests. */
export interface SpillIo {
  mkdir(dir: string): void;
  create(path: string): number;
  write(fd: number, text: string): void;
  size(fd: number): number;
  close(fd: number): void;
  remove(path: string): void;
  entropy(): number;
}

export const defaultSpillIo: SpillIo = {
  mkdir: dir => {
    mkdirSync(dir, { recursive: true, mode: SPILL_DIR_MODE });
    const stat = lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
      throw new Error("unsafe spill directory: expected an owned directory, not a symlink");
    }
    chmodSync(dir, SPILL_DIR_MODE);
  },
  create: path => openSync(path, "wx", SPILL_FILE_MODE),
  write: (fd, text) => { let offset = 0; const buf = Buffer.from(text, "utf8"); while (offset < buf.length) { const written = writeSync(fd, buf, offset, buf.length - offset); if (written <= 0) throw new Error("spill write made no progress"); offset += written; } },
  size: fd => fstatSync(fd).size,
  close: fd => { closeSync(fd); },
  remove: path => { try { unlinkSync(path); } catch { /* already gone */ } },
  entropy: () => Math.floor(Math.random() * 0x1_0000_0000),
};

export type SpillResult = { ok: true; path: string; bytes: number } | { ok: false; error: string };

export interface SpillOptions {
  /** Prefix of the file name, e.g. "tool-full-" or "bash-full-". */
  prefix: string;
  /** Temp root; the spill directory is created beneath it. */
  root?: string;
  io?: SpillIo;
}

const errorText = (error: unknown): string => {
  const code = (error as { code?: unknown })?.code;
  const message = error instanceof Error ? error.message : String(error);
  return typeof code === "string" && !message.includes(code) ? `${code}: ${message}` : message;
};

/**
 * Write the complete text to a new private file, then publish its path. A path
 * is returned only after every byte landed; a partial file is removed and the
 * failure is reported instead of an unusable link.
 */
export function persistToolOutput(text: string, options: SpillOptions): SpillResult {
  const io = options.io ?? defaultSpillIo;
  const dir = join(options.root ?? tmpdir(), SPILL_DIR);
  const bytes = Buffer.byteLength(text, "utf8");
  let path = "";
  let fd = -1;
  try {
    io.mkdir(dir);
    for (let attempt = 0; ; attempt++) {
      if (attempt >= 10_000) throw new Error("createTemp: too many attempts");
      const candidate = join(dir, `${options.prefix}${io.entropy()}${".txt"}`);
      try { fd = io.create(candidate); path = candidate; break; }
      catch (error) {
        if ((error as { code?: unknown })?.code !== "EEXIST") throw error;
      }
    }
    io.write(fd, text);
    const written = io.size(fd);
    if (written !== bytes) throw new Error(`short write (${written}/${bytes} bytes)`);
    io.close(fd);
    fd = -1;
    return { ok: true, path, bytes };
  } catch (error) {
    if (fd >= 0) { try { io.close(fd); } catch { /* already closed */ } }
    if (path) { try { io.remove(path); } catch { /* best-effort cleanup, never mask the write failure */ } }
    return { ok: false, error: errorText(error) };
  }
}

export interface RecoverableBoundOptions {
  /** Estimated-token budget; defaults to the configured general budget. */
  maxTokens?: number;
  /** Line guard; defaults to MAX_TOOL_OUTPUT_LINES. */
  maxLines?: number;
  /** "head-tail" (default) keeps both ends; "head" matches Swarm's bash clipping. */
  keep?: "head" | "head-tail";
  /** Spill file prefix. */
  prefix?: string;
  root?: string;
  io?: SpillIo;
}

export interface RecoverableBound {
  text: string;
  truncated: boolean;
  /** Published spill path, or "" when the text was unchanged or could not be saved. */
  outputPath: string;
  /** Why the spill failed, when it did. */
  failure?: string;
  elidedBytes: number;
  elidedLines: number;
  tokens: number;
}

const RETRIEVAL_HINT = "Use `sed -n 'START,ENDp' FILE` to view sections, or `rg PATTERN FILE` to search within it.";

/**
 * Bound tool text to the estimated-token budget, persisting the full text
 * first. The preview and the recovery notice share one budget, so the returned
 * text stays within the limit even when the notice is long.
 */
export function boundToolTextWithRecovery(full: string, options: RecoverableBoundOptions = {}): RecoverableBound {
  const maxTokens = options.maxTokens ?? toolOutputBudgetTokens();
  const maxLines = options.maxLines ?? MAX_TOOL_OUTPUT_LINES;
  const maxBytes = Math.max(0, maxTokens) * CHARS_PER_TOKEN;
  const tokens = estimateOutputTokens(full);
  const bytes = Buffer.byteLength(full, "utf8");
  const lines = full === "" ? 0 : full.split("\n").length;
  if (bytes <= maxBytes && lines <= maxLines) {
    return { text: full, truncated: false, outputPath: "", elidedBytes: 0, elidedLines: 0, tokens };
  }
  const spill = persistToolOutput(full, { prefix: options.prefix ?? "tool-full-", root: options.root, io: options.io });
  const hint = spill.ok
    ? `Full output saved to: ${spill.path}\n${RETRIEVAL_HINT}`
    : `Full output could not be saved (${spill.error}); re-run a narrower command or query to see more.`;
  const keep = options.keep ?? "head-tail";
  let bodyBytes = Math.max(0, maxBytes - NOTICE_RESERVE_CHARS);
  let bodyLines = Math.max(0, maxLines - NOTICE_RESERVE_LINES);
  let clipped = clipSpan(full, bodyBytes, bodyLines, keep);
  let text = composePreview(clipped, hint, keep);
  // The reserve is an upper bound; if a long path or a huge count still pushed
  // the notice past it, shrink the body by exactly the overflow and recompose.
  for (let attempt = 0; attempt < 3 && Buffer.byteLength(text, "utf8") > maxBytes; attempt++) {
    const overflow = Buffer.byteLength(text, "utf8") - maxBytes;
    if (bodyBytes <= overflow) { bodyBytes = 0; bodyLines = 0; }
    else bodyBytes -= overflow;
    clipped = clipSpan(full, bodyBytes, bodyLines, keep);
    text = composePreview(clipped, hint, keep);
  }
  return {
    text,
    truncated: true,
    outputPath: spill.ok ? spill.path : "",
    ...(spill.ok ? {} : { failure: spill.error }),
    elidedBytes: clipped.elidedBytes,
    elidedLines: clipped.elidedLines,
    tokens,
  };
}

function composePreview(clipped: ClipSpan, hint: string, keep: "head" | "head-tail"): string {
  const marker = `... [${clipped.elidedBytes} bytes elided from the ${keep === "head" ? "end" : "middle"} of this output] ...`;
  const parts = keep === "head-tail"
    ? [clipped.head, marker, clipped.tail, hint]
    : [clipped.head, marker, hint];
  return parts.filter(part => part !== "").join("\n\n");
}

/** toolout.Bound. */
export function boundToolOutput(input: string, maxChars: number, maxLines: number): BoundResult {
  const buf = Buffer.from(input, "utf8");
  const originalLines = countLines(buf);
  const overChars = maxChars > 0 && buf.length > maxChars;
  const overLines = maxLines > 0 && originalLines > maxLines;
  if (!overChars && !overLines) return { output: input, head: input, tail: "", elidedChars: 0, elidedLines: 0, truncated: false };
  let headBudget = buf.length, tailBudget = buf.length;
  if (maxChars > 0) { headBudget = Math.floor((maxChars + 1) / 2); tailBudget = Math.floor(maxChars / 2); }
  let headEnd = utf8SafePrefixEnd(buf, headBudget);
  let tailStart = utf8SafeSuffixStart(buf, tailBudget);
  if (maxLines > 0) {
    if (maxLines === 1 && originalLines > 1) {
      headEnd = Math.min(headEnd, buf.indexOf(NL));
      tailStart = Math.max(tailStart, buf.lastIndexOf(NL) + 1);
    } else {
      headEnd = Math.min(headEnd, prefixEndForLines(buf, Math.floor((maxLines + 1) / 2)));
      tailStart = Math.max(tailStart, suffixStartForLines(buf, Math.floor(maxLines / 2)));
    }
  }
  if (headEnd > tailStart) headEnd = tailStart;
  const head = buf.subarray(0, headEnd).toString("utf8");
  const tail = buf.subarray(tailStart).toString("utf8");
  const output = head + tail;
  const elidedLines = Math.max(0, originalLines - countLines(Buffer.from(output, "utf8")));
  return { output, head, tail, elidedChars: tailStart - headEnd, elidedLines, truncated: tailStart - headEnd > 0 };
}

/**
 * agent_tools.go: the model-visible text for an oversized result, or undefined
 * when unchanged. Unlike the old in-place elision this persists the full text
 * first, so "narrower query" is no longer the only recovery path.
 */
export function boundOversizedToolOutput(
  output: string,
  options: RecoverableBoundOptions = {},
): RecoverableBound | undefined {
  const tokens = estimateOutputTokens(output);
  const lines = output.split("\n").length;
  if (tokens <= (options.maxTokens ?? toolOutputBudgetTokens()) && lines <= (options.maxLines ?? MAX_TOOL_OUTPUT_LINES)) return undefined;
  return boundToolTextWithRecovery(output, options);
}
