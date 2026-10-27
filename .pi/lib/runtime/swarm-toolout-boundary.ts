/**
 * General tool-output spillover at Pi's `tool_result` boundary.
 *
 * This middleware is installed as a plain Pi event handler, NOT through
 * `registerHook`, so it runs regardless of which Swarm hook groups are enabled
 * and regardless of the hook warm-up turn count. Task-enforcement hooks may be
 * off (`--no-hooks`, `PI_SWARM_NO_HOOKS=1`, `/hooks taskmanage off`) without
 * losing the bound or the recovery path.
 *
 * What it does, in order:
 *   1. Budgets the text blocks of one result together, using
 *      ceil(UTF-8 bytes / 4) against a configurable estimated-token budget and
 *      the existing line guard.
 *   2. Persists the complete text of every text block before clipping, so
 *      nothing the tool produced is lost to this boundary.
 *   3. Clips each text block (head and tail kept) and names the spill file in
 *      the model-facing text.
 *   4. Leaves every non-text block (images, etc.) untouched, never changes
 *      `isError`, and preserves `structuredContent` explicitly because Pi
 *      drops it whenever `content` is replaced without it.
 *
 * Limits: data a tool already discarded (its own truncation, ANSI stripping,
 * decoded-stream merging) cannot be recovered here, and the budget counts tool
 * text only — never images, structured content, or provider protocol overhead.
 */
import { rawPi } from "./swarm-tool-surface.ts";
import {
  MAX_TOOL_OUTPUT_LINES,
  NOTICE_RESERVE_CHARS,
  NOTICE_RESERVE_LINES,
  allocateBudget,
  boundToolTextWithRecovery,
  clipSpan,
  persistToolOutput,
  toolOutputBudgetTokens,
  type SpillIo,
} from "./swarm-toolout.ts";

type Pi = any;
const REGISTRY = Symbol.for("pi-swarm-toolout-boundary-registry");
const installed: WeakSet<object> = ((globalThis as any)[REGISTRY] ??= new WeakSet<object>());
const RETRIEVAL_HINT = "Use `sed -n 'START,ENDp' FILE` to view sections, or `rg PATTERN FILE` to search within it.";

export interface ToolOutputSpillOptions {
  /** Estimated-token budget; defaults to PI_SWARM_TOOL_OUTPUT_TOKENS or 25,000. */
  maxTokens?: number;
  /** Line guard; defaults to 1,000. */
  maxLines?: number;
  /** Spill file prefix; defaults to "tool-full-". */
  prefix?: string;
  /** Temp root override (tests). */
  root?: string;
  /** Filesystem seam (tests). */
  io?: SpillIo;
  env?: NodeJS.ProcessEnv;
}

export interface BoundedTextBlocks {
  texts: string[];
  truncated: boolean;
  outputPath: string;
  failure?: string;
  elidedBytes: number;
  elidedLines: number;
}

const byteLength = (text: string) => Buffer.byteLength(text, "utf8");
const lineCount = (text: string) => (text === "" ? 0 : text.split("\n").length);

/**
 * Persist the aggregate, then clip every text block. A single block reuses the
 * shared helper so its preview shape matches the Bash spill path.
 */
export function boundTextBlocks(texts: string[], options: ToolOutputSpillOptions = {}): BoundedTextBlocks {
  const maxTokens = options.maxTokens ?? toolOutputBudgetTokens(options.env);
  const maxLines = options.maxLines ?? MAX_TOOL_OUTPUT_LINES;
  const maxBytes = Math.max(0, maxTokens) * 4;
  const sizes = texts.map(byteLength);
  const lines = texts.map(lineCount);
  const totalBytes = sizes.reduce((sum, size) => sum + size, 0);
  const totalLines = lines.reduce((sum, count) => sum + count, 0);
  if (totalBytes <= maxBytes && totalLines <= maxLines) {
    return { texts, truncated: false, outputPath: "", elidedBytes: 0, elidedLines: 0 };
  }
  if (texts.length === 1) {
    const bounded = boundToolTextWithRecovery(texts[0]!, {
      maxTokens, maxLines, keep: "head-tail",
      prefix: options.prefix ?? "tool-full-", root: options.root, io: options.io,
    });
    return {
      texts: [bounded.text], truncated: true, outputPath: bounded.outputPath,
      ...(bounded.failure ? { failure: bounded.failure } : {}),
      elidedBytes: bounded.elidedBytes, elidedLines: bounded.elidedLines,
    };
  }
  const spill = persistToolOutput(texts.join("\n\n"), { prefix: options.prefix ?? "tool-full-", root: options.root, io: options.io });
  const hint = spill.ok
    ? `Full output saved to: ${spill.path}\n${RETRIEVAL_HINT}`
    : `Full output could not be saved (${spill.error}); re-run a narrower command or query to see more.`;
  let bodyBytes = Math.max(0, maxBytes - NOTICE_RESERVE_CHARS);
  let bodyLines = Math.max(0, maxLines - NOTICE_RESERVE_LINES - texts.length * 3);
  let clipped = clipBlocks(texts, bodyBytes, bodyLines);
  let composed = composeBlocks(clipped, hint, totalBytes, totalLines, texts.length);
  for (let attempt = 0; attempt < 3 && composed.bytes > maxBytes; attempt++) {
    const overflow = composed.bytes - maxBytes;
    if (bodyBytes <= overflow) { bodyBytes = 0; bodyLines = 0; }
    else bodyBytes -= overflow;
    clipped = clipBlocks(texts, bodyBytes, bodyLines);
    composed = composeBlocks(clipped, hint, totalBytes, totalLines, texts.length);
  }
  return {
    texts: composed.texts,
    truncated: true,
    outputPath: spill.ok ? spill.path : "",
    ...(spill.ok ? {} : { failure: spill.error }),
    elidedBytes: composed.elidedBytes,
    elidedLines: composed.elidedLines,
  };
}

const clipBlocks = (texts: string[], bodyBytes: number, bodyLines: number) => {
  const byteShares = allocateBudget(texts.map(byteLength), bodyBytes);
  const lineShares = allocateBudget(texts.map(lineCount), bodyLines);
  return texts.map((text, index) => clipSpan(text, byteShares[index]!, lineShares[index]!));
};

function composeBlocks(
  clipped: ReturnType<typeof clipBlocks>,
  hint: string,
  totalBytes: number,
  totalLines: number,
  blockCount: number,
): { texts: string[]; bytes: number; elidedBytes: number; elidedLines: number } {
  const keptBytes = clipped.reduce((sum, part) => sum + byteLength(part.head) + byteLength(part.tail), 0);
  const keptLines = clipped.reduce((sum, part) => sum + lineCount(part.head) + lineCount(part.tail), 0);
  const elidedBytes = Math.max(0, totalBytes - keptBytes);
  const elidedLines = Math.max(0, totalLines - keptLines);
  const notice = `... [${elidedBytes} bytes elided from the middle of this output` +
    `${blockCount > 1 ? ` across ${blockCount} text blocks` : ""}] ...\n\n${hint}`;
  const texts = clipped.map(part => [part.head, part.tail].filter(text => text !== "").join("\n\n"));
  // One notice at the end of the last text block: the marker explains every
  // block that was clipped without adding a separate message part.
  const last = texts.length - 1;
  texts[last] = [texts[last], notice].filter(text => text !== "").join("\n\n");
  return { texts, bytes: texts.reduce((sum, text) => sum + byteLength(text), 0), elidedBytes, elidedLines };
}

export interface ToolResultPatch { content: any[]; structuredContent?: unknown }

/**
 * The middleware body: returns a Pi `tool_result` patch, or undefined when the
 * result is unchanged. Images, other non-text blocks, details, and the error
 * status pass through untouched.
 */
export function spillToolResultEvent(event: any, options: ToolOutputSpillOptions = {}): ToolResultPatch | undefined {
  const raw = event?.content;
  const content = Array.isArray(raw)
    ? raw
    : typeof raw === "string" ? [{ type: "text", text: raw }] : undefined;
  if (!content?.length) return undefined;
  const textIndexes = content.map((block: any, index: number) => (block?.type === "text" && typeof block.text === "string" ? index : -1)).filter(index => index >= 0);
  if (!textIndexes.length) return undefined;
  const bounded = boundTextBlocks(textIndexes.map(index => content[index].text as string), options);
  if (!bounded.truncated) return undefined;
  const next = content.slice();
  textIndexes.forEach((blockIndex, order) => { next[blockIndex] = { ...next[blockIndex], text: bounded.texts[order]! }; });
  // Pi applies content replacement by clearing structuredContent unless the
  // handler returns it explicitly, so keep it when the tool produced any.
  return { content: next, ...(event?.structuredContent === undefined ? {} : { structuredContent: event.structuredContent }) };
}

/**
 * Install the middleware once per Pi instance. Registered directly on the
 * `tool_result` event: no hook group gate, no warm-up gate, no task state.
 */
export function installToolOutputSpill(pi: Pi, options: ToolOutputSpillOptions = {}): void {
  if (!pi?.on) return;
  const owner = rawPi(pi as object);
  if (installed.has(owner)) return;
  installed.add(owner);
  pi.on("tool_result", (event: any) => spillToolResultEvent(event, options));
}
