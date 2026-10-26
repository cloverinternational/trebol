/**
 * TypeScript port of swarm-tui/internal/bgprocess.  Presentation stays next to
 * the process state because ReadBackgroundCommand's output is a wire contract,
 * not merely diagnostics.
 *
 * That contract now has two renderings of the same state: the default `text`
 * view (a few header rows plus the line window, ~5x smaller than the JSON for
 * the same content) and the original `json` shape, kept byte-identical for
 * swarm-tui parity and for per-line timestamps/streams when a caller needs them.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { accessSync, constants, existsSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WAIT_DELAY_MS, decodeSignalExit, signalNote, stripANSI, type BashParams } from "./swarm-bash.ts";
import { patchRunningWork, setRunningWork } from "../ui/running-work.ts";
import { boundToolOutput } from "../runtime/swarm-toolout.ts";

export type ProcessState = "running" | "completed" | "failed" | "cancelled";
export interface BackgroundLine {
  line_number: number;
  timestamp: string;
  stream: "stdout" | "stderr";
  content: string;
}
interface ProcessRecord {
  id: string;
  owner?: () => boolean;
  command: string;
  cwd: string;
  env: Record<string, string>;
  state: ProcessState;
  child: ChildProcess;
  pid: number;
  startedMs: number;
  endedMs?: number;
  exitCode?: number;
  signal?: NodeJS.Signals | null;
  lines: BackgroundLine[];
  bytesWritten: number;
  stdout: string;
  stderr: string;
  /** Bytes read from the child but not yet turned into lines (executor.go polls every 50ms). */
  pendingStdout: Buffer[];
  pendingStderr: Buffer[];
  /** A poll left a line still open on this stream; its terminating newline may arrive next. */
  openLine: { stdout: { open: boolean }; stderr: { open: boolean } };
  completion: Promise<void>;
  /** Resolves once the child has spawned or failed to (Node reports both asynchronously). */
  spawned: Promise<Error | undefined>;
  spawnError?: Error;
  backgrounded: boolean;
  /** Full-output temp file, written once per growth of `lines` (see outputFileFor). */
  outputFile?: string;
  outputFileLines?: number;
}

export interface BackgroundBashParams extends BashParams { background?: boolean }
export const BACKGROUND_BASH_DETACH = Symbol.for("pi-swarm-background-bash-detach");
export interface ReadBackgroundParams {
  task_id?: string;
  action?: string;
  from_line?: number;
  max_lines?: number;
  pattern?: string;
  stream?: string;
  /** "text" (default) is the compact model-facing view; "json" is the swarm-tui wire shape. */
  format?: string;
}
export interface ToolText { text: string; details?: Record<string, unknown> }
/** app_init.go completion/error callbacks → app_update.go bgProcessDoneMsg. */
export interface BackgroundDone { id: string; command: string; state: ProcessState; exitCode: number; outputPreview: string; outputTruncated: boolean }

/** sdk_integration.go: DefaultTimeout for the interactive bgprocess Bash tool. */
export const DEFAULT_BASH_TIMEOUT_SECONDS = 5 * 60;
const BG_OUTPUT_PREVIEW_MAX_BYTES = 4096;

/** app_update.go bgOutputPreview (byte-based head/tail). */
export function bgOutputPreview(output: Buffer | string): { preview: string; truncated: boolean } {
  const bytes = Buffer.isBuffer(output) ? output : Buffer.from(output, "utf8");
  if (bytes.length === 0) return { preview: "", truncated: false };
  if (bytes.length <= BG_OUTPUT_PREVIEW_MAX_BYTES) return { preview: bytes.toString("utf8"), truncated: false };
  const half = BG_OUTPUT_PREVIEW_MAX_BYTES / 2;
  return { preview: `${bytes.subarray(0, half).toString("utf8")}\n\n... [truncated ${bytes.length - BG_OUTPUT_PREVIEW_MAX_BYTES} bytes] ...\n\n${bytes.subarray(bytes.length - half).toString("utf8")}`, truncated: true };
}

/** Byte-bounded one-line preview of a command, with the ellipsis inside the budget. */
export function clipCommand(command: string, maxBytes: number): string {
  if (Buffer.byteLength(command) <= maxBytes) return command;
  return `${Buffer.from(command).subarray(0, maxBytes - 3).toString("utf8")}...`;
}

/** app_update.go bgProcessDoneMsg → the "[BACKGROUND] …" notification text. */
export function formatBackgroundDone(done: BackgroundDone): string {
  let statusDesc: string;
  switch (done.state) {
    case "completed": statusDesc = `Background command completed successfully (exit code ${done.exitCode})`; break;
    case "failed": statusDesc = `Background command failed (exit code ${done.exitCode})`; break;
    default: statusDesc = `Background command ${done.state}`;
  }
  const cmdPreview = clipCommand(done.command, 120);
  const outputSection = done.outputPreview !== "" ? `\n\noutput:\n${done.outputPreview}` : "";
  const followup = done.outputTruncated ? ` Output truncated above — call ReadBackgroundCommand with task_id ${JSON.stringify(done.id)} for the full text.` : "";
  return `[BACKGROUND] task_id=${done.id} command=${cmdPreview} status=${done.state}${outputSection}\n\n${statusDesc}.${followup}`;
}

/** Go os/exec ExitError.Error() for a non-zero exit, as stored in ProcessResult.Error. */
const goExitStatus = (code: number, signal: NodeJS.Signals | null) => signal ? `signal: ${signal.toLowerCase().replace(/^sig/, "")}` : `exit status ${code}`;

/**
 * First runnable executable named `name` on PATH, or "" when unavailable.
 *
 * access(X_OK) is not enough: execve also returns ENOENT when the file exists
 * but its ELF/shebang interpreter does not. Optional buffering wrappers must
 * never make Bash unusable, so probe that the process can actually start.
 * The exit status is irrelevant; BSD and GNU variants expose different flags.
 */
function runnableOnPath(name: string): string {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      const probe = spawnSync(candidate, ["--version"], { stdio: "ignore", timeout: 1000 });
      if (!probe.error) return candidate;
    } catch { /* keep looking */ }
  }
  return "";
}

const shellQuote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;

/**
 * bash_cmd_builder.go detectBufferingMethod, with the tiers ordered by what
 * actually delivers incremental output (measured, stdout is a pipe):
 *
 *   program           direct      stdbuf -oL   script (PTY)
 *   C / libc stdio    streams     streams      streams
 *   python3, node     1 chunk     1 chunk      streams
 *
 * `stdbuf` only retunes libc's buffer, so runtimes that buffer above libc
 * (python, node) still withhold everything until exit. A PTY makes the child
 * believe it is interactive, which is the only tier that fixes those — and
 * long-running python jobs are exactly what the caller wants to watch. So
 * prefer `script`, keep `stdbuf` as the fallback, then direct.
 *
 * `-e` is required: without it `script` exits 0 even when the command failed.
 * A PTY has one stream, so stderr arrives interleaved on stdout and newlines
 * arrive as CRLF; callers must normalize (see ptyNewlines).
 */
export interface BufferingMethod { argv: string[]; pty: boolean }
export function detectBufferingMethod(shell: string, command: string): BufferingMethod {
  const script = runnableOnPath("script");
  // util-linux `script -q -e -c "<cmd>" /dev/null`. The BSD/macOS argument
  // order differs (`script -q /dev/null <shell> -c <cmd>`), and its -e is
  // implicit, so only take this path on Linux.
  if (script && process.platform === "linux") {
    return { argv: [script, "-q", "-e", "-c", `${shellQuote(shell)} -c ${shellQuote(command)}`, "/dev/null"], pty: true };
  }
  if (process.platform === "darwin") {
    // BSD script echoes EOF and loses signal status. Use an output-only PTY
    // without feeding terminal input; keep child and runner in our process group.
    const python = runnableOnPath("python3");
    if (python) return { argv: [python, fileURLToPath(new URL("./pty-runner.py", import.meta.url)), shell, "-c", command], pty: true };
  }
  const stdbuf = runnableOnPath("stdbuf");
  if (stdbuf) return { argv: [stdbuf, "-oL", "-eL", shell, "-c", command], pty: false };
  return { argv: [shell, "-c", command], pty: false };
}

/** A PTY reports every newline as CRLF; restore normal line endings. */
export const ptyNewlines = (text: string) => text.includes("\r") ? text.replaceAll("\r\n", "\n") : text;

/**
 * Line accumulator for one stream's 50ms polls. A poll can read a partial line,
 * so the chunk after it may begin with the newline that terminates it; that
 * newline closes the open line and must not add an empty one. Without this the
 * stored output of `echo hi` depends on where the pipe split ("hi\n" one chunk
 * vs "hi" then "\n"), which made the background-bash tests flaky and added a
 * phantom blank line to real command output.
 */
export function takeLines(state: { open: boolean }, text: string): string[] {
  const lines: string[] = [];
  let start = 0;
  if (state.open && text.startsWith("\n")) { start = 1; state.open = false; }
  for (let i = start; i < text.length; i++) {
    if (text[i] !== "\n") continue;
    lines.push(text.slice(start, i));
    start = i + 1;
  }
  if (start < text.length) { lines.push(text.slice(start)); state.open = true; }
  return lines;
}
/** executor.go detectShell (unix). */
const detectShell = () => process.env.SHELL || (existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh");

/** time.Duration.String for positive durations used by this tool. */
export function goDuration(seconds: number): string {
  let ns = Math.trunc(seconds * 1e9);
  const h = Math.floor(ns / 3_600_000_000_000); ns -= h * 3_600_000_000_000;
  const m = Math.floor(ns / 60_000_000_000); ns -= m * 60_000_000_000;
  const s = Math.floor(ns / 1_000_000_000); ns -= s * 1_000_000_000;
  let fraction = "";
  if (ns) fraction = `.${String(ns).padStart(9, "0").replace(/0+$/, "")}`;
  if (h) return `${h}h${m}m${s}${fraction}s`;
  if (m) return `${m}m${s}${fraction}s`;
  return `${s}${fraction}s`;
}

const pad2 = (n: number) => String(n).padStart(2, "0");
const goZone = (date: Date) => { const offset = -date.getTimezoneOffset(); return offset === 0 ? "Z" : `${offset > 0 ? "+" : "-"}${pad2(Math.floor(Math.abs(offset) / 60))}:${pad2(Math.abs(offset) % 60)}`; };
const goLocalDate = (date: Date) => `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
const goLocalClock = (date: Date) => `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
/** time.Now() is local; Format(time.RFC3339) keeps the local offset (no fraction). */
const rfc3339 = (ms: number) => { const d = new Date(ms); return `${goLocalDate(d)}T${goLocalClock(d)}${goZone(d)}`; };
/** time.Time.MarshalJSON: RFC3339Nano, local offset, trailing fraction zeros trimmed (JS has millis). */
const rfc3339Nano = (ms: number) => { const d = new Date(ms); const frac = d.getMilliseconds() ? `.${String(d.getMilliseconds()).padStart(3, "0").replace(/0+$/, "")}` : ""; return `${goLocalDate(d)}T${goLocalClock(d)}${frac}${goZone(d)}`; };
/** encoding/json escapes <, >, & (HTML-safe by default) and U+2028/U+2029; JSON.stringify does not. */
export const goJSON = (value: unknown, indent?: number) => JSON.stringify(value, null, indent)
  .replace(/[<>&\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
const jsonIndent = (value: unknown) => goJSON(value, 2);

function regexpError(pattern: string, error: unknown): string {
  // Go uses RE2. Cover its stable parser wording for the malformed forms most
  // often returned by model calls; otherwise preserve the JS parser reason.
  if (pattern === "[") return "error parsing regexp: missing closing ]: `[`";
  if (pattern.endsWith("\\")) return `error parsing regexp: trailing backslash at end of expression: \`${pattern}\``;
  const reason = String((error as Error)?.message ?? error).replace(/^Invalid regular expression: \/.+\/: /, "");
  return `error parsing regexp: ${reason}`;
}

export const SNAPSHOT_TAIL_LINES = 20;
/** Default and maximum lines one ReadBackgroundCommand read may return. */
export const DEFAULT_READ_LINES = 100;
export const MAX_READ_LINES = 1000;
/**
 * Model-facing byte budget for one text read (~3k tokens). A log line can be
 * arbitrarily long (a minified bundle, a one-line JSON document), so the line
 * window alone does not bound the payload; the middle is elided instead.
 */
export const MAX_READ_BYTES = 12_288;
const OUTPUT_FILE_PREFIX = "bgprocess-output-";
const OUTPUT_FILE_TTL_MS = 24 * 60 * 60 * 1000;
/** Read-only status view of one background command. Unknown id → undefined; finished items keep their terminal state. */
export interface BackgroundSnapshot {
  task_id: string;
  status: ProcessState;
  command: string;
  started_at: number;
  ended_at?: number;
  exit_code?: number;
  /** Last SNAPSHOT_TAIL_LINES complete lines seen by the last poll; empty when no output yet. */
  output_tail: string[];
}

export class SwarmBackgroundProcessManager {
  private readonly processes = new Map<string, ProcessRecord>();
  private doneListeners: Array<(done: BackgroundDone) => void> = [];
  private foreground?: { rec: ProcessRecord; detach: () => void };

  constructor() { this.pruneOutputFiles(); }

  /**
   * Every truncated read leaves a full-output file behind, and no session reads
   * them all back. Sweep yesterday's copies once, before the first read, so
   * tmpdir does not accumulate one file per background command forever.
   */
  private pruneOutputFiles(): void {
    const cutoff = Date.now() - OUTPUT_FILE_TTL_MS;
    try {
      for (const name of readdirSync(tmpdir())) {
        if (!name.startsWith(OUTPUT_FILE_PREFIX) || !name.endsWith(".txt")) continue;
        const path = join(tmpdir(), name);
        try { if (statSync(path).mtimeMs < cutoff) unlinkSync(path); } catch { /* raced with another sweep */ }
      }
    } catch { /* unreadable tmpdir: nothing to prune */ }
  }

  /**
   * Full process output on disk, rewritten only when new lines arrived. The
   * rewrite on every truncated read made repeated polls of a chatty command
   * cost a full file write each time, so the written line count is remembered.
   */
  private outputFileFor(rec: ProcessRecord): string {
    if (rec.outputFile && rec.outputFileLines === rec.lines.length) return rec.outputFile;
    const path = join(tmpdir(), `${OUTPUT_FILE_PREFIX}${rec.id.replace(/[/: ]/g, "-")}.txt`);
    try {
      writeFileSync(path, rec.lines.map(x => `${x.content}\n`).join(""), { mode: 0o644 });
      rec.outputFile = path;
      rec.outputFileLines = rec.lines.length;
      return path;
    } catch { return ""; }
  }

  /** manager.go SetCompletionCallback/SetErrorCallback, already shaped like bgProcessDoneMsg. */
  onDone(listener: (done: BackgroundDone) => void): void { this.doneListeners.push(listener); }
  /** Running-work writes from a process launched in a previous session are dropped. */
  private captureOwner?: () => () => boolean;
  setOwnerCapture(capture: () => () => boolean): void { this.captureOwner = capture; }
  private ownsSession(rec?: ProcessRecord): boolean { return rec?.owner ? rec.owner() : true; }
  requestBackground(): boolean {
    if (!this.foreground || this.foreground.rec.state !== "running") return false;
    this.markBackgrounded(this.foreground.rec);
    this.foreground.detach();
    return true;
  }
  /** The tool call stops waiting: the work now belongs to the background-work views, not the turn. */
  private markBackgrounded(rec: ProcessRecord): void {
    rec.backgrounded = true;
    if (this.ownsSession(rec)) patchRunningWork(rec.id, { foreground: false });
  }
  private emitDone(done: BackgroundDone): void { for (const listener of this.doneListeners) { try { listener(done); } catch { /* UI side effect */ } } }
  /** manager.go handleStateChange: only backgrounded processes notify. */
  private notifyTerminal(rec: ProcessRecord): void {
    if (!rec.backgrounded) return;
    if (rec.state === "failed") {
      // onError receives result.Error (the exec error), not the output.
      const error = rec.spawnError ? rec.spawnError.message : goExitStatus(rec.exitCode ?? -1, rec.signal ?? null);
      this.emitDone({ id: rec.id, command: rec.command, state: "failed", exitCode: rec.exitCode ?? -1, outputPreview: bgOutputPreview(error).preview, outputTruncated: false });
      return;
    }
    const { preview, truncated } = bgOutputPreview(this.outputBytes(rec));
    this.emitDone({ id: rec.id, command: rec.command, state: rec.state, exitCode: (rec.exitCode ?? -1) >= 0 ? rec.exitCode! : -1, outputPreview: preview, outputTruncated: truncated });
  }
  /** executor.go Wait: every tailed line + "\n", in arrival order. */
  private outputBytes(rec: ProcessRecord): Buffer { return Buffer.from(rec.lines.map(line => `${line.content}\n`).join(""), "utf8"); }

  private newID(): string {
    // Date.now has only millisecond resolution; hrtime supplies the sub-ms
    // digits needed by Go's bg-<UnixNano>-<pid> identifier.
    const nano = BigInt(Date.now()) * 1_000_000n + process.hrtime.bigint() % 1_000_000n;
    return `bg-${nano}-${process.pid}`;
  }

  /**
   * executor.go tailOutputFile/readFileChunk: each 50ms poll reads whatever
   * the child wrote since the last poll and splits THAT chunk into lines, so a
   * partial line and its continuation across polls become two lines. The
   * stderr tailer (started last) consistently reads first on the final flush.
   */
  private poll(rec: ProcessRecord): void {
    for (const stream of ["stderr", "stdout"] as const) {
      const pending = stream === "stdout" ? rec.pendingStdout : rec.pendingStderr;
      if (!pending.length) continue;
      const chunk = Buffer.concat(pending.splice(0));
      this.append(rec, stream, chunk);
    }
  }

  private append(rec: ProcessRecord, stream: "stdout" | "stderr", chunk: Buffer): void {
    const text = chunk.toString("utf8");
    if (stream === "stdout") rec.stdout += text; else rec.stderr += text;
    // Go's tailer turns every read fragment into one or more OutputLines and
    // excludes newline bytes from Size(). A fragment boundary inside a line must
    // not turn its terminator into a line of its own; see takeLines.
    for (const content of takeLines(rec.openLine[stream], text)) {
      this.addLine(rec, stream, content);
    }
  }

  private addLine(rec: ProcessRecord, stream: "stdout" | "stderr", content: string): void {
    rec.lines.push({ line_number: rec.lines.length + 1, timestamp: rfc3339Nano(Date.now()), stream, content });
    rec.bytesWritten += Buffer.byteLength(content);
  }

  spawn(params: BackgroundBashParams, defaultCwd: string): ProcessRecord {
    const command = typeof params.command === "string" ? params.command : "";
    // executor.go only sets cmd.Dir when WorkDir != "": the process otherwise
    // inherits the TUI's own working directory.
    const cwd = params.cwd ? resolve(params.cwd) : defaultCwd;
    const env = Object.fromEntries(Object.entries(params.env ?? {}).filter((x): x is [string, string] => typeof x[1] === "string"));
    const id = this.newID();
    const startedMs = Date.now();
    const shell = detectShell();
    const buffering = detectBufferingMethod(shell, command);
    const argv = buffering.argv;
    const child = spawn(argv[0], argv.slice(1), { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
    let finish!: () => void;
    const completion = new Promise<void>(r => { finish = r; });
    let settleSpawn!: (error: Error | undefined) => void;
    const spawned = new Promise<Error | undefined>(r => { settleSpawn = r; });
    const rec: ProcessRecord = {
      owner: this.captureOwner?.(),
      id, command, cwd: params.cwd ?? "", env, state: "running", child, pid: child.pid ?? 0,
      startedMs, lines: [], bytesWritten: 0, stdout: "", stderr: "", pendingStdout: [], pendingStderr: [], openLine: { stdout: { open: false }, stderr: { open: false } }, completion, spawned, backgrounded: false,
    };
    this.processes.set(id, rec);
    // The drawer inspects running commands live: drain any buffered chunks
    // first so Enter shows output written since the last 50ms poll tick.
    const readOutput = () => { this.poll(rec); return rec.lines.slice(-160).map(line => line.content).join("\n"); };
    if (this.ownsSession(rec)) setRunningWork({ id, kind: "bash", label: params.description || "Background Bash", status: "running", startedAt: startedMs, detail: command, readOutput, foreground: params.background !== true });
    // Under a PTY the child sees one terminal, so stderr is interleaved into
    // stdout and every newline arrives as CRLF. Strip the CR so stored lines,
    // regex filters and byte counts match the non-PTY tiers.
    const normalize = buffering.pty
      ? (d: Buffer) => Buffer.from(ptyNewlines(d.toString("utf8")), "utf8")
      : (d: Buffer) => d;
    child.stdout?.on("data", (d: Buffer) => rec.pendingStdout.push(normalize(d)));
    child.stderr?.on("data", (d: Buffer) => rec.pendingStderr.push(normalize(d)));
    const poller = setInterval(() => this.poll(rec), 50);
    poller.unref?.();
    child.once("spawn", () => settleSpawn(undefined));
    child.on("error", (error: NodeJS.ErrnoException) => {
      // Go reports a missing binary/cwd as os.PathError from fork/exec against
      // the resolved executable; the manager drops the record (Spawn fails).
      const reason = error.code === "ENOENT" ? "no such file or directory" : error.code === "EACCES" ? "permission denied" : (error.message ?? String(error));
      rec.spawnError = new Error(`execute [${id}]: failed to start command: fork/exec ${argv[0]}: ${reason}`);
      rec.endedMs = Date.now(); rec.exitCode = -1;
      if (rec.state !== "cancelled") rec.state = "failed";
      this.processes.delete(id);
      clearInterval(poller);
      settleSpawn(rec.spawnError);
      finish();
    });
    // "close" waits for every pipe holder, which a background child that
    // inherited stdout defers indefinitely (Go issue #21922; bash.go caps this
    // with cmd.WaitDelay). Settle on whichever of close/exit comes first, after
    // a short grace period for output still in flight.
    let settled = false;
    let waitDelay: ReturnType<typeof setTimeout> | undefined;
    const settle = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearInterval(poller);
      if (waitDelay) clearTimeout(waitDelay);
      this.poll(rec);
      rec.endedMs = Date.now();
      // Under the PTY tier `script` reports a signalled shell as 128+signal.
      const outcome = buffering.pty ? decodeSignalExit(code, signal) : { exitCode: code ?? (signal ? -1 : 0), signal };
      rec.signal = outcome.signal;
      rec.exitCode = outcome.exitCode;
      if (rec.state !== "cancelled") rec.state = rec.exitCode === 0 ? "completed" : "failed";
      if (this.ownsSession(rec)) setRunningWork({ id: rec.id, kind: "bash", label: rec.command, status: rec.state, startedAt: rec.startedMs, endedAt: rec.endedMs, detail: rec.command, output: rec.lines.slice(-12).map(line => line.content).join("\n") });
      finish();
      this.notifyTerminal(rec);
    };
    child.on("close", (code, signal) => settle(code, signal));
    child.on("exit", (code, signal) => {
      waitDelay = setTimeout(() => settle(code, signal), WAIT_DELAY_MS);
      waitDelay.unref?.();
    });
    return rec;
  }

  /**
   * bash_tool.go ExecuteStreaming — the entry point the SDK agent uses for
   * StreamingTools, so (unlike Execute) a missing timeout_seconds is not an
   * error: it falls back to DefaultTimeout (5 minutes).
   */
  async executeBash(params: BackgroundBashParams, defaultCwd: string, signal?: AbortSignal): Promise<ToolText> {
    if (typeof params?.command !== "string" || params.command === "") throw new Error("command is required");
    let timeoutSec = typeof params?.timeout_seconds === "number" ? params.timeout_seconds : 0;
    if (!(timeoutSec > 0)) timeoutSec = DEFAULT_BASH_TIMEOUT_SECONDS;
    // AllowExplicitBackground is false in sdk_integration.go. The unadvertised
    // background member is consequently ignored, exactly as encoding/json does.
    let rec: ProcessRecord;
    try { rec = this.spawn(params, defaultCwd); }
    catch (e) { throw new Error(`failed to spawn process: ${String((e as Error).message ?? e)}`); }
    const spawnError = await rec.spawned;
    if (spawnError) {
      // manager.go Spawn: onError fires for the failed start (TUI queues a
      // "[BACKGROUND] … status=failed" system notification), then the error.
      this.emitDone({ id: rec.id, command: rec.command, state: "failed", exitCode: -1, outputPreview: bgOutputPreview(spawnError.message).preview, outputTruncated: false });
      throw new Error(`failed to spawn process: ${spawnError.message}`);
    }

    // Explicit background mode returns immediately, matching BackgroundTask's
    // async contract. The process remains tracked by ReadBackgroundCommand and
    // emits its normal completion notification when it exits.
    if (params.background === true) {
      this.markBackgrounded(rec);
      return { text: goJSON({
        backgrounded: true,
        message: "Command launched in the background. Use ReadBackgroundCommand with task_id to monitor output or cancel it.",
        status: "running",
        task_id: rec.id,
        timeout_seconds: timeoutSec,
      }), details: { task_id: rec.id, command: rec.command, background: true, background_reason: "explicit" } };
    }

    const idle = new Promise<"idle">(resolveIdle => {
      let lastSize = -1;
      let lastChange = Date.now();
      const intervalMs = Math.min(1000, timeoutSec * 250);
      const timer = setInterval(() => {
        if (rec.state !== "running") return clearInterval(timer);
        if (lastSize < 0 || rec.bytesWritten > lastSize) {
          lastSize = rec.bytesWritten; lastChange = Date.now(); return;
        }
        if (Date.now() - lastChange >= timeoutSec * 1000) {
          clearInterval(timer); resolveIdle("idle");
        }
      }, intervalMs);
      rec.completion.finally(() => clearInterval(timer));
    });
    const aborted = new Promise<"abort">(r => signal?.addEventListener("abort", () => r("abort"), { once: true }));
    let detach!: () => void;
    const detached = new Promise<"background">(resolve => { detach = () => resolve("background"); });
    this.foreground = { rec, detach };
    const winner = await Promise.race([rec.completion.then(() => "done" as const), idle, aborted, detached]);
    if (this.foreground?.rec === rec) this.foreground = undefined;
    if (winner === "abort") {
      await this.cancelRecord(rec);
      throw new Error("command execution error: context canceled");
    }
    if (winner === "idle" || winner === "background") {
      this.markBackgrounded(rec);
      const text = goJSON({
        backgrounded: true,
        message: winner === "background" ? "Command backgrounded by Ctrl+B. Use ReadBackgroundCommand with task_id to monitor output or cancel it." : `Command idle for ${goDuration(timeoutSec)} (no output) and was auto-backgrounded. Use ReadBackgroundCommand to check status — look at metadata.seconds_since_last_output to decide if it is still healthy.`,
        status: "running",
        task_id: rec.id,
        timeout_seconds: timeoutSec,
      });
      return { text, details: { task_id: rec.id, command: rec.command, background: true, background_reason: winner } };
    }
    // bash_tool.go completedProcessResult: plain text, IsError on non-zero.
    const exitCode = rec.exitCode ?? -1;
    const output = completedOutput(this.outputBytes(rec).toString("utf8"), exitCode, rec.signal);
    if (exitCode !== 0) throw new Error(output);
    return { text: output, details: { exit_code: exitCode, duration_ms: (rec.endedMs ?? Date.now()) - rec.startedMs, command: params.command, ...(params.description ? { description: params.description } : {}) } };
  }

  private get(id: string, op = "format_output"): ProcessRecord {
    const rec = this.processes.get(id);
    if (!rec) throw new Error(`${op} [${id}]: process not found: process not found`);
    return rec;
  }

  /**
   * The one line window both formats render. `earlier` is what the default tail
   * hid before the window; `omittedAfter` is what an explicit from_line/max_lines
   * left past its end. Either one means the caller cannot see everything it
   * matched, which is what "truncated" means for this tool.
   */
  private select(rec: ProcessRecord, params: ReadBackgroundParams, statusOnly: boolean) {
    const maxLines = statusOnly ? 0 : (typeof params.max_lines === "number" && Math.trunc(params.max_lines) > 0
      ? Math.min(Math.trunc(params.max_lines), MAX_READ_LINES) : DEFAULT_READ_LINES);
    const specifiedFrom = typeof params.from_line === "number" && Math.trunc(params.from_line) >= 1;
    // A filter is a search over the whole log; a plain read is a view of its
    // tail. Applying the tail window first made `pattern` silently miss every
    // match that happened before the last `max_lines` lines.
    const filtering = Boolean(params.pattern || params.stream);
    const from = specifiedFrom ? Math.trunc(params.from_line!)
      : filtering ? 1 : Math.max(1, rec.lines.length - maxLines + 1);
    let regex: RegExp | undefined;
    if (params.pattern) {
      try { regex = new RegExp(params.pattern); }
      catch (e) { throw new Error(`output [${rec.id}]: failed to get output lines: invalid pattern: ${regexpError(params.pattern, e)}`); }
    }
    const window = statusOnly ? [] : rec.lines.slice(from - 1)
      .filter(line => (!params.stream || line.stream === params.stream) && (!regex || regex.test(line.content)));
    const selected = window.slice(0, maxLines);
    const earlier = statusOnly ? 0 : Math.max(0, from - 1);
    const omittedAfter = window.length - selected.length;
    return { maxLines, from, filtering, selected, earlier, omittedAfter, truncated: !statusOnly && (earlier > 0 || omittedAfter > 0) };
  }

  private formatted(rec: ProcessRecord, params: ReadBackgroundParams, statusOnly: boolean): Record<string, unknown> {
    const { selected, truncated } = this.select(rec, params, statusOnly);
    const outputFile = truncated ? this.outputFileFor(rec) : "";
    const last = rec.lines.at(-1);
    const value: Record<string, unknown> = {
      task_id: rec.id,
      status: rec.state,
      command: rec.command,
      ...(rec.pid ? { pid: rec.pid } : {}),
      started_at: rfc3339(rec.startedMs),
      ...(rec.endedMs ? { ended_at: rfc3339(rec.endedMs) } : {}),
      duration_seconds: ((rec.endedMs ?? Date.now()) - rec.startedMs) / 1000,
      ...(rec.exitCode !== undefined ? { exit_code: rec.exitCode } : {}),
      ...(!statusOnly && selected.length ? { output: selected } : {}),
      metadata: {
        cwd: rec.cwd,
        ...(Object.keys(rec.env).length ? { env: rec.env } : {}),
        total_lines: rec.lines.length,
        output_truncated: truncated,
        ...(outputFile ? { output_file: outputFile } : {}),
        ...(last ? {
          last_output_at: rfc3339(Date.parse(last.timestamp)),
          seconds_since_last_output: Math.max(0, (Date.now() - Date.parse(last.timestamp)) / 1000),
        } : {}),
        bytes_written: rec.bytesWritten,
      },
    };
    return value;
  }

  /**
   * Compact model-facing view. One fact row, one heartbeat row, one window row,
   * then the log text itself: no per-line timestamps, no repeated JSON keys, no
   * echoed env. The structured form is still one `format: "json"` away.
   */
  private textView(rec: ProcessRecord, params: ReadBackgroundParams, statusOnly: boolean): string {
    const sel = this.select(rec, params, statusOnly);
    const elapsed = Math.max(0, (rec.endedMs ?? Date.now()) - rec.startedMs) / 1000;
    const last = rec.lines.at(-1);
    const facts = [
      `task_id=${rec.id}`,
      `status=${rec.state}`,
      ...(rec.exitCode !== undefined ? [`exit_code=${rec.exitCode}`] : []),
      `duration=${goDuration(elapsed)}`,
      ...(rec.pid ? [`pid=${rec.pid}`] : []),
    ];
    const heartbeat = [
      ...(last ? [`last_output_at=${rfc3339(Date.parse(last.timestamp))}`, `seconds_since_last_output=${(Math.max(0, Date.now() - Date.parse(last.timestamp)) / 1000).toFixed(1)}`] : []),
      `bytes_written=${rec.bytesWritten}`,
      `total_lines=${rec.lines.length}`,
    ];
    if (statusOnly) {
      return [
        facts.join(" "),
        heartbeat.join(" "),
        `command=${clipCommand(rec.command, 160)}`,
        ...(rec.cwd ? [`cwd=${rec.cwd}`] : []),
      ].join("\n");
    }
    const joined = sel.selected.map(line => line.content).join("\n");
    const bounded = boundToolOutput(joined, MAX_READ_BYTES, 0);
    // The bytes are already on disk whenever the window hid anything, so the
    // byte-elision note points at the same file instead of inventing a second path.
    const outputFile = sel.truncated || bounded.truncated ? this.outputFileFor(rec) : "";
    const { filtering } = sel;
    const firstLine = sel.selected[0]?.line_number;
    const lastLine = sel.selected.at(-1)?.line_number;
    const window = [
      firstLine !== undefined ? `lines ${firstLine}-${lastLine} of ${rec.lines.length}` : `lines 0 of ${rec.lines.length}`,
      ...(filtering ? [`matches=${sel.selected.length}/${sel.selected.length + sel.omittedAfter}`] : []),
      ...(params.stream ? [`stream=${params.stream}`] : []),
      ...(params.pattern ? [`pattern=${JSON.stringify(params.pattern)}`] : []),
      ...(sel.earlier ? [`earlier=${sel.earlier}`] : []),
      ...(sel.omittedAfter ? [`after=${sel.omittedAfter}`] : []),
      ...(outputFile ? [`full_output=${outputFile}`] : []),
    ].join(" ");
    const body = sel.selected.length === 0
      ? (rec.lines.length ? "(no matching lines)" : "(no output yet)")
      : bounded.truncated
        ? `${bounded.head}\n\n... [${bounded.elidedChars} bytes elided from the middle of this read] ...\n\n${bounded.tail}`
        : joined;
    return [facts.join(" "), heartbeat.join(" "), window, "---", body].join("\n");
  }

  private listText(): string {
    const processes = [...this.processes.values()];
    if (!processes.length) return "No background commands.";
    const rows = processes.map(rec => {
      const exit = rec.exitCode !== undefined ? ` exit=${rec.exitCode}` : "";
      return `${rec.id} ${rec.state} ${goDuration(Math.round(((rec.endedMs ?? Date.now()) - rec.startedMs) / 1000))}${exit} ${clipCommand(rec.command, 80)}`;
    });
    return [`${processes.length} background command${processes.length === 1 ? "" : "s"}`, ...rows].join("\n");
  }

  async read(params: ReadBackgroundParams): Promise<ToolText> {
    const action = typeof params?.action === "string" && params.action ? params.action : "output";
    const id = typeof params?.task_id === "string" ? params.task_id : "";
    // ReadBackgroundCommand is a plain (non-streaming) tool, so the registry
    // runs Validate first (registry_impl.go) and wraps its error as
    // sdkerr "validation failed for <tool>: <err>"; Execute's own errors are
    // NewErrorResult text. Bash (streaming) never reaches Validate.
    const validation = (message: string) => new Error(`validation failed for ReadBackgroundCommand: ${message}`);
    if (!["status", "output", "cancel", "list"].includes(action)) throw validation(`invalid action: ${action} (must be status, output, cancel, or list)`);
    if (action !== "list" && !id) throw validation(`task_id is required for action "${action}"`);
    const format = params?.format === undefined || params.format === "" ? "text" : params.format;
    if (format !== "text" && format !== "json") throw validation(`invalid format: ${format} (must be text or json)`);
    if (action === "list") {
      if (format === "text") return { text: this.listText() };
      const processes = [...this.processes.values()].map(rec => ({
        task_id: rec.id,
        command: Buffer.byteLength(rec.command) > 50 ? Buffer.from(rec.command).subarray(0, 50).toString("utf8") + "..." : rec.command,
        status: rec.state,
        started_at: `${goLocalDate(new Date(rec.startedMs))} ${goLocalClock(new Date(rec.startedMs))}`,
        duration: goDuration(Math.round(((rec.endedMs ?? Date.now()) - rec.startedMs) / 1000)),
        ...(rec.exitCode !== undefined ? { exit_code: rec.exitCode } : {}),
      }));
      return { text: jsonIndent({ count: processes.length, processes }) };
    }
    if (action !== "status" && action !== "output" && action !== "cancel") throw new Error(`unknown action: ${action}`);
    if (action === "cancel") {
      const rec = this.get(id, "cancel");
      await this.cancelRecord(rec);
      return { text: `Process ${id} has been cancelled` };
    }
    const rec = this.get(id);
    if (format === "text") return { text: this.textView(rec, params, action === "status") };
    return { text: jsonIndent(this.formatted(rec, params, action === "status")) };
  }

  /** Read-only: never calls poll(), so pending child chunks and the running process are untouched. */
  snapshot(id: string): BackgroundSnapshot | undefined {
    const rec = this.processes.get(id);
    if (!rec) return undefined;
    return {
      task_id: rec.id,
      status: rec.state,
      command: rec.command,
      started_at: rec.startedMs,
      ...(rec.endedMs !== undefined ? { ended_at: rec.endedMs } : {}),
      ...(rec.exitCode !== undefined ? { exit_code: rec.exitCode } : {}),
      output_tail: rec.lines.slice(-SNAPSHOT_TAIL_LINES).map(line => line.content),
    };
  }

  private async cancelRecord(rec: ProcessRecord): Promise<void> {
    if (rec.state !== "running") return;
    rec.state = "cancelled";
    try {
      if (process.platform !== "win32" && rec.pid) process.kill(-rec.pid, "SIGTERM");
      else rec.child.kill("SIGTERM");
    } catch { /* process raced to completion */ }
    await Promise.race([rec.completion, new Promise<void>(r => setTimeout(r, 5000))]);
    if (rec.endedMs === undefined) {
      try {
        if (process.platform !== "win32" && rec.pid) process.kill(-rec.pid, "SIGKILL");
        else rec.child.kill("SIGKILL");
      } catch { /* already gone */ }
      await rec.completion;
    }
    rec.state = "cancelled";
  }
}

/** bash_tool.go completedProcessResult over ProcessResult.Output. */
export const completedOutput = (rawOutput: string, exitCode: number, signal?: NodeJS.Signals | null) => {
  let output = stripANSI(rawOutput);
  if (!output) output = exitCode === 0 ? "Command completed successfully (no output)" : "Command failed with no output";
  if (exitCode === 0) return output;
  const note = signalNote(exitCode, signal);
  return `Exit code: ${exitCode}\n${note ? `${note}\n` : ""}${output}`;
};
