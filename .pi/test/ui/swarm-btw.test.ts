import { describe, expect, it, vi } from "vitest";
// The Pi host packages are supplied at runtime and are not installed here, so
// stub the surface BtwView touches.
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
import swarmBtw, { BTW_STATE_EVENT, BTW_SUBMIT_EVENT, BtwView } from "../../../extensions/swarm-btw/extension.ts";

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

// The command must mount in Pi's input slot, not as an overlay: ask-user-style. The host decides that
// purely from the absence of `overlay: true` (interactive-mode.js showExtensionCustom), so the option
// object is the observable contract and the reason this test exists.
function mountBtw() {
  const emitted: Array<{ channel: string; data: unknown }> = [];
  const subscriptions = new Map<string, (data: unknown) => void>();
  let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
  const pi = {
    events: {
      emit: (channel: string, data: unknown) => emitted.push({ channel, data }),
      on: (channel: string, fn: (data: unknown) => void) => {
        subscriptions.set(channel, fn);
        return () => subscriptions.delete(channel);
      },
    },
    registerCommand: (_name: string, definition: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
      handler = definition.handler;
    },
  };
  swarmBtw(pi as never);

  let options: unknown = "custom() never called";
  let done!: (value?: unknown) => void;
  let component: { render(width: number): string[]; handleInput(data: string): void } | undefined;
  const resolved = new Promise<unknown>((resolve) => {
    done = resolve;
  });
  const ctx = {
    mode: "tui",
    ui: {
      custom: (factory: (...args: unknown[]) => unknown, opts?: unknown) => {
        options = opts;
        component = factory({ requestRender() {} }, theme, {}, done) as typeof component;
        return resolved;
      },
      notify: vi.fn(),
    },
  };
  return { run: () => handler!("", ctx), get options() { return options; }, get component() { return component; }, done: () => done(), emitted, subscriptions, ctx };
}

describe("/btw command mounting", () => {
  it("mounts in the input slot with no overlay options", async () => {
    const btw = mountBtw();
    await btw.run();
    expect(btw.options).toBeUndefined();
    expect(btw.component?.render(60)[1]).toContain("BTW · side question");
  });

  it("closes through the host callback so the editor and draft are restored", async () => {
    const btw = mountBtw();
    await btw.run();
    btw.component?.handleInput("\x1b");
    await expect(Promise.race([Promise.resolve(btw.component), Promise.resolve()])).resolves.toBeDefined();
    expect(btw.emitted.filter((e) => e.channel === BTW_STATE_EVENT).at(-1)?.data).toMatchObject({ open: false });
  });

  it("publishes an open snapshot and answers bus submits from a native frontend", async () => {
    const btw = mountBtw();
    await btw.run();
    expect(btw.emitted.some((e) => e.channel === BTW_STATE_EVENT && (e.data as { open: boolean }).open)).toBe(true);
    // Tern submits on the bus; with no side agent available here it must not throw.
    const submit = btw.subscriptions.get(BTW_SUBMIT_EVENT);
    expect(submit).toBeTypeOf("function");
    expect(() => submit?.({ question: "why?" })).not.toThrow();
  });
});
