
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PaneRuntimeProbe } from "../../lib/panes/install-probe.ts";
import {
	decidePaneSetup,
	paneRuntimeSetupWizard,
	paneSetupMessage,
	paneSetupStatePath,
	readPaneSetupState,
	writePaneSetupState,
} from "../../lib/ui/pane-runtime-setup.ts";

const ternProbe: PaneRuntimeProbe = {
	backend: "tern",
	capabilities: { panes: true, browser: true },
	tern: { path: "/home/u/.local/bin/tern", version: "0.9.12" },
	herdr: { path: "/home/u/.local/bin/herdr", version: "0.9.5", serverRunning: false },
	searched: ["/home/u/.local/bin"],
};

const herdrProbe: PaneRuntimeProbe = {
	backend: "herdr",
	capabilities: { panes: true, browser: false },
	herdr: { path: "/home/u/.local/bin/herdr", version: "0.9.5", serverRunning: true },
	searched: ["/home/u/.local/bin"],
};

const emptyProbe: PaneRuntimeProbe = { backend: "none", capabilities: { panes: false, browser: false }, searched: ["/home/u/.local/bin"] };

describe("decidePaneSetup", () => {
	it("asks nothing when Tern is present", () => {
		const decision = decidePaneSetup(ternProbe, {});
		expect(decision.ask).toBe(false);
		expect(decision.reason).toContain("0.9.12");
	});

	it("asks for Tern when only herdr is available, without reinstalling herdr", () => {
		const decision = decidePaneSetup(herdrProbe, {});
		expect(decision.ask).toBe(true);
		expect(decision.installHerdr).toBe(false);
		expect(decision.needsTern).toBe(true);
		expect(decision.reason).toContain("browser surface");
	});

	it("offers to install herdr when nothing is available", () => {
		const decision = decidePaneSetup(emptyProbe, {});
		expect(decision.ask).toBe(true);
		expect(decision.installHerdr).toBe(true);
	});

	it("never asks again after a decline", () => {
		const decision = decidePaneSetup(emptyProbe, { declined: true, declinedAt: "2026-01-01T00:00:00.000Z" });
		expect(decision.ask).toBe(false);
		expect(decision.reason).toContain("declined");
	});
});

describe("paneSetupMessage", () => {
	it("shows the command before it runs and does not pretend Tern self-installs", () => {
		const message = paneSetupMessage(decidePaneSetup(emptyProbe, {}), emptyProbe);
		expect(message).toContain("curl -fsSL https://herdr.dev/install.sh | sh");
		expect(message).toContain("https://docs.stencil.so/tern/");
		expect(message).toContain("manual download");
	});
});

describe("decline state", () => {
	let root: string;
	const previous = process.env.PI_SWARM_STATE_DIR;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "pane-setup-"));
		process.env.PI_SWARM_STATE_DIR = root;
	});

	afterEach(async () => {
		if (previous === undefined) delete process.env.PI_SWARM_STATE_DIR;
		else process.env.PI_SWARM_STATE_DIR = previous;
		await rm(root, { recursive: true, force: true });
	});

	it("keeps state outside the workspace and round-trips", async () => {
		const workspace = "/work/some-repo";
		const path = paneSetupStatePath(workspace);
		expect(path.startsWith(root)).toBe(true);
		expect(path.includes("/work/some-repo")).toBe(false);
		await writePaneSetupState(workspace, { declined: true, declinedAt: "2026-01-01T00:00:00.000Z", backend: "none" });
		const state = await readPaneSetupState(workspace);
		expect(state.declined).toBe(true);
		expect(state.backend).toBe("none");
	});

	it("returns an empty state for a workspace that never declined", async () => {
		expect(await readPaneSetupState("/work/untouched")).toEqual({});
	});
});

describe("paneRuntimeSetupWizard", () => {
	let root: string;
	const previous = process.env.PI_SWARM_STATE_DIR;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "pane-wizard-"));
		process.env.PI_SWARM_STATE_DIR = root;
	});

	afterEach(async () => {
		if (previous === undefined) delete process.env.PI_SWARM_STATE_DIR;
		else process.env.PI_SWARM_STATE_DIR = previous;
		await rm(root, { recursive: true, force: true });
	});

	const tui = (confirmAnswer: boolean) => ({ mode: "tui", hasUI: true, ui: { confirm: async () => confirmAnswer } });

	it("skips without an interactive UI", async () => {
		const result = await paneRuntimeSetupWizard({ mode: "tui", hasUI: true, ui: {} }, { workspace: "/w", tty: false, probe: async () => emptyProbe });
		expect(result).toBe("skipped: no interactive UI");
	});

	it("returns without prompting when Tern is present", async () => {
		let asked = false;
		const ctx = { mode: "tui", hasUI: true, ui: { confirm: async () => { asked = true; return true; } } };
		const result = await paneRuntimeSetupWizard(ctx, { workspace: "/w", tty: true, probe: async () => ternProbe });
		expect(asked).toBe(false);
		expect(result).toContain("available");
	});

	it("remembers a decline so the next session is quiet", async () => {
		const result = await paneRuntimeSetupWizard(tui(false), { workspace: "/w", tty: true, probe: async () => emptyProbe });
		expect(result).toContain("declined");
		const state = await readPaneSetupState("/w");
		expect(state.declined).toBe(true);
		const second = await paneRuntimeSetupWizard(tui(true), { workspace: "/w", tty: true, probe: async () => emptyProbe });
		expect(second).toContain("declined earlier");
	});

	it("runs the injectable installer only after an accept", async () => {
		let installed = false;
		const result = await paneRuntimeSetupWizard(tui(true), {
			workspace: "/w",
			tty: true,
			probe: async () => emptyProbe,
			installHerdr: async () => {
				installed = true;
				return "herdr installed";
			},
		});
		expect(installed).toBe(true);
		expect(result).toContain("herdr installed");
	});

	it("reports a failed install without throwing", async () => {
		const result = await paneRuntimeSetupWizard(tui(true), {
			workspace: "/w",
			tty: true,
			probe: async () => emptyProbe,
			installHerdr: async () => {
				throw new Error("network down");
			},
		});
		expect(result).toContain("herdr install failed: network down");
	});
});
