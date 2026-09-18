import { describe, expect, it, vi } from "vitest";
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
