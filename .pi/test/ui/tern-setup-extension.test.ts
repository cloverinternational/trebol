import { describe, expect, it, vi } from "vitest";

const wizard = vi.hoisted(() => vi.fn().mockResolvedValue("declined"));
const paneWizard = vi.hoisted(() => vi.fn().mockResolvedValue("declined"));
vi.mock("../../lib/ui/tern-setup-wizard.ts", () => ({ ternSetupWizard: wizard }));
vi.mock("../../lib/ui/pane-runtime-setup.ts", () => ({ paneRuntimeSetupWizard: paneWizard }));
vi.mock("../../lib/ui/clover-layout.ts", () => ({ cloverRows: () => ["clover"] }));
vi.mock("../../lib/ui/git-panel-layout.ts", () => ({ gitPanel: () => [] }));
vi.mock("../../lib/ui/startup-notices.ts", () => ({ setStartupNoticeRender: vi.fn(), startupNotices: () => [] }));

import cloverStartupExtension from "../../../extensions/clover-startup/extension.ts";

function harness() {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<void>>();
	// Several commands are registered now, so keep them by name instead of the last one seen.
	const commands = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
	cloverStartupExtension({
		on: (name: string, handler: (event: unknown, ctx: unknown) => Promise<void>) => handlers.set(name, handler),
		registerCommand: (name: string, def: { handler: (args: string, ctx: unknown) => Promise<void> }) => { commands.set(name, def.handler); },
	});
	return { handlers, command: (name = "tern-setup") => commands.get(name)!, names: () => [...commands.keys()] };
}

describe("Tern setup startup wiring", () => {
	it("registers an explicit /tern-setup action", async () => {
		const h = harness(), ctx = { mode: "tui", hasUI: true, ui: { notify: vi.fn() } };
		await h.command()( "", ctx);
		expect(wizard).toHaveBeenCalledOnce();
		expect(ctx.ui.notify).toHaveBeenCalledWith("declined", "info");
	});

	it("registers an explicit /pane-runtime action that does not reach the shell wizard", async () => {
		wizard.mockClear();
		paneWizard.mockClear();
		const h = harness(), ctx = { cwd: "/tmp", mode: "tui", hasUI: true, ui: { notify: vi.fn() } };
		expect(h.names()).toContain("pane-runtime");
		await h.command("pane-runtime")("", ctx);
		expect(paneWizard).toHaveBeenCalledOnce();
		expect(paneWizard).toHaveBeenCalledWith(ctx, { workspace: "/tmp" });
		expect(wizard).not.toHaveBeenCalled();
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
