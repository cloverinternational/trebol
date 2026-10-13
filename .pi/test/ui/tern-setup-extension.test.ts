import { describe, expect, it, vi } from "vitest";

const wizard = vi.hoisted(() => vi.fn().mockResolvedValue("declined"));
vi.mock("../../lib/ui/tern-setup-wizard.ts", () => ({ ternSetupWizard: wizard }));
vi.mock("../../lib/ui/clover-layout.ts", () => ({ cloverRows: () => ["clover"] }));
vi.mock("../../lib/ui/git-panel-layout.ts", () => ({ gitPanel: () => [] }));
vi.mock("../../lib/ui/startup-notices.ts", () => ({ setStartupNoticeRender: vi.fn(), startupNotices: () => [] }));

import cloverStartupExtension from "../../../extensions/clover-startup/extension.ts";

function harness() {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<void>>();
	let command: ((args: string, ctx: unknown) => Promise<void>) | undefined;
	cloverStartupExtension({
		on: (name: string, handler: (event: unknown, ctx: unknown) => Promise<void>) => handlers.set(name, handler),
		registerCommand: (_name: string, def: { handler: (args: string, ctx: unknown) => Promise<void> }) => { command = def.handler; },
	});
	return { handlers, command: () => command! };
}

describe("Tern setup startup wiring", () => {
	it("registers an explicit /tern-setup action", async () => {
		const h = harness(), ctx = { mode: "tui", hasUI: true, ui: { notify: vi.fn() } };
		await h.command()( "", ctx);
		expect(wizard).toHaveBeenCalledOnce();
		expect(ctx.ui.notify).toHaveBeenCalledWith("declined", "info");
	});

	it("never offers setup on print, RPC without UI, or non-startup session", async () => {
		wizard.mockClear();
		const h = harness();
		for (const ctx of [{ mode: "print", hasUI: false }, { mode: "rpc", hasUI: false }, { mode: "tui", hasUI: true }]) {
			await h.handlers.get("session_start")!({ reason: "resume" }, ctx);
		}
		expect(wizard).not.toHaveBeenCalled();
	});

	it("offers setup at interactive startup and at most once for that session", async () => {
		wizard.mockClear();
		const h = harness();
		const ctx = { cwd: "/tmp", mode: "tui", hasUI: true, ui: { setHeader: vi.fn(), requestRender: vi.fn(), notify: vi.fn() } };
		await h.handlers.get("session_start")!({ reason: "startup" }, ctx);
		expect(wizard).toHaveBeenCalledWith(ctx, expect.any(String), { startup: true });
	});
});
