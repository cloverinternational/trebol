import { describe, expect, it } from "vitest";
import {
  BASH_PREVIEW_LINES,
  bashCallComponent,
  bashResultComponent,
  buildResultXML,
  extractBashDisplayText,
  formatBashCall,
  stripANSI,
} from "../../lib/tools/swarm-bash.ts";

// pi-tui is only resolvable inside the live pi runtime, so these tests exercise
// the module's own dependency-free wrapper and measure width the same way
// pi-tui's visibleWidth does for the ASCII text used here.
const theme = { fg: (_k: string, s: string) => s, bold: (s: string) => s };
const visibleWidth = (text: string) => stripANSI(text).replace(/\t/g, "   ").length;
const truncate = (text: string, width: number) => {
  const plain = stripANSI(text);
  return plain.length <= width ? text : `${plain.slice(0, Math.max(0, width - 1))}\u2026`;
};
const WIDTHS = [20, 40, 80, 155];

/**
 * Pi's TUI treats one array element from render() as exactly one terminal row
 * and throws "Rendered line N exceeds terminal width" otherwise, tearing down
 * the whole TUI. Both invariants must hold for every row.
 */
function expectRenderable(rows: string[], width: number) {
  for (const row of rows) {
    expect(row.includes("\n"), `row must not contain a newline: ${JSON.stringify(row)}`).toBe(false);
    expect(visibleWidth(row), `row must fit width ${width}: ${JSON.stringify(row)}`).toBeLessThanOrEqual(width);
  }
}

describe("bash call rendering", () => {
  const heredoc = `cat > /tmp/f.txt <<'EOF'\n${"line ".repeat(30)}\nEOF`;
  const chain = Array.from({ length: 12 }, (_, i) => `echo step${i}`).join("\n");

  for (const width of WIDTHS) {
    it(`keeps a multi-line command to one bounded row at width ${width}`, () => {
      for (const command of [heredoc, chain, "echo a\necho b"]) {
        expectRenderable(bashCallComponent(formatBashCall({ command }, theme), truncate).render(width), width);
        // The background `Bash` tool registers without a truncator; the
        // built-in fallback must be just as safe.
        expectRenderable(bashCallComponent(formatBashCall({ command }, theme)).render(width), width);
      }
    });
  }

  it("signals elided continuation lines instead of dropping them silently", () => {
    const [row] = bashCallComponent(formatBashCall({ command: "echo a\necho b" }, theme), truncate).render(80);
    expect(row).toContain("echo a");
    expect(row).toContain("⏎");
  });

  it("does not add a continuation marker for a single-line command", () => {
    const [row] = bashCallComponent(formatBashCall({ command: "echo a\n" }, theme), truncate).render(80);
    expect(row).not.toContain("⏎");
  });
});

describe("bash result rendering", () => {
  const big = Array.from({ length: 300 }, (_, i) => `output line ${i} ${"z".repeat(90)}`).join("\n");
  const xml = buildResultXML({ exitCode: 0, durationMs: 2500, stdout: big, stderr: "", timedOut: false, requestedSecs: 60, effectiveSecs: 60 });
  const result = { content: [{ type: "text", text: xml }], details: { command: "build", duration_ms: 2500 } };

  for (const width of WIDTHS) {
    it(`renders bounded rows collapsed, expanded and in flight at width ${width}`, () => {
      expectRenderable(bashResultComponent(result, {}, theme).render(width), width);
      expectRenderable(bashResultComponent(result, { expanded: true }, theme).render(width), width);
      expectRenderable(
        bashResultComponent({ content: [{ type: "text", text: "progress\rmore\r\ndone" }], details: { command: "build" } }, { isPartial: true }, theme).render(width),
        width,
      );
    });
  }

  it("never shows the model-facing XML envelope to the user", () => {
    const rows = bashResultComponent(result, {}, theme).render(80);
    expect(rows.some((r) => /CDATA|<result|<stdout>|<\/stderr>/.test(r))).toBe(false);
    expect(rows.some((r) => r.includes("output line 299"))).toBe(true);
  });

  it("collapses to a preview tail with an expand hint rather than dumping everything", () => {
    const rows = bashResultComponent(result, {}, theme).render(80);
    expect(rows.length).toBeLessThan(20);
    expect(rows[0]).toContain("ctrl+o to expand");
    const expanded = bashResultComponent(result, { expanded: true }, theme).render(80);
    expect(expanded.length).toBeGreaterThan(rows.length);
  });

  it("shows output in full when it fits within the preview budget", () => {
    const small = buildResultXML({ exitCode: 0, durationMs: 10, stdout: "a\nb\nc", stderr: "", timedOut: false, requestedSecs: 60, effectiveSecs: 60 });
    const rows = bashResultComponent({ content: [{ type: "text", text: small }], details: { command: "x", duration_ms: 10 } }, {}, theme).render(80);
    expect(rows.some((r) => r.includes("ctrl+o to expand"))).toBe(false);
    expect(rows.filter((r) => ["a", "b", "c"].includes(r))).toHaveLength(3);
    expect(BASH_PREVIEW_LINES).toBe(5);
  });

  it("carries the Ctrl+B affordance on the in-flight row", () => {
    const rows = bashResultComponent({ content: [{ type: "text", text: "working" }], details: { command: "sleep 5" } }, { isPartial: true }, theme).render(80);
    expect(rows.some((r) => r.includes("ctrl+b"))).toBe(true);
  });

  it("keeps a failure message verbatim instead of parsing it as XML", () => {
    const message = "Error executing bash: Command exited with code 1: exit status 1\n\nstderr:\nboom";
    const rows = bashResultComponent({ content: [{ type: "text", text: message }], isError: true, details: { command: "false" } }, {}, theme).render(80);
    expect(rows.some((r) => r.includes("boom"))).toBe(true);
  });

  it("extracts both streams, and reports nothing for a silent success", () => {
    expect(extractBashDisplayText(buildResultXML({ exitCode: 0, durationMs: 1, stdout: "out", stderr: "err", timedOut: false, requestedSecs: 60, effectiveSecs: 60 }))).toBe("out\nerr");
    expect(extractBashDisplayText(buildResultXML({ exitCode: 0, durationMs: 1, stdout: "", stderr: "", timedOut: false, requestedSecs: 60, effectiveSecs: 60 }))).toBe("");
    expect(extractBashDisplayText("plain text")).toBe("plain text");
  });

  it("keeps the command visible for an auto-backgrounded result", () => {
    const rows = bashResultComponent({
      content: [{ type: "text", text: JSON.stringify({ backgrounded: true, status: "running", task_id: "bg-1", message: "Command idle for 30s (no output) and was auto-backgrounded." }) }],
      details: { command: "npm test", background: true, background_reason: "idle" },
    }, {}, theme).render(80);
    expect(rows.join("\n")).toContain("$ npm test");
    expect(rows.join("\n")).toContain("backgrounded · running · task_id=bg-1");
    expect(rows.join("\n")).not.toContain('{"backgrounded":true');
  });
});

/**
 * `app.tools.expand` (ctrl+o) is a GLOBAL toggle: interactive-mode.ts calls
 * setExpanded(this.toolOutputExpanded) on every tool row, which re-invokes
 * renderResult with fresh options. Toggling must therefore be idempotent and
 * must never produce an unrenderable row in either state.
 */
describe("bash result collapse/expand toggling", () => {
  const lines = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
  const xml = buildResultXML({ exitCode: 0, durationMs: 1200, stdout: lines, stderr: "", timedOut: false, requestedSecs: 60, effectiveSecs: 60 });
  const result = { content: [{ type: "text", text: xml }], details: { command: "seq", duration_ms: 1200 } };
  const rowsAt = (expanded: boolean, width = 80) => bashResultComponent(result, { expanded }, theme).render(width);

  it("returns to a byte-identical view after a full toggle cycle", () => {
    const collapsed = rowsAt(false);
    const expanded = rowsAt(true);
    for (let i = 0; i < 3; i++) {
      expect(rowsAt(false)).toEqual(collapsed);
      expect(rowsAt(true)).toEqual(expanded);
    }
    expect(expanded.length).toBeGreaterThan(collapsed.length);
  });

  it("keeps every row renderable in both states across terminal resizes", () => {
    for (const width of [20, 50, 120, 200]) {
      for (const expanded of [false, true]) expectRenderable(rowsAt(expanded, width), width);
    }
  });

  it("shows the expand hint only while collapsed, and the tail in both states", () => {
    expect(rowsAt(false).some((r) => r.includes("ctrl+o to expand"))).toBe(true);
    expect(rowsAt(true).some((r) => r.includes("ctrl+o to expand"))).toBe(false);
    // The tail carries the failure/summary, so it must survive collapsing.
    expect(rowsAt(false).some((r) => r.includes("line 39"))).toBe(true);
    expect(rowsAt(true).some((r) => r.includes("line 39"))).toBe(true);
    expect(rowsAt(true).some((r) => r.includes("line 0"))).toBe(true);
  });

  it("re-renders stably through invalidate() without caching a stale view", () => {
    const component = bashResultComponent(result, {}, theme);
    const before = component.render(80);
    component.invalidate();
    expect(component.render(80)).toEqual(before);
    // A different width on the same instance must reflow, not replay.
    expect(component.render(30).every((r) => r.length <= 30)).toBe(true);
  });

  it("survives a mid-stream toggle and always previews the newest output", () => {
    let streamed = "";
    for (let i = 0; i < 30; i++) {
      streamed += `chunk ${i} ${"q".repeat(i * 7)}\n`;
      const partial = { content: [{ type: "text", text: streamed }], details: { command: "build", stream: "stdout" } };
      for (const expanded of [false, true]) {
        expectRenderable(bashResultComponent(partial, { isPartial: true, expanded }, theme).render(80), 80);
      }
    }
    const rows = bashResultComponent({ content: [{ type: "text", text: streamed }], details: { command: "build" } }, { isPartial: true }, theme).render(80);
    expect(rows.some((r) => r.includes("chunk 29"))).toBe(true);
    expect(rows.some((r) => r.startsWith("chunk 0 "))).toBe(false);
  });

  it("renders a short result identically collapsed and expanded", () => {
    const small = buildResultXML({ exitCode: 0, durationMs: 10, stdout: "a\nb", stderr: "", timedOut: false, requestedSecs: 60, effectiveSecs: 60 });
    const short = { content: [{ type: "text", text: small }], details: { command: "x", duration_ms: 10 } };
    expect(bashResultComponent(short, {}, theme).render(80)).toEqual(bashResultComponent(short, { expanded: true }, theme).render(80));
  });
});
