import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CLAW_EXCLUDED_TOOLS, clawAgentRoute, clawModeOn, clawRoutedTools, savedClawTools, setClawAgentRoute, setClawMode } from "../../lib/claw/mode.ts";
import { workerCommand } from "../../lib/claw/launcher.ts";
import { registerOrchestrator, overlayClawAgent, CLAW_AGENT_PARAMETERS } from "../../../extensions/claw/extension.ts";
import { registerAgents } from "../../../packages/tools/agents/src/index.ts";
import { ClawStore } from "../../lib/claw/store.ts";

const ALL = ["read", "bash", "edit", "Agent", "AgentControl", "Subagent", "BackgroundTask", "Delegate", "DelegateOutput", "SubagentOutput", "TaskOutput", "claw_spawn", "claw_list", "tern", "vault", "browser_open"];

const PRIOR = ALL.filter((n) => !n.startsWith("claw_"));

function fakePi(cwd: string, active: string[]) {
	const handlers: Record<string, Function[]> = {};
	const tools = new Map<string, any>();
	const pi: any = {
		active: [...active],
		on: (name: string, fn: Function) => { (handlers[name] ??= []).push(fn); },
		emit: async (name: string, event: unknown, ctx: unknown = {}) => { let last: unknown; for (const fn of handlers[name] ?? []) last = (await fn(event, ctx)) ?? last; return last; },
		registerTool: (t: any) => { tools.set(t.name, t); },
		registerCommand: (name: string, def: any) => { tools.set(`/${name}`, def); },
		getCwd: () => cwd,
		getActiveTools: () => [...pi.active],
		getAllTools: () => [...tools.entries()].filter(([key]) => !key.startsWith("/")).map(([, t]) => t),
		setActiveTools: (names: string[]) => { pi.active = [...names]; },
		sendUserMessage: () => undefined,
		tools,
	};
	return pi;
}

describe("claw routing mode", () => {
	beforeEach(() => setClawMode(false));
	afterEach(() => { setClawMode(false); setClawAgentRoute(undefined); });

	it("is a no-op while Claw is off", () => {
		expect(clawRoutedTools(ALL)).toEqual(ALL);
	});

	it("removes every alternate spawner and keeps the single Agent tool while on", () => {
		setClawMode(true, ALL);
		const kept = clawRoutedTools(ALL);
		for (const name of CLAW_EXCLUDED_TOOLS) expect(kept).not.toContain(name);
		expect(kept).toEqual(expect.arrayContaining(["Agent", "read", "bash", "tern", "vault", "browser_open", "claw_spawn"]));
		expect(clawRoutedTools(["read"], ["read", "claw_spawn", "claw_list", "claw_read", "claw_send", "claw_cancel", "claw_trigger"])).toEqual(["read", "claw_spawn", "claw_list", "claw_read", "claw_send", "claw_cancel", "claw_trigger"]);
	});

	it("keeps the registered Agent active while on, even when the surface gated it out", () => {
		setClawMode(true, ["read", "Subagent"]);
		expect(clawRoutedTools(["read", "Subagent"], ["read", "Subagent", "Agent"])).toEqual(["read", "Agent"]);
		expect(clawRoutedTools(["read", "Subagent"], ["read", "Subagent"])).toEqual(["read"]);
	});

	it("worker launch is plain terminal pi via the documented PI_TERN_UI=0 bypass, never -nt", () => {
		const [shell, flag, line] = workerCommand({ session: 1, cwd: "/w", label: "x", runId: "run-1", clawDir: "/c", prompt: "p" });
		// A hardcoded zsh broke every launch where zsh is not installed, so the launch probes for a zsh or bash login shell.
		expect(flag).toBe("-lic");
		expect(shell).toMatch(/\/(zsh|bash)$/);
		expect(line).toContain("PI_TERN_UI=0");
		expect(line).toMatch(/PI_TERN_UI=0 PI_CLAW_RUN=/);
		expect(line).not.toMatch(/\s-nt\b/);
		expect(line).not.toContain("--no-tools");
	});

	it("overlays the Agent schema in OpenAI and Anthropic payload shapes, leaving other tools alone", () => {
		const openai = { tools: [{ type: "function", function: { name: "Agent", description: "old", parameters: { type: "object" } } }, { type: "function", function: { name: "read", parameters: {} } }] };
		const out: any = overlayClawAgent(openai);
		expect(out.tools[0].function.parameters.required).toEqual(["task", "project"]);
		expect(out.tools[0].function.parameters.properties.project).toBeDefined();
		expect(out.tools[1]).toBe(openai.tools[1]);
		const anth: any = overlayClawAgent({ tools: [{ name: "Agent", description: "old", input_schema: {} }] });
		expect(anth.tools[0].input_schema).toEqual(CLAW_AGENT_PARAMETERS);
		expect(overlayClawAgent({ tools: [{ name: "read", input_schema: {} }] })).toBeUndefined();
	});
});

describe("registerOrchestrator activation", () => {
	let cwd: string;
	beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), "claw-route-")); setClawMode(false); });
	afterEach(() => { setClawMode(false); setClawAgentRoute(undefined); });

	it("on hides alternates and blocks them at tool_call; off restores the exact prior set", async () => {
		const pi = fakePi(cwd, ALL);
		pi.registerTool({ name: "Agent", parameters: { type: "object" } });
		registerOrchestrator(pi, { ensure: () => 1, tern: async () => "{}" });
		await pi.tools.get("/claw").handler("on", { ui: { notify: () => undefined } });
		expect(clawModeOn()).toBe(true);
		expect(pi.active).toEqual(expect.arrayContaining(["Agent", "read", "bash", "claw_spawn"]));
		for (const name of CLAW_EXCLUDED_TOOLS) expect(pi.active).not.toContain(name);
		expect(savedClawTools()).toEqual(PRIOR);

		const blockedSubagent: any = await pi.emit("tool_call", { toolName: "Subagent", input: {} });
		expect(blockedSubagent).toMatchObject({ block: true });
		expect(await pi.emit("tool_call", { toolName: "Agent", input: {} })).toBeUndefined();
		expect(await pi.emit("tool_call", { toolName: "Delegate", input: {} })).toMatchObject({ block: true });

		await pi.tools.get("/claw").handler("off", { ui: { notify: () => undefined } });
		expect(clawModeOn()).toBe(false);
		expect(pi.active).toEqual(PRIOR);
		expect(clawAgentRoute()).toBeUndefined();
		expect(await pi.emit("tool_call", { toolName: "Subagent", input: {} })).toBeUndefined();
	});

	it("session shutdown restores the tool set without touching the store control", async () => {
		const pi = fakePi(cwd, ALL);
		pi.registerTool({ name: "Agent", parameters: { type: "object" } });
		registerOrchestrator(pi, { ensure: () => 1, tern: async () => "{}" });
		await pi.tools.get("/claw").handler("on", { ui: { notify: () => undefined } });
		await pi.emit("session_shutdown", {});
		expect(clawModeOn()).toBe(false);
		expect(pi.active).toEqual(PRIOR);
		expect(new ClawStore(join(cwd, ".swarm", "claw")).readControl().enabled).toBe(true);
	});

	it("the Agent tool routes to Claw only while on, and the legacy path never runs", async () => {
		const pi = fakePi(cwd, ALL);
		pi.registerTool({ name: "Agent", parameters: { type: "object" } });
		const legacyCalls: unknown[] = [];
		const manager: any = { addEventSink: () => undefined, spawn: (x: unknown) => { legacyCalls.push(x); return { id: "legacy", sessionId: "s", wait: async () => ({}) }; }, control: async () => ({}), profileNames: () => [] };
		registerAgents(pi, manager, "s");
		const agent = pi.tools.get("Agent");
		const routed: unknown[] = [];
		setClawMode(true, ALL);
		setClawAgentRoute(async (input) => { routed.push(input); return { run_id: "run-test" }; });
		const onResult: any = await agent.execute("id", { task: "t", project: "Hoja" }, undefined, undefined, {});
		expect(onResult.details).toEqual({ run_id: "run-test" });
		expect(routed).toEqual([{ task: "t", project: "Hoja" }]);
		expect(legacyCalls).toEqual([]);
		setClawMode(false);
		setClawAgentRoute(undefined);
		await agent.execute("id", { task: "t" }, undefined, undefined, {}).catch(() => undefined);
		expect(legacyCalls.length).toBe(1);
	});
});
