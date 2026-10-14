import { describe, expect, it, vi } from "vitest";
import {
  buildProgramStatusSequence,
  OSC7501_MAX_SEQUENCE_BYTES,
  ProgramStatusReporter,
} from "../../lib/runtime/program-status.ts";

const ESC = "\u001b";
const ST = `${ESC}\\`;

function makeReporter(overrides: Record<string, unknown> = {}) {
  const written: string[] = [];
  const r = new ProgramStatusReporter({
    enabled: true,
    write: (data: string) => written.push(data),
    ...overrides,
  });
  return { reporter: r, written };
}

describe("buildProgramStatusSequence", () => {
  it("builds the minimal idle report", () => {
    expect(buildProgramStatusSequence("trebol", { state: "idle" })).toBe(
      `${ESC}]7501;state=idle:app=trebol${ST}`,
    );
  });

  it("orders pairs state, id, app, kind, progress, title, msg", () => {
    const seq = buildProgramStatusSequence("terraform", {
      state: "blocked",
      id: "tf/plan",
      kind: "permission",
      progress: 42,
      title: "Plan",
      msg: "Apply 3 to add, 1 to change, 0 to destroy?",
    });
    expect(seq).toBe(
      `${ESC}]7501;state=blocked:id=tf/plan:app=terraform:kind=permission:progress=42` +
        `:title=${Buffer.from("Plan").toString("base64").replace(/=+$/, "")}` +
        `:msg=${Buffer.from("Apply 3 to add, 1 to change, 0 to destroy?").toString("base64").replace(/=+$/, "")}${ST}`,
    );
  });

  it("base64-encodes msg without padding and keeps single-line text", () => {
    const seq = buildProgramStatusSequence("trebol", {
      state: "working",
      msg: "  Syncing photos\nsecond line ignored  ",
    })!;
    const encoded = Buffer.from("Syncing photos").toString("base64").replace(/=+$/, "");
    expect(seq).toContain(`msg=${encoded}`);
    expect(encoded).not.toContain("=");
  });

  it("rejects an invalid state instead of interpolating it raw", () => {
    expect(
      buildProgramStatusSequence("trebol", { state: "working\u001b]0;evil" as never }),
    ).toBeNull();
    expect(buildProgramStatusSequence("trebol", { state: "bogus" as never })).toBeNull();
  });

  it("rejects kind when the state is not blocked", () => {
    expect(
      buildProgramStatusSequence("trebol", { state: "working", kind: "permission" }),
    ).toBeNull();
  });

  it("rejects progress when the state is not working or blocked", () => {
    expect(buildProgramStatusSequence("trebol", { state: "done", progress: 100 })).toBeNull();
    expect(buildProgramStatusSequence("trebol", { state: "idle", progress: 50 })).toBeNull();
  });

  it("rejects out-of-range progress", () => {
    expect(buildProgramStatusSequence("trebol", { state: "working", progress: 101 })).toBeNull();
    expect(buildProgramStatusSequence("trebol", { state: "working", progress: -1 })).toBeNull();
    expect(buildProgramStatusSequence("trebol", { state: "working", progress: 4.5 })).toBeNull();
    expect(
      buildProgramStatusSequence("trebol", { state: "working", progress: 0 }),
    ).toContain("progress=0");
    expect(
      buildProgramStatusSequence("trebol", { state: "blocked", progress: 100 }),
    ).toContain("progress=100");
  });

  it("rejects invalid app names and ids instead of emitting garbage", () => {
    expect(buildProgramStatusSequence("not an app!", { state: "idle" })).toBeNull();
    expect(buildProgramStatusSequence("a".repeat(33), { state: "idle" })).toBeNull();
    expect(buildProgramStatusSequence("trebol", { state: "idle", id: "bad id" })).toBeNull();
    expect(
      buildProgramStatusSequence("trebol", { state: "idle", id: "a/".repeat(9) }),
    ).toBeNull();
    expect(
      buildProgramStatusSequence("trebol", { state: "clear", id: "deploy/us-east" }),
    ).toBe(`${ESC}]7501;state=clear:id=deploy/us-east:app=trebol${ST}`);
  });

  it("rejects unknown blocked kinds", () => {
    expect(
      buildProgramStatusSequence("trebol", {
        state: "blocked",
        kind: "dance" as never,
      }),
    ).toBeNull();
  });

  it("never exceeds the 4096-byte sequence limit", () => {
    const seq = buildProgramStatusSequence("trebol", {
      state: "working",
      msg: "x".repeat(100_000),
    })!;
    expect(Buffer.byteLength(seq, "utf8")).toBeLessThanOrEqual(OSC7501_MAX_SEQUENCE_BYTES);
  });

  it("truncates multibyte text without splitting a code point", () => {
    const seq = buildProgramStatusSequence("trebol", {
      state: "working",
      title: "🔥".repeat(100),
    })!;
    const pair = seq.split(":").find((p) => p.startsWith("title="))!;
    const decoded = Buffer.from(pair.slice("title=".length), "base64").toString("utf8");
    expect(Buffer.byteLength(decoded, "utf8")).toBeLessThanOrEqual(192);
    expect(() => encodeURIComponent(decoded)).not.toThrow();
    expect(decoded).not.toContain("�");
  });
});

describe("ProgramStatusReporter", () => {
  it("merges sticky app/title/id into every report", () => {
    const { reporter, written } = makeReporter({ app: "trebol", title: "Trebol", id: "session/1" });
    reporter.working("hello");
    expect(written).toHaveLength(1);
    expect(written[0]).toContain("state=working");
    expect(written[0]).toContain("id=session/1");
    expect(written[0]).toContain("app=trebol");
    expect(written[0]).toContain(`title=${Buffer.from("Trebol").toString("base64")}`);
  });

  it("exposes one method per state plus clear", () => {
    const { reporter, written } = makeReporter();
    reporter.idle();
    reporter.working("w", 10);
    reporter.blocked("question", "q?");
    reporter.done("d");
    reporter.error("e");
    reporter.clear();
    const states = written.map((s) => s.match(/state=([a-z]+)/)![1]);
    expect(states).toEqual(["idle", "working", "blocked", "done", "error", "clear"]);
    expect(written[2]).toContain("kind=question");
  });

  it("writes nothing when disabled and reports isEnabled", () => {
    const { reporter, written } = makeReporter({ enabled: false });
    expect(reporter.isEnabled).toBe(false);
    expect(reporter.working("nope")).toBe(false);
    expect(written).toHaveLength(0);
  });

  it("honors the TREBOL_PROGRAM_STATUS override over TTY detection", () => {
    const mk = (env: Record<string, string | undefined>) =>
      new ProgramStatusReporter({ env, isStderrTTY: () => false, write: () => {} });
    expect(mk({ TREBOL_PROGRAM_STATUS: "1" }).isEnabled).toBe(true);
    expect(mk({ TREBOL_PROGRAM_STATUS: "0", TERM: "xterm" }).isEnabled).toBe(false);
    expect(
      new ProgramStatusReporter({ isStderrTTY: () => true, env: { TERM: "xterm" }, write: () => {} })
        .isEnabled,
    ).toBe(true);
    expect(
      new ProgramStatusReporter({ isStderrTTY: () => true, env: { TERM: "dumb" }, write: () => {} })
        .isEnabled,
    ).toBe(false);
  });

  it("throws on invalid sticky app or id", () => {
    expect(() => new ProgramStatusReporter({ app: "bad app" })).toThrow();
    expect(() => new ProgramStatusReporter({ id: "bad id" })).toThrow();
  });

  it("does not throw when stderr is unavailable", () => {
    const write = vi.fn();
    const r = new ProgramStatusReporter({ enabled: true, write });
    expect(r.idle("ok")).toBe(true);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("survives a throwing write (e.g. EPIPE on a closed stderr)", () => {
    const r = new ProgramStatusReporter({
      enabled: true,
      write: () => {
        const error = new Error("write EPIPE") as NodeJS.ErrnoException;
        error.code = "EPIPE";
        throw error;
      },
    });
    expect(() => r.working("hello")).not.toThrow();
    expect(r.working("hello")).toBe(false);
    expect(r.isEnabled).toBe(true);
  });
});
