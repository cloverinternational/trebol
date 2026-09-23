import { describe, expect, it, vi } from "vitest";
// The Pi host packages are supplied at runtime and are not installed here, so
// stub the surface BtwView touches. Mirrors .pi/test/runtime/bootstrap-task-first.test.ts.
vi.mock("@earendil-works/pi-ai", () => ({ contentText: (c: unknown) => typeof c === "string" ? c : "" }));
vi.mock("@earendil-works/pi-coding-agent", () => ({ getMarkdownTheme: () => ({}) }));
vi.mock("@earendil-works/pi-tui", () => ({
  Key: { escape: "escape" },
  matchesKey: (data: string, key: string) => key === "escape" && data === "\x1b",
  // Minimal editable line: BtwView only sets/reads a value and renders one row.
  Input: class { value = ""; onSubmit?: (value: string) => void;
    setValue(v: string) { this.value = v; }
    handleInput(data: string) { data === "\r" ? this.onSubmit?.(this.value) : (this.value += data); }
    render() { return [this.value]; } },
  Markdown: class { constructor(private readonly text: string) {} render() { return [this.text]; } },
}));
import { BtwView } from "../../extensions/50-ui/swarm-btw.ts";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text, dim: (text: string) => text };

describe("BtwView", () => {
  it("aborts active work with Escape and closes when idle", () => {
    const abort = vi.fn();
    const close = vi.fn();
    const active = new BtwView({ requestRender() {} } as any, theme as any, () => [], () => ({ question: "q", answer: "" }), vi.fn(), abort, close);
    active.handleInput("\x1b");
    expect(abort).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();

    const idle = new BtwView({ requestRender() {} } as any, theme as any, () => [], () => undefined, vi.fn(), abort, close);
    idle.handleInput("\x1b");
    expect(close).toHaveBeenCalledOnce();
  });

  it("renders a bounded titled overlay", () => {
    const view = new BtwView({ requestRender() {} } as any, theme as any, () => [], () => undefined, vi.fn(), vi.fn(), vi.fn());
    const lines = view.render(60);
    expect(lines[1]).toContain("BTW · side question");
    expect(lines.at(-1)).toBe(`└${"─".repeat(58)}┘`);
  });
});
