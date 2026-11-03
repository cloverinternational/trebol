// Drives the host's real `/mcp` extension (not a stand-in) through Tern's ExtensionUIContext: the manager
// must render as a native overlay, answer list clicks and Esc, react to live server state and close cleanly.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { TernExtensionUI, UI_PROMPT_LIST_ID } from "../../lib/tern/ext-ui.ts";
import { parseHint, serverRow } from "../../lib/tern/tui-panel.ts";

const MCP = "../../../node_modules/@earendil-works/pi-coding-agent/dist/extensions/mcp";
const THEME = "../../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";

type Handler = (args: string, ctx: unknown) => Promise<void>;

async function loadManager(mcpJson: object) {
	const dir = mkdtempSync(join(tmpdir(), "tern-mcp-"));
	writeFileSync(join(dir, "mcp.json"), JSON.stringify(mcpJson, null, 2));
	const { createMcpExtension } = await import(`${MCP}/index.js`);
	const { loadMcpConfig } = await import(`${MCP}/config.js`);
	const events = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	let command: Handler | undefined;
	let active: string[] = [];
	const pi = {
		on: (name: string, fn: (event: unknown, ctx: unknown) => unknown) => events.set(name, fn),
		registerCommand: (name: string, spec: { handler: Handler }) => { if (name === "mcp") command = spec.handler; },
		registerTool: () => {},
		registerToolRenderer: () => {},
		getMcpServers: () => [],
		getAllTools: () => [],
		getActiveTools: () => active,
		setActiveTools: (names: string[]) => { active = names; },
	};
	createMcpExtension({ loadConfig: () => loadMcpConfig({ agentDir: dir, cwd: dir, projectTrusted: false }), openUrl: () => {} })(pi);
	return { dir, events, command: () => command!, file: join(dir, "mcp.json") };
}

function harness(theme: unknown) {
	const notices: string[] = [];
	let renders = 0;
	const ui = new TernExtensionUI({
		render: () => { renders++; },
		notice: (t) => notices.push(t),
		getDraft: () => "",
		setDraft: () => {},
		remoteFlowActive: () => false,
		columns: () => 100,
	}, theme);
	return { ui, notices, renders: () => renders };
}

type Row = { id: string; label: string; detail?: string; dot?: string; tone?: string; badges?: { text: string }[]; facts?: Record<string, number> };
const sheet = (ui: TernExtensionUI) => ui.nodes()[0];
const title = (ui: TernExtensionUI) => sheet(ui)?.p?.title;
const rows = (ui: TernExtensionUI) => ((sheet(ui)?.k === "picker" ? sheet(ui)?.p?.items : []) ?? []) as Row[];
const labels = (ui: TernExtensionUI) => rows(ui).map((r) => r.label);
const preview = (ui: TernExtensionUI): string => JSON.stringify(sheet(ui)?.c ?? []);
const tick = () => new Promise((r) => setTimeout(r, 5));
async function until(check: () => boolean, ms = 4000) {
	const end = Date.now() + ms;
	while (!check()) {
		if (Date.now() > end) throw new Error("timed out");
		await tick();
	}
}

describe("host /mcp manager inside Tern", () => {
	let theme: unknown;
	beforeAll(async () => {
		initTheme("dark");
		theme = (await import(THEME)).theme;
	});
	let open: Promise<void> | undefined;
	afterEach(async () => { await open; open = undefined; });

	it("renders the server list natively, navigates into a server and closes with Esc", async () => {
		const m = await loadManager({ mcpServers: {
			beta: { command: "beta-server", enabled: false },
			alpha: { url: "https://alpha.example/mcp", enabled: false },
		} });
		const { ui, notices, renders } = harness(theme);
		const ctx = { mode: "tui", cwd: m.dir, ui: ui.context(), isProjectTrusted: () => false, modelRegistry: undefined };
		await m.events.get("session_start")!({}, ctx);
		open = m.command()("", ctx);
		await until(() => ui.active);

		expect(notices.join("\n")).not.toContain("not available in Tern");
		expect(sheet(ui)).toMatchObject({ id: UI_PROMPT_LIST_ID, k: "picker", p: { title: "MCP servers", subtitle: "2 disabled", noun: "servers", role: "pi.panel" } });
		expect(labels(ui)).toEqual(["alpha", "beta"]);
		expect(rows(ui)[0]).toMatchObject({ dot: "muted", badges: [{ text: "codemode" }, { text: "global" }] });
		expect(rows(ui)[0]!.detail).toBeUndefined();
		expect(preview(ui)).toContain("disabled");
		expect(sheet(ui)!.p?.order).toEqual([{ group: "disabled", label: "Disabled", count: 2 }, "ui-opt-0", "ui-opt-1"]);
		// Pi's footer hint becomes the action bar, primary last.
		expect(sheet(ui)!.p?.actions).toEqual([{ id: "close", label: "Close", keys: ["esc"] }, { id: "select", label: "Manage", keys: ["enter"], primary: true }]);

		// Keyboard selection goes through the host's own SelectList.
		const before = renders();
		ui.move(1);
		expect(sheet(ui)!.p?.selected).toBe("ui-opt-1");
		expect(renders()).toBeGreaterThan(before);
		expect(preview(ui)).toContain("beta");
		// A double-click (activate) opens that server's menu; its details move to the preview pane.
		ui.pick("ui-opt-0", true);
		await until(() => title(ui) === "MCP server alpha");
		expect(labels(ui)).toEqual(["Enable"]);
		expect(sheet(ui)!.p?.preview).toBe("below");
		expect(preview(ui)).toContain("https://alpha.example/mcp");

		// The action bar's Close goes back like Esc.
		ui.action("close");
		await until(() => title(ui) === "MCP servers");
		ui.cancel();
		await open;
		expect(ui.active).toBe(false);
		expect(ui.nodes()).toEqual([]);
	});

	it("enabling a server writes mcp.json and the row follows the live connection state", async () => {
		const m = await loadManager({ mcpServers: { broken: { command: join(tmpdir(), "definitely-not-a-server"), enabled: false } } });
		const { ui } = harness(theme);
		const ctx = { mode: "tui", cwd: m.dir, ui: ui.context(), isProjectTrusted: () => false, modelRegistry: undefined };
		await m.events.get("session_start")!({}, ctx);
		open = m.command()("", ctx);
		await until(() => labels(ui).includes("broken"));
		ui.pick("ui-opt-0", true);
		await until(() => labels(ui).includes("Enable"));
		ui.submit();
		// The host saves the change, connects, and its menu rebuilds itself with the failure.
		await until(() => JSON.parse(readFileSync(m.file, "utf8")).mcpServers.broken.enabled !== false);
		await until(() => labels(ui).includes("Disable"), 8000);
		ui.cancel();
		await until(() => title(ui) === "MCP servers");
		await until(() => rows(ui)[0]?.dot === "error", 8000);
		expect(preview(ui)).toContain("failed");
		expect(rows(ui)[0]).toMatchObject({ dot: "error", tone: "error" });
		expect(sheet(ui)!.p?.order?.[0]).toMatchObject({ group: "attention", label: "Needs attention" });
		ui.cancel();
	});

	it("closing the pane while the manager is open releases the command", async () => {
		const m = await loadManager({ mcpServers: { alpha: { url: "https://alpha.example/mcp", enabled: false } } });
		const { ui } = harness(theme);
		const ctx = { mode: "tui", cwd: m.dir, ui: ui.context(), isProjectTrusted: () => false, modelRegistry: undefined };
		await m.events.get("session_start")!({}, ctx);
		const run = m.command()("", ctx);
		await until(() => ui.active);
		ui.dispose();
		await run;
		expect(ui.active).toBe(false);
	});
});

describe("custom panels that are not projectable", () => {
	it("keep the terminal-UI notice", async () => {
		const { ui, notices } = harness({});
		const ctx = ui.context() as { custom(f: unknown): Promise<unknown> };
		const result = await ctx.custom(() => ({ render: () => ["a chart ▁▂▃"], handleInput: () => {} }));
		expect(result).toBeUndefined();
		expect(notices.join("\n")).toContain("not available in Tern");
		expect(ui.active).toBe(false);
	});
});

describe("server rows parse Pi's /mcp wording strictly", () => {
	it("reads every state Pi emits", () => {
		expect(serverRow("connected · 3 tools · 3 resources · direct · global")).toMatchObject({ group: "connected", tone: "success", detail: "3 tools · 3 resources", tools: 3, resources: 3, exposure: "direct", scope: "global" });
		expect(serverRow("connected · 1 tool · codemode · project")).toMatchObject({ tools: 1, resources: 0 });
		expect(serverRow("failed: MCP connection closed · codemode · project")).toMatchObject({ group: "attention", tone: "error", detail: "MCP connection closed", state: "failed: MCP connection closed" });
		expect(serverRow("failed: a · b · deferred · global")).toMatchObject({ detail: "a · b" });
		expect(serverRow("needs sign-in · direct · global")).toMatchObject({ tone: "warning" });
		expect(serverRow("connecting… · hidden · global, project override")).toMatchObject({ tone: "pending", scope: "global, project override" });
		expect(serverRow("disabled · codemode · global")).toMatchObject({ group: "disabled" });
	});

	it("returns nothing for wording it does not know, so the row keeps Pi's text", () => {
		expect(serverRow("connected · 3 tools · direct")).toBeUndefined();
		expect(serverRow("asleep · direct · global")).toBeUndefined();
		expect(serverRow("connected · lots of tools · direct · global")).toBeUndefined();
		expect(serverRow("Enable")).toBeUndefined();
	});

	it("reads Pi's key hints and rejects other text", () => {
		expect(parseHint("enter manage • escape/ctrl+c close")).toEqual([{ id: "close", label: "Close", keys: ["esc"] }, { id: "select", label: "Manage", keys: ["enter"], primary: true }]);
		expect(parseHint("escape back")).toEqual([{ id: "close", label: "Back", keys: ["esc"] }]);
		expect(parseHint("State: connected")).toBeUndefined();
		expect(parseHint("ctrl+o copy")).toBeUndefined();
	});
});
