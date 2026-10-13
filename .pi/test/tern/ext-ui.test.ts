import { describe, expect, it, vi } from "vitest";
import { PiTernBridge, type PiEventLike, type PiSessionLike } from "../../lib/tern/bridge.ts";
import { TernExtensionUI, UI_PROMPT_INPUT_ID, UI_PROMPT_LIST_ID } from "../../lib/tern/ext-ui.ts";
import { ESC, parseTspMessages } from "../../lib/tern/tsp.ts";

function host(overrides: Partial<ConstructorParameters<typeof TernExtensionUI>[0]> = {}) {
	const notices: string[] = [];
	let draft = "";
	const h = {
		render: vi.fn(),
		notice: (t: string) => notices.push(t),
		getDraft: () => draft,
		setDraft: (t: string) => {
			draft = t;
		},
		remoteFlowActive: () => false,
		columns: () => 80,
		...overrides,
	};
	return { h, notices, draft: () => draft };
}

type Ctx = {
	select(t: string, o: string[], opts?: { signal?: AbortSignal; timeout?: number }): Promise<string | undefined>;
	confirm(t: string, m: string): Promise<boolean>;
	input(t: string, p?: string): Promise<string | undefined>;
	editor(t: string, p?: string): Promise<string | undefined>;
	notify(m: string, type?: string): void;
	setWidget(k: string, c: unknown, o?: unknown): void;
	custom(f: unknown): Promise<unknown>;
	setEditorText(t: string): void;
	getEditorText(): string;
};

describe("TernExtensionUI", () => {
	it("select resolves only from an explicit choice and renders a native list", async () => {
		const { h } = host();
		const ui = new TernExtensionUI(h, {});
		const ctx = ui.context() as unknown as Ctx;
		const p = ctx.select("Pick one\ndetail line", ["a", "b", "c"]);
		expect(ui.active).toBe(true);
		const [overlay] = ui.nodes();
		expect(overlay.p).toMatchObject({ head: "Pick one", modal: true });
		expect(overlay.c?.[0].p?.text).toBe("detail line");
		const list = overlay.c?.find((n) => n.id === UI_PROMPT_LIST_ID);
		expect(list?.c?.map((i) => i.p?.label)).toEqual(["a", "b", "c"]);
		ui.move(1);
		ui.move(1);
		ui.submit();
		expect(await p).toBe("c");
		expect(ui.active).toBe(false);
	});

	it("double-click activates an item; digits jump", async () => {
		const ui = new TernExtensionUI(host().h, {});
		const ctx = ui.context() as unknown as Ctx;
		const p = ctx.select("t", ["x", "y"]);
		ui.pick("ui-opt-1", true);
		expect(await p).toBe("y");
		const q = ctx.select("t", ["x", "y", "z"]);
		ui.type("3");
		ui.submit();
		expect(await q).toBe("z");
	});

	it("confirm is true only for an explicit Yes; Esc is false", async () => {
		const ui = new TernExtensionUI(host().h, {});
		const ctx = ui.context() as unknown as Ctx;
		const yes = ctx.confirm("Delete?", "really");
		ui.submit();
		expect(await yes).toBe(true);
		const esc = ctx.confirm("Delete?", "really");
		ui.cancel();
		expect(await esc).toBe(false);
	});

	it("input and editor collect typed text and focus the field", async () => {
		const ui = new TernExtensionUI(host().h, {});
		const ctx = ui.context() as unknown as Ctx;
		const p = ctx.input("Name", "placeholder");
		expect(ui.focusId).toBe(UI_PROMPT_INPUT_ID);
		ui.type("ab");
		ui.backspace();
		ui.type("c");
		ui.submit();
		expect(await p).toBe("ac");
		const e = ctx.editor("Body", "pre");
		ui.newline();
		ui.type("x");
		expect(ui.nodes()[0].c?.find((n) => n.id === UI_PROMPT_INPUT_ID)?.k).toBe("editor");
		ui.submit();
		expect(await e).toBe("pre\nx");
	});

	it("abort signals and timeouts resolve undefined; dispose cancels everything", async () => {
		const ui = new TernExtensionUI(host().h, {});
		const ctx = ui.context() as unknown as Ctx;
		const ac = new AbortController();
		const p = ctx.select("t", ["a"], { signal: ac.signal });
		ac.abort();
		expect(await p).toBeUndefined();
		vi.useFakeTimers();
		const t = ctx.select("t", ["a"], { timeout: 50 });
		vi.advanceTimersByTime(60);
		vi.useRealTimers();
		expect(await t).toBeUndefined();
		const a = ctx.input("x");
		const b = ctx.confirm("y", "z");
		ui.dispose();
		expect(await a).toBeUndefined();
		expect(await b).toBe(false);
	});

	it("queues prompts and answers them in order", async () => {
		const ui = new TernExtensionUI(host().h, {});
		const ctx = ui.context() as unknown as Ctx;
		const one = ctx.select("one", ["1"]);
		const two = ctx.select("two", ["2"]);
		expect(ui.nodes()[0].p?.head).toBe("one (+1 queued)");
		ui.submit();
		ui.submit();
		expect([await one, await two]).toEqual(["1", "2"]);
	});

	it("notify, text widgets and editor text map to Tern", () => {
		const { h, notices, draft } = host();
		const ui = new TernExtensionUI(h, {});
		const ctx = ui.context() as unknown as Ctx;
		ctx.notify("hi");
		ctx.notify("bad", "error");
		expect(notices).toEqual(["hi", "Error: bad"]);
		ctx.setWidget("w", ["\x1b[31mred\x1b[0m line"], { placement: "belowEditor" });
		expect(ui.widgetNodes("belowEditor")[0].p?.text).toBe("red line");
		expect(ui.widgetNodes("aboveEditor")).toEqual([]);
		ctx.setWidget("w", undefined);
		expect(ui.widgetNodes("belowEditor")).toEqual([]);
		ctx.setEditorText("draft");
		expect(draft()).toBe("draft");
		expect(ctx.getEditorText()).toBe("draft");
	});

	it("custom panels without a Tern counterpart are disposed and resolve undefined", async () => {
		const { h, notices } = host();
		const ui = new TernExtensionUI(h, {});
		const dispose = vi.fn();
		const result = await (ui.context() as unknown as Ctx).custom(() => ({ render: () => [], dispose }));
		expect(result).toBeUndefined();
		expect(dispose).toHaveBeenCalled();
		expect(notices[0]).toMatch(/not available in Tern/);
	});

	it("custom panels with a remote Tern flow wait for the factory's done", async () => {
		const ui = new TernExtensionUI(host({ remoteFlowActive: () => true }).h, {});
		let done!: (r: unknown) => void;
		const p = (ui.context() as unknown as Ctx).custom((_t: unknown, _th: unknown, _k: unknown, d: (r: unknown) => void) => {
			done = d;
			return { render: () => [] };
		});
		await Promise.resolve();
		await Promise.resolve();
		done("answered");
		expect(await p).toBe("answered");
	});
});

describe("PiTernBridge extension prompts", () => {
	function session(): PiSessionLike {
		return { subscribe: () => () => {}, prompt: async () => {}, abort: async () => {}, dispose: () => {} } as PiSessionLike;
	}
	function lastLayer(writes: string[]): unknown {
		const frame = writes.filter((w) => w.startsWith(`${ESC}_tsp;f;`)).at(-1)!;
		return JSON.stringify(parseTspMessages(frame)[0]?.body);
	}

	it("routes enter, esc, arrows and list clicks to the open prompt, not the composer", async () => {
		const writes: string[] = [];
		const bridge = new PiTernBridge(session(), { write: (d) => writes.push(d), surfaceId: "pi", credits: 1000 });
		bridge.start();
		const ctx = bridge.uiContext() as unknown as Ctx;
		const p = ctx.select("Choose", ["a", "b"]);
		expect(lastLayer(writes)).toContain("ui-prompt");
		bridge.movePicker(1);
		await bridge.submit("ignored");
		expect(await p).toBe("b");
		const q = ctx.confirm("Sure?", "x");
		expect(bridge.escape()).toBe(false);
		expect(await q).toBe(false);
		const r = ctx.select("Choose", ["a", "b"]);
		bridge.handle({ verb: "e", body: { ev: "activate", sf: "pi", id: UI_PROMPT_LIST_ID, item: "ui-opt-1" } });
		expect(await r).toBe("b");
		const i = ctx.input("Name");
		bridge.appendDraft("zed");
		expect(bridge.draft).toBe("");
		await bridge.submitDraft();
		expect(await i).toBe("zed");
		bridge.close();
	});
});

describe("ask_user_question with the bound Tern UI", () => {
	it("runAskFlow's ui.custom path is answered by the Tern ask dialog", async () => {
		const { createEventBus } = await import("@earendil-works/pi-coding-agent");
		const { createRemoteAskRuntime } = await import("../../../extensions/ask-user/src/remote-ask.ts");
		const { runAskFlow } = await import("../../../extensions/ask-user/src/ui/controller.ts");
		const { TernAskDialog } = await import("../../lib/tern/ask-dialog.ts");
		const { initTheme } = await import("@earendil-works/pi-coding-agent");
		initTheme();
		const events = createEventBus();
		const runtime = createRemoteAskRuntime(events);
		const dialog = new TernAskDialog(events, () => {});
		dialog.start();
		const ui = new TernExtensionUI(host({ remoteFlowActive: () => dialog.active }).h, {
			fg: (_c: string, t: string) => t, bg: (_c: string, t: string) => t, bold: (t: string) => t, italic: (t: string) => t, strikethrough: (t: string) => t, underline: (t: string) => t, inverse: (t: string) => t,
		});
		const ctx = { mode: "tui", hasUI: true, cwd: process.cwd(), ui: ui.context() } as never;
		const params = { title: "Plan", questions: [{ id: "scope", label: "Scope", prompt: "Which?", type: "single", options: [{ value: "small", label: "Small" }, { value: "big", label: "Big" }] }] } as never;
		const flow = runAskFlow(ctx, params, { remote: { runtime, source: "tool", toolCallId: "t1" } } as never);
		for (let i = 0; i < 400 && !dialog.active; i++) await new Promise((r) => setTimeout(r, 5));
		expect(dialog.active).toBe(true);
		dialog.toggle(0, 1);
		dialog.submit();
		const result = (await flow) as { cancelled?: boolean; answers?: Record<string, unknown> };
		expect(result.cancelled).toBeFalsy();
		expect(JSON.stringify(result.answers)).toContain("big");
		runtime.disposeAll();
		dialog.dispose();
	});
});
