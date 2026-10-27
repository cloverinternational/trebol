import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

export type PatchKind = "add" | "update" | "delete";
/** One `@@`-delimited chunk of an update, following upstream UpdateFileChunk. */
export interface PatchChunk {
  changeContext?: string;
  oldLines: string[];
  newLines: string[];
  /** [oldIndex, newIndex] pairs for context lines, which keep their original bytes. */
  contextPairs: Array<[number, number]>;
  eof: boolean;
}
export interface PatchOp { kind: PatchKind; path: string; moveTo?: string; addBody: string; chunks: PatchChunk[] }
export interface ApplyPatchOptions { workspacePath?: string; cwd?: string; signal?: AbortSignal }

/**
 * Failure during sequential execution. Earlier operations are NOT rolled back;
 * `committed` lists what was written before the failing operation.
 */
export class ApplyPatchExecutionError extends Error {
  readonly committed: Array<{ tag: "A" | "M" | "D"; path: string; note?: string }>;
  constructor(message: string, committed: ApplyPatchExecutionError["committed"]) {
    super(message);
    this.name = "ApplyPatchExecutionError";
    this.committed = committed;
  }
}

// Markers and parser states mirror codex-rs/apply-patch/src/{parser,streaming_parser}.rs.
const BEGIN = "*** Begin Patch", END = "*** End Patch", EOF = "*** End of File";
const UPDATE = "*** Update File: ", DELETE = "*** Delete File: ", ADD = "*** Add File: ", MOVE = "*** Move to: ";
const ENVIRONMENT_ID = "*** Environment ID:";
const CHANGE_CONTEXT = "@@ ", EMPTY_CHANGE_CONTEXT = "@@";
const HEADERS = "Valid hunk headers: '*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'";

// Rust char::is_whitespace (White_Space property). JS trim() differs (e.g. BOM, NEL).
const RUST_WS = "\\t\\n\\u000B\\f\\r \\u0085\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000";
const LEADING_WS = new RegExp(`^[${RUST_WS}]+`), TRAILING_WS = new RegExp(`[${RUST_WS}]+$`);
const rtrimStart = (s: string) => s.replace(LEADING_WS, "");
const rtrimEnd = (s: string) => s.replace(TRAILING_WS, "");
const rtrim = (s: string) => rtrimEnd(rtrimStart(s));

const invalidPatch = (message: string) => new Error(`invalid patch: ${message}`);
const invalidHunk = (lineNumber: number, message: string) => new Error(`invalid hunk at line ${lineNumber}, ${message}`);
const unexpectedLine = (line: string) =>
  `Unexpected line found in update hunk: '${line}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)`;

/** Boundary check, including upstream's lenient `<<'EOF'` heredoc wrapper. */
function patchBodyLines(input: string): string[] {
  const trimmed = rtrim(input);
  const lines = trimmed === "" ? [] : trimmed.split("\n").map(l => (l.endsWith("\r") ? l.slice(0, -1) : l));
  const strict = (ls: string[]) => {
    const first = ls[0]?.trim(), last = ls.at(-1)?.trim();
    if (first === BEGIN && last === END) return ls;
    if (first !== undefined && first !== BEGIN) throw invalidPatch(`The first line of the patch must be '${BEGIN}'`);
    throw invalidPatch(`The last line of the patch must be '${END}'`);
  };
  try { return strict(lines); }
  catch (original) {
    if (lines.length >= 4 && (lines[0] === "<<EOF" || lines[0] === "<<'EOF'" || lines[0] === '<<"EOF"') && lines.at(-1)!.endsWith("EOF")) {
      return strict(lines.slice(1, -1));
    }
    throw original;
  }
}

/** Parse a V4A patch with upstream's streaming state machine (lenient mode). */
export function parsePatch(input: string): PatchOp[] {
  const lines = patchBodyLines(input);
  const ops: PatchOp[] = [];
  type Mode = "notStarted" | "started" | "add" | "delete" | "update" | "ended";
  const st: { mode: Mode; hunkLine: number } = { mode: "notStarted", hunkLine: 0 };
  const current = () => ops.at(-1)!;

  const ensureUpdateNotEmpty = (line: string, lineNo: number) => {
    const last = ops.at(-1);
    if (last?.kind === "update") {
      if (!last.chunks.length && st.mode === "update") throw invalidHunk(st.hunkLine, `Update file hunk for path '${last.path}' is empty`);
      const tail = last.chunks.at(-1);
      if (tail && !tail.oldLines.length && !tail.newLines.length) {
        throw invalidHunk(lineNo, line === END ? "Update hunk does not contain any lines" : unexpectedLine(line));
      }
    }
  };
  // Headers are matched on the already-trimmed (or trim_end'ed) line, as upstream does.
  const header = (s: string, lineNo: number): boolean => {
    if (s === END) { ensureUpdateNotEmpty(s, lineNo); st.mode = "ended"; return true; }
    if (s.startsWith(ADD)) { ensureUpdateNotEmpty(s, lineNo); ops.push({ kind: "add", path: s.slice(ADD.length), addBody: "", chunks: [] }); st.mode = "add"; return true; }
    if (s.startsWith(DELETE)) { ensureUpdateNotEmpty(s, lineNo); ops.push({ kind: "delete", path: s.slice(DELETE.length), addBody: "", chunks: [] }); st.mode = "delete"; return true; }
    if (s.startsWith(UPDATE)) {
      ensureUpdateNotEmpty(s, lineNo);
      ops.push({ kind: "update", path: s.slice(UPDATE.length), addBody: "", chunks: [] });
      st.mode = "update"; st.hunkLine = lineNo; return true;
    }
    return false;
  };
  const badHeader = (trimmed: string, lineNo: number) => invalidHunk(lineNo, `'${trimmed}' is not a valid hunk header. ${HEADERS}`);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i], lineNo = i + 1, trimmed = rtrim(line);
    // Upstream finish(): the final line is matched with a full trim before normal processing.
    if (i === lines.length - 1 && trimmed === END) { ensureUpdateNotEmpty(END, lineNo); st.mode = "ended"; break; }
    switch (st.mode) {
      case "notStarted":
        if (trimmed !== BEGIN) throw invalidPatch(`The first line of the patch must be '${BEGIN}'`);
        st.mode = "started";
        break;
      case "started":
        if (trimmed.startsWith(ENVIRONMENT_ID)) {
          throw invalidPatch("environment_id is not supported by the local apply_patch tool");
        }
        if (!header(trimmed, lineNo)) throw badHeader(trimmed, lineNo);
        break;
      case "add":
        if (header(trimmed, lineNo)) break;
        if (!line.startsWith("+")) throw badHeader(trimmed, lineNo);
        current().addBody += line.slice(1) + "\n";
        break;
      case "delete":
        if (!header(trimmed, lineNo)) throw badHeader(trimmed, lineNo);
        break;
      case "update":
        parseUpdateLine(line, lineNo);
        break;
      case "ended":
        if (trimmed !== "") throw invalidPatch(`The last line of the patch must be '${END}'`);
        break;
    }
  }
  if (st.mode !== "ended") throw invalidPatch(`The last line of the patch must be '${END}'`);
  return ops;

  function parseUpdateLine(line: string, lineNo: number) {
    const ul = rtrimEnd(line);
    if (header(ul, lineNo)) return;
    const op = current();
    const chunks = op.chunks;
    const tail = chunks.at(-1);
    if (tail?.eof) {
      if (ul === "") return;
      if (ul !== EMPTY_CHANGE_CONTEXT && !ul.startsWith(CHANGE_CONTEXT)) {
        throw invalidHunk(lineNo, `Expected update hunk to start with a @@ context marker, got: '${line}'`);
      }
    }
    if (!chunks.length && op.moveTo === undefined && ul.startsWith(MOVE)) { op.moveTo = ul.slice(MOVE.length); return; }
    const isMarker = ul === EMPTY_CHANGE_CONTEXT || ul.startsWith(CHANGE_CONTEXT);
    if (isMarker && tail && !tail.oldLines.length && !tail.newLines.length) throw invalidHunk(lineNo, unexpectedLine(line));
    if (ul === EMPTY_CHANGE_CONTEXT) { chunks.push(newChunk()); return; }
    if (ul.startsWith(CHANGE_CONTEXT)) { chunks.push({ ...newChunk(), changeContext: ul.slice(CHANGE_CONTEXT.length) }); return; }
    if (ul === EOF) {
      if (tail && !tail.oldLines.length && !tail.newLines.length) throw invalidHunk(lineNo, "Update hunk does not contain any lines");
      if (tail) tail.eof = true;
      return;
    }
    const target = () => { if (!chunks.length) chunks.push(newChunk()); return chunks.at(-1)!; };
    if (line === "") { pushContext(target(), ""); return; }
    if (line.startsWith(" ")) { pushContext(target(), line.slice(1)); return; }
    if (line.startsWith("+")) { target().newLines.push(line.slice(1)); return; }
    if (line.startsWith("-")) { target().oldLines.push(line.slice(1)); return; }
    if (tail && (tail.oldLines.length || tail.newLines.length)) {
      throw invalidHunk(lineNo, `Expected update hunk to start with a @@ context marker, got: '${line}'`);
    }
    throw invalidHunk(lineNo, unexpectedLine(line));
  }
}

const newChunk = (): PatchChunk => ({ oldLines: [], newLines: [], contextPairs: [], eof: false });
function pushContext(chunk: PatchChunk, line: string) {
  chunk.contextPairs.push([chunk.oldLines.length, chunk.newLines.length]);
  chunk.oldLines.push(line);
  chunk.newLines.push(line);
}

/** Upstream normalise(): Rust trim, then fold typographic punctuation and spaces to ASCII. */
function normalise(s: string): string {
  return rtrim(s).replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/[\u2018-\u201b]/g, "'")
    .replace(/[\u201c-\u201f]/g, '"')
    .replace(/[\u00a0\u2002-\u200a\u202f\u205f\u3000]/g, " ");
}

/**
 * Upstream seek_sequence: four passes (exact, trim_end, trim, normalise). The
 * first pass with any match wins and returns its first index; no ambiguity error.
 * With `eof`, only the position at end-of-file is considered.
 */
export function seekSequence(lines: string[], pattern: string[], start: number, eof: boolean): number | undefined {
  if (!pattern.length) return start;
  if (pattern.length > lines.length) return undefined;
  const last = lines.length - pattern.length;
  const searchStart = eof ? Math.max(last, start) : start;
  const passes: Array<(a: string, b: string) => boolean> = [
    (a, b) => a === b,
    (a, b) => rtrimEnd(a) === rtrimEnd(b),
    (a, b) => rtrim(a) === rtrim(b),
    (a, b) => normalise(a) === normalise(b),
  ];
  for (const same of passes) {
    for (let i = searchStart; i <= last; i++) {
      if (pattern.every((p, j) => same(lines[i + j], p))) return i;
    }
  }
  return undefined;
}

type Replacement = [start: number, oldLen: number, newLines: string[]];

/** Upstream compute_replacements: resolve every chunk against the original lines. */
function computeReplacements(original: string[], path: string, chunks: PatchChunk[]): Replacement[] {
  const replacements: Replacement[] = [];
  let lineIndex = 0;
  for (const chunk of chunks) {
    if (chunk.changeContext !== undefined) {
      const idx = seekSequence(original, [chunk.changeContext], lineIndex, false);
      if (idx === undefined) throw new Error(`Failed to find context '${chunk.changeContext}' in ${path}`);
      lineIndex = idx + 1;
    }
    if (!chunk.oldLines.length) {
      replacements.push([original.length, 0, chunk.newLines.slice()]);
      continue;
    }
    let pattern = chunk.oldLines, newSlice = chunk.newLines;
    let found = seekSequence(original, pattern, lineIndex, chunk.eof);
    if (found === undefined && pattern.at(-1) === "") {
      // Trailing empty line stands for the file's final newline; retry without it.
      pattern = pattern.slice(0, -1);
      if (newSlice.at(-1) === "") newSlice = newSlice.slice(0, -1);
      found = seekSequence(original, pattern, lineIndex, chunk.eof);
    }
    if (found === undefined) {
      throw new Error(`Failed to find expected lines in ${path}:\n${chunk.oldLines.join("\n")}`);
    }
    // Only changed spans are replaced; context lines keep their original text and ending.
    let oldStart = 0, newStart = 0;
    for (const [oldCtx, newCtx] of chunk.contextPairs) {
      if (oldCtx >= pattern.length || newCtx >= newSlice.length) break;
      if (oldStart !== oldCtx || newStart !== newCtx) {
        replacements.push([found + oldStart, oldCtx - oldStart, newSlice.slice(newStart, newCtx)]);
      }
      oldStart = oldCtx + 1;
      newStart = newCtx + 1;
    }
    if (oldStart !== pattern.length || newStart !== newSlice.length) {
      replacements.push([found + oldStart, pattern.length - oldStart, newSlice.slice(newStart)]);
    }
    lineIndex = found + pattern.length;
  }
  return replacements.sort((a, b) => a[0] - b[0]);
}

type LineEnding = "\n" | "\r\n" | "\r";
interface SourceLine { text: string; ending?: LineEnding }

/** Upstream SourceFile: split on LF, CRLF, and lone CR, retaining each ending. */
function parseSource(contents: string): { lines: SourceLine[]; preferred: LineEnding } {
  const lines: SourceLine[] = [];
  let preferred: LineEnding | undefined, start = 0, i = 0;
  while (i < contents.length) {
    const c = contents[i];
    if (c !== "\r" && c !== "\n") { i++; continue; }
    const ending: LineEnding = c === "\n" ? "\n" : contents[i + 1] === "\n" ? "\r\n" : "\r";
    preferred ??= ending;
    lines.push({ text: contents.slice(start, i), ending });
    i += ending.length;
    start = i;
  }
  if (start < contents.length) lines.push({ text: contents.slice(start) });
  return { lines, preferred: preferred ?? "\n" };
}

/** Upstream derive_new_contents_from_chunks, applied to in-memory text. */
export function applyChunks(original: string, path: string, chunks: PatchChunk[]): string {
  const source = parseSource(original);
  const replacements = computeReplacements(source.lines.map(l => l.text), path, chunks);
  const out: SourceLine[] = [];
  let sourceIndex = 0;
  for (const [start, oldLen, segment] of replacements) {
    if (start < sourceIndex) throw new Error(`update ${path}: overlapping replacements`);
    out.push(...source.lines.slice(sourceIndex, start));
    sourceIndex = start + oldLen;
    out.push(...segment.map(text => ({ text, ending: source.preferred })));
  }
  out.push(...source.lines.slice(sourceIndex));
  // Historical behavior: every resulting line terminates, including an unterminated final line.
  return out.map(l => l.text + (l.ending ?? source.preferred)).join("");
}

/** Raw bytes of a source path. Delete needs no text decoding (upstream deletes any file). */
function readSourceBytes(abs: string, requested: string): Buffer {
  if (!existsSync(abs)) throw new Error(`${requested}: file not found`);
  try { return readFileSync(abs); }
  catch (e) { throw new Error(`Failed to read ${requested}: ${(e as Error).message}`); }
}

/**
 * Strict UTF-8 read of an update source. Invalid bytes are rejected, not replaced.
 * A leading BOM is kept in the text (ignoreBOM), so it survives an update as upstream does.
 */
function readSource(abs: string, requested: string): string {
  const bytes = readSourceBytes(abs, requested);
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new Error(`${requested}: not valid UTF-8 text`); }
}

/** Resolve a patch path lexically against `base`, as upstream cwd.join(path). */
function resolvePatchPath(base: string, requested: string): string {
  if (!requested) throw new Error(`cannot resolve ${JSON.stringify(requested)}: empty path`);
  return isAbsolute(requested) ? resolve(requested) : resolve(base, requested);
}

/**
 * Agent verification (upstream verify_apply_patch_args): parse-time checks,
 * duplicate resolved source paths, and every update/delete validated against
 * the ORIGINAL on-disk state. Performs no writes.
 */
function verifyOps(ops: PatchOp[], cwd: string) {
  const seen = new Set<string>();
  for (const op of ops) {
    const abs = resolvePatchPath(cwd, op.path);
    if (seen.has(abs)) throw invalidPatch(`multiple operations target ${abs}`);
    seen.add(abs);
    // Upstream verification reads delete targets as UTF-8 text (writer execution does not).
    if (op.kind === "delete") readSource(abs, op.path);
    if (op.kind === "update") applyChunks(readSource(abs, op.path), op.path, op.chunks);
  }
}

/**
 * Sequential execution (upstream apply_hunks_to_files). Each operation re-reads
 * current disk state and writes immediately. Failure stops the patch; earlier
 * writes are not reverted.
 */
function executeOps(ops: PatchOp[], cwd: string): string {
  if (!ops.length) throw new ApplyPatchExecutionError("No files were modified.", []);
  const committed: ApplyPatchExecutionError["committed"] = [];
  const added: string[] = [], modified: string[] = [], deleted: string[] = [];
  const describe = (i: number, op: PatchOp, cause: unknown): never => {
    const lines = committed.map(c => `${c.tag} ${c.path}${c.note ? ` (${c.note})` : ""}\n`).join("");
    const after = committed.length
      ? `Changes already written were NOT rolled back:\n${lines}Revert them with git or a follow-up patch if needed.`
      : "No files were written before this failure.";
    const kind = op.moveTo ? "update+move" : op.kind;
    throw new ApplyPatchExecutionError(
      `apply_patch stopped at operation ${i + 1} of ${ops.length} (${kind} ${op.path}): ${(cause as Error).message}. ` +
      `That operation may be partially applied. ${after}`,
      committed,
    );
  };
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    try {
      const abs = resolvePatchPath(cwd, op.path);
      if (op.kind === "add") {
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, op.addBody);
        committed.push({ tag: "A", path: op.path }); added.push(op.path);
      } else if (op.kind === "delete") {
        const current = readSourceBytes(abs, op.path);
        rmSync(abs);
        committed.push({ tag: "D", path: op.path }); deleted.push(op.path);
      } else {
        const current = readSource(abs, op.path);
        const next = applyChunks(current, op.path, op.chunks);
        const dest = op.moveTo === undefined ? abs : resolvePatchPath(cwd, op.moveTo);
        if (dest === abs && op.moveTo === undefined) {
          writeFileSync(abs, next);
          committed.push({ tag: "M", path: op.path }); modified.push(op.path);
        } else {
          // A move onto its own source writes the destination, then removes the source: the file is deleted (upstream).
          mkdirSync(dirname(dest), { recursive: true });
          writeFileSync(dest, next);
          committed.push({ tag: "M", path: op.moveTo!, note: `source ${op.path} not yet removed` });
          modified.push(op.moveTo!);
          try { rmSync(abs); }
          catch (e) { committed[committed.length - 1].note = `source ${op.path} NOT removed: ${(e as Error).message}`; throw e; }
          committed[committed.length - 1].note = undefined;
        }
      }
    } catch (cause) {
      describe(i, op, cause);
    }
  }
  return "Success. Updated the following files:\n" +
    added.map(p => `A ${p}\n`).join("") + modified.map(p => `M ${p}\n`).join("") + deleted.map(p => `D ${p}\n`).join("");
}

/**
 * Agent tool path: validate the whole patch (no writes), then execute it
 * sequentially. Validation failures leave every file untouched. Execution
 * failures keep earlier writes and are reported as ApplyPatchExecutionError.
 */
export async function applyPatch(input: string, options: ApplyPatchOptions = {}): Promise<string> {
  const { ops, cwd } = prepare(input, options);
  verifyOps(ops, cwd);
  if (options.signal?.aborted) throw options.signal.reason ?? new Error("context canceled");
  return executeOps(ops, cwd);
}

/**
 * Standalone writer semantics (upstream apply_patch executable): parse and
 * execute sequentially with no up-front verification. Not used by the agent
 * tool; the parity runner uses it to compare against upstream fixtures.
 */
export async function applyPatchStandalone(input: string, options: ApplyPatchOptions = {}): Promise<string> {
  const { ops, cwd } = prepare(input, options);
  return executeOps(ops, cwd);
}

function prepare(input: string, options: ApplyPatchOptions) {
  if (options.signal?.aborted) throw options.signal.reason ?? new Error("context canceled");
  if (!input.trim()) throw new Error("input is required");
  const workspace = resolve(options.workspacePath ?? process.cwd());
  const cwd = options.cwd?.trim() ? resolve(options.cwd.trim()) : workspace;
  if (options.cwd?.trim()) {
    if (!existsSync(cwd)) throw new Error(`cwd ${JSON.stringify(options.cwd.trim())} is not usable: stat ${options.cwd.trim()}: no such file or directory`);
    if (!statSync(cwd).isDirectory()) throw new Error(`cwd ${JSON.stringify(options.cwd.trim())} is not a directory`);
  }
  const ops = parsePatch(input);
  return { ops, workspace, cwd };
}
