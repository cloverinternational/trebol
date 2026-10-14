/**
 * OSC 7501 — Program Status Protocol emitter.
 *
 * Lets Trebol tell the terminal what it is doing — idle, working, blocked,
 * done, or failed — via a terminal-native escape sequence, so terminals,
 * multiplexers, and "agentic inboxes" (Ghostty, Rex, Herdr, conch, …) can
 * show Trebol's state without scraping the screen or the process tree.
 *
 * Wire format (from the specification):
 *   ESC ] 7501 ; key=value:key=value … ESC \
 * where `state` is required and one of idle|working|done|blocked|error|clear.
 * Optional keys: id (hierarchical, `/`-separated names), app (stable
 * machine-readable program name), kind (permission|question|auth, only with
 * blocked), progress (0–100, only with working|blocked), title and msg
 * (base64-encoded single-line UTF-8 text for people).
 *
 * A report replaces its record completely. `state=clear` removes the
 * addressed record (and its children); without an id it removes every record.
 *
 * Emission is optimistic: the spec lets programs send reports without first
 * asking whether the terminal supports the protocol, and well-behaved
 * terminals ignore unknown OSC sequences. We additionally gate on a TTY
 * check (stderr is a terminal and TERM is not "dumb") with a
 * `TREBOL_PROGRAM_STATUS=1|0` override, mirroring what rio does.
 */

export type ProgramStatusState =
  | "idle"
  | "working"
  | "done"
  | "blocked"
  | "error"
  | "clear";

export type ProgramStatusKind = "permission" | "question" | "auth";

export interface ProgramStatusReport {
  state: ProgramStatusState;
  /** Hierarchical record id, e.g. "deploy/us-east". Omitted = root record. */
  id?: string;
  /** Only meaningful with state "blocked". */
  kind?: ProgramStatusKind;
  /** 0–100. Only meaningful with "working" or "blocked". */
  progress?: number;
  /** Short human label for the record. */
  title?: string;
  /** One line of human-readable text: what it is doing / waiting for. */
  msg?: string;
}

export interface ProgramStatusReporterOptions {
  /** Stable machine-readable program name. Defaults to "trebol". */
  app?: string;
  /** Sticky human label, re-sent on every report. */
  title?: string;
  /** Sticky record id, re-sent on every report. */
  id?: string;
  /** Force emission on/off. Defaults to TTY auto-detection. */
  enabled?: boolean;
  /** Environment lookup, injectable for tests. Defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** stderr TTY probe, injectable for tests. Defaults to process.stderr.isTTY. */
  isStderrTTY?: () => boolean;
  /** Byte sink, injectable for tests. Defaults to process.stderr.write. */
  write?: (data: string) => void;
}

/** Hard ceiling for a whole OSC 7501 sequence, per the specification. */
export const OSC7501_MAX_SEQUENCE_BYTES = 4096;
/** Byte budget for a decoded `msg` (spec limit is 2048). */
const MAX_MSG_BYTES = 1500;
/** Byte budget for a decoded `title` (spec limit is 192). */
const MAX_TITLE_BYTES = 150;
/** Spec: app values are at most 32 bytes. */
const MAX_APP_BYTES = 32;
/** Spec: id values are at most 128 bytes, 8 segments of at most 32 bytes. */
const MAX_ID_BYTES = 128;
const MAX_ID_SEGMENTS = 8;
const MAX_ID_SEGMENT_BYTES = 32;
/** Spec name alphabet for `app` values and `id` segments. */
const NAME_PATTERN = /^[A-Za-z0-9_.+-]+$/;

const ESC = "\u001b";
const ST = `${ESC}\\`;
const OSC7501_OPEN = `${ESC}]7501;`;

function isName(value: string): boolean {
  return value.length > 0 && NAME_PATTERN.test(value);
}

function isValidId(id: string): boolean {
  if (Buffer.byteLength(id, "utf8") > MAX_ID_BYTES) return false;
  const segments = id.split("/");
  if (segments.length > MAX_ID_SEGMENTS) return false;
  return segments.every(
    (segment) =>
      Buffer.byteLength(segment, "utf8") <= MAX_ID_SEGMENT_BYTES &&
      isName(segment),
  );
}

/** Truncate to a UTF-8 byte budget without splitting a code point. */
function truncateUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let bytes = 0;
  let end = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char, "utf8");
    if (bytes + size > maxBytes) break;
    bytes += size;
    end += char.length;
  }
  return text.slice(0, end);
}

/** A msg/title is one line of text: first line, trimmed, bounded. */
function sanitizeText(text: string, maxBytes: number): string {
  return truncateUtf8(text.split(/\r?\n/)[0].trim(), maxBytes);
}

function encodeText(text: string): string {
  return Buffer.from(text, "utf8").toString("base64").replace(/=+$/, "");
}

/**
 * Build the raw OSC 7501 escape sequence for one report.
 * Returns null when the report violates the specification, so callers never
 * emit a malformed sequence.
 */
export function buildProgramStatusSequence(
  app: string,
  report: ProgramStatusReport,
): string | null {
  if (Buffer.byteLength(app, "utf8") > MAX_APP_BYTES || !isName(app)) {
    return null;
  }
  const pairs: string[] = [`state=${report.state}`];
  if (report.id !== undefined) {
    if (!isValidId(report.id)) return null;
    pairs.push(`id=${report.id}`);
  }
  pairs.push(`app=${app}`);
  if (report.kind !== undefined) {
    // A kind with any other state is a caller bug: refuse instead of
    // silently dropping it, so misuse surfaces instead of vanishing.
    if (report.state !== "blocked") return null;
    if (report.kind !== "permission" && report.kind !== "question" && report.kind !== "auth") {
      return null;
    }
    pairs.push(`kind=${report.kind}`);
  }
  if (report.progress !== undefined) {
    // Same strictness for progress outside working/blocked.
    if (report.state !== "working" && report.state !== "blocked") return null;
    if (!Number.isInteger(report.progress) || report.progress < 0 || report.progress > 100) {
      return null;
    }
    pairs.push(`progress=${report.progress}`);
  }
  if (report.title !== undefined) {
    const title = sanitizeText(report.title, MAX_TITLE_BYTES);
    if (title) pairs.push(`title=${encodeText(title)}`);
  }
  if (report.msg !== undefined) {
    const msg = sanitizeText(report.msg, MAX_MSG_BYTES);
    if (msg) pairs.push(`msg=${encodeText(msg)}`);
  }
  const sequence = `${OSC7501_OPEN}${pairs.join(":")}${ST}`;
  if (Buffer.byteLength(sequence, "utf8") > OSC7501_MAX_SEQUENCE_BYTES) {
    return null;
  }
  return sequence;
}

function resolveEnabled(
  env: Record<string, string | undefined>,
  isStderrTTY: () => boolean,
): boolean {
  const override = env.TREBOL_PROGRAM_STATUS?.toLowerCase();
  if (override === "1" || override === "true") return true;
  if (override === "0" || override === "false") return false;
  return isStderrTTY() && env.TERM !== "dumb";
}

/**
 * Emits OSC 7501 program-status reports for one record.
 *
 * Sticky fields (app/title/id) are merged into every report, because each
 * report replaces its record completely on the terminal side.
 */
export class ProgramStatusReporter {
  private readonly app: string;
  private readonly title?: string;
  private readonly id?: string;
  private readonly enabled: boolean;
  private readonly write: (data: string) => void;

  constructor(options: ProgramStatusReporterOptions = {}) {
    const app = options.app ?? "trebol";
    if (!isName(app) || Buffer.byteLength(app, "utf8") > MAX_APP_BYTES) {
      throw new Error(`program-status: invalid app name ${JSON.stringify(app)}`);
    }
    if (options.id !== undefined && !isValidId(options.id)) {
      throw new Error(`program-status: invalid record id ${JSON.stringify(options.id)}`);
    }
    this.app = app;
    this.title = options.title;
    this.id = options.id;
    const env = options.env ?? process.env;
    this.enabled =
      options.enabled ??
      resolveEnabled(
        env,
        options.isStderrTTY ?? (() => Boolean(process.stderr?.isTTY)),
      );
    this.write = options.write ?? ((data: string) => process.stderr.write(data));
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /** Emit one report. Returns true when a sequence was written. Never throws:
   * status reporting is best-effort and cosmetic — a broken pipe or closed
   * stderr must not take down the host process. */
  report(report: ProgramStatusReport): boolean {
    if (!this.enabled) return false;
    const sequence = buildProgramStatusSequence(this.app, {
      ...report,
      id: report.id ?? this.id,
      title: report.title ?? this.title,
    });
    if (!sequence) return false;
    try {
      this.write(sequence);
    } catch {
      return false;
    }
    return true;
  }

  idle(msg?: string): boolean {
    return this.report({ state: "idle", msg });
  }

  working(msg?: string, progress?: number): boolean {
    return this.report({ state: "working", msg, progress });
  }

  blocked(kind: ProgramStatusKind, msg?: string): boolean {
    return this.report({ state: "blocked", kind, msg });
  }

  done(msg?: string): boolean {
    return this.report({ state: "done", msg });
  }

  error(msg?: string): boolean {
    return this.report({ state: "error", msg });
  }

  /** Remove this record (and its children). Omit id to clear every record. */
  clear(id?: string): boolean {
    return this.report({ state: "clear", id: id ?? this.id });
  }
}
