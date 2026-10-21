import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clawAgentRoute, clawModeOn, CLAW_EXCLUDED_TOOLS, setClawAgentRoute, setClawMode } from "../../lib/claw/mode.ts";
import { ClawStore } from "../../lib/claw/store.ts";
import { registerOrchestrator, CLAW_ENTRY } from "../../../extensions/claw/extension.ts";
import { registerHojaMode, HOJA_RULE, HOJA_ENTRY } from "../../../extensions/hoja-mode/extension.ts";

const BASE = ["read", "bash", "edit", "Agent", "Subagent", "BackgroundTask", "Delegate", "DelegateOutput", "SubagentOutput", "TaskOutput", "AgentControl", "wait_for_agent", "multi_agent_wait", "hoja_list", "hoja_get"];
const CLAW_TOOLS = ["claw_spawn", "claw_list", "claw_read", "claw_send", "claw_cancel", "claw_trigger"];
const ALL = [...BASE, ...CLAW_TOOLS];

type Entry = { type: "custom"; customType: string; data: any };
type Session = { id: string; entries: Entry[] };

/** One Pi extension instance. A /reload creates a fresh instance (new pi) over the same session file. */
function instance(cwd: string, session: Session, active: string[], ensureCalls: { n: number }) {
	const handlers: Record<string, Function[]> = {};
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const pi: any = {
		active: [...active],
		on: (name: string, fn: Function) => { (handlers[name] ??= []).push(fn); },
		registerTool: (t: any) => { tools.set(t.name, t); },
		registerCommand: (name: string, def: any) => { commands.set(name, def); },
		appendEntry: (customType: string, data: unknown) => { session.entries.push({ type: "custom", customType, data: JSON.parse(JSON.stringify(data ?? null)) }); },
		getCwd: () => cwd,
		getActiveTools: () => [...pi.active],
		getAllTools: () => [...tools.values()],
		setActiveTools: (names: string[]) => { pi.active = [...new Set(names)]; },
		sendUserMessage: () => undefined,
		tools, commands, handlers,
	};
	registerOrchestrator(pi, { ensure: () => { ensureCalls.n++; return 1; }, tern: async () => "{}", env: {} });
	registerHojaMode(pi, { gql: async () => ({ issues: { nodes: [] } }) } as any);
	const ctx = { sessionManager: { getSessionId: () => session.id, getBranch: () => session.entries, getCwd: () => cwd } };
	const emit = async (name: string, event: unknown) => { for (const fn of handlers[name] ?? []) await fn(event, ctx); };
	const run = async (cmd: string, args: string) => { await commands.get(cmd).handler(args, { ui: { notify: () => undefined } }); };
	const beforeAgent = async () => { let out = ""; for (const fn of handlers.before_agent_start ?? []) { const r = await fn({ systemPrompt: "" }, ctx); if (r?.systemPrompt) out = r.systemPrompt; } return out; };
	return { pi, emit, run, beforeAgent, handlers, tools };
}

/** Same chat, /reload: old instance shuts down (Pi keeps the active names), new instance starts on the same session. */
async function reload(old: ReturnType<typeof instance>, cwd: string, session: Session, ensureCalls: { n: number }) {
	await old.emit("session_shutdown", { type: "session_shutdown", reason: "reload" });
	const next = instance(cwd, session, old.pi.active, ensureCalls);
	await next.emit("session_start", { type: "session_start", reason: "reload" });
	return next;
}

const clawEntries = (s: Session) => s.entries.filter((e) => e.customType === CLAW_ENTRY);

describe("claw mode persists per chat across reload", () => {
	let cwd: string;
	let ensureCalls: { n: number };
	beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), "claw-restore-")); ensureCalls = { n: 0 }; setClawMode(false); setClawAgentRoute(undefined); });
	afterEach(() => { setClawMode(false); setClawAgentRoute(undefined); rmSync(cwd, { recursive: true, force: true }); });

	it("same-session reload restores on: routing, tool surface and route, without a second daemon start or store change", async () => {
		const session: Session = { id: "chat-A", entries: [] };
		const first = instance(cwd, session, ALL, ensureCalls);
		await first.emit("session_start", { type: "session_start", reason: "startup" });
		await first.run("claw", "on");
		expect(ensureCalls.n).toBe(1);
		const store = ClawStore.forWorkspace(cwd);
		const controlBefore = JSON.stringify(store.readControl());

		const next = await reload(first, cwd, session, ensureCalls);
		expect(clawModeOn()).toBe(true);
		expect(next.pi.active).toEqual(expect.arrayContaining(["Agent", "read", "claw_spawn", "claw_trigger"]));
		for (const name of CLAW_EXCLUDED_TOOLS) expect(next.pi.active).not.toContain(name);
		expect(typeof clawAgentRoute()).toBe("function");
		expect(ensureCalls.n).toBe(1);
		expect(JSON.stringify(store.readControl())).toBe(controlBefore);
		expect(store.readOrchestrator().owner).toBe("chat-A");
	});

	it("/claw off then reload stays off and restores the exact pre-Claw tool set", async () => {
		const session: Session = { id: "chat-A", entries: [] };
		const first = instance(cwd, session, ALL, ensureCalls);
		await first.emit("session_start", { type: "session_start", reason: "startup" });
		await first.run("claw", "on");
		await first.run("claw", "off");
		expect(clawEntries(session).at(-1)?.data).toEqual({ on: false });
		const next = await reload(first, cwd, session, ensureCalls);
		expect(clawModeOn()).toBe(false);
		expect(next.pi.active).toEqual(expect.not.arrayContaining(CLAW_TOOLS));
		expect(next.pi.active).toEqual(expect.arrayContaining(BASE));
		expect(clawAgentRoute()).toBeUndefined();
	});

	it("restores from the persisted saved set, not from a transcript that already shows the routed surface", async () => {
		const session: Session = { id: "chat-A", entries: [{ type: "custom", customType: CLAW_ENTRY, data: { on: true, savedTools: BASE } }] };
		// Fresh process: the active set already reflects Claw routing (no alternates).
		const routed = BASE.filter((n) => !CLAW_EXCLUDED_TOOLS.includes(n));
		const inst = instance(cwd, session, routed, ensureCalls);
		await inst.emit("session_start", { type: "session_start", reason: "startup" });
		expect(clawModeOn()).toBe(true);
		await inst.run("claw", "off");
		expect(inst.pi.active).toEqual(expect.arrayContaining(["Subagent", "BackgroundTask", "Delegate"]));
	});

	it("a new unrelated chat does not inherit Claw mode or inbox ownership", async () => {
		const a: Session = { id: "chat-A", entries: [] };
		const first = instance(cwd, a, ALL, ensureCalls);
		await first.emit("session_start", { type: "session_start", reason: "startup" });
		await first.run("claw", "on");
		await first.emit("session_shutdown", { type: "session_shutdown", reason: "new" });
		const b: Session = { id: "chat-B", entries: [] };
		const other = instance(cwd, b, ALL, ensureCalls);
		await other.emit("session_start", { type: "session_start", reason: "new" });
		expect(clawModeOn()).toBe(false);
		expect(other.pi.active).toEqual(expect.not.arrayContaining(CLAW_TOOLS));
		expect(other.pi.active).toEqual(expect.arrayContaining(["Subagent", "Agent"]));
		expect(ClawStore.forWorkspace(cwd).readOrchestrator().owner).not.toBe("chat-B");
	});

	it("session switch back to an off chat restores off; the switched-away chat keeps its own state", async () => {
		const a: Session = { id: "chat-A", entries: [] };
		const b: Session = { id: "chat-B", entries: [{ type: "custom", customType: CLAW_ENTRY, data: { on: true, savedTools: BASE } }] };
		const onB = instance(cwd, b, BASE, ensureCalls);
		await onB.emit("session_start", { type: "session_start", reason: "startup" });
		expect(clawModeOn()).toBe(true);
		await onB.emit("session_shutdown", { type: "session_shutdown", reason: "resume" });
		const onA = instance(cwd, a, BASE, ensureCalls);
		await onA.emit("session_start", { type: "session_start", reason: "resume" });
		expect(clawModeOn()).toBe(false);
		expect(onA.pi.active).not.toEqual(expect.arrayContaining(CLAW_TOOLS));
		expect(b.entries.filter((e) => e.customType === CLAW_ENTRY)).toHaveLength(1);
	});

	it("repeated reloads do not stack ensure calls, timers, or duplicate routing entries", async () => {
		const session: Session = { id: "chat-A", entries: [] };
		let cur = instance(cwd, session, ALL, ensureCalls);
		await cur.emit("session_start", { type: "session_start", reason: "startup" });
		await cur.run("claw", "on");
		for (let i = 0; i < 3; i++) cur = await reload(cur, cwd, session, ensureCalls);
		expect(clawModeOn()).toBe(true);
		expect(ensureCalls.n).toBe(1);
		expect(clawEntries(session)).toHaveLength(1);
		expect(cur.pi.active.filter((n: string) => n === "claw_spawn")).toHaveLength(1);
	});

	it("combined: Hoja and Claw both restored after reload, with Hoja's tools still active and rule present", async () => {
		const session: Session = { id: "chat-A", entries: [] };
		const first = instance(cwd, session, ALL, ensureCalls);
		await first.emit("session_start", { type: "session_start", reason: "startup" });
		await first.run("claw", "on");
		await first.run("hoja", "on");
		const next = await reload(first, cwd, session, ensureCalls);
		expect(clawModeOn()).toBe(true);
		expect(next.pi.active).toEqual(expect.arrayContaining(["hoja_list", "hoja_get", "claw_spawn"]));
		expect(await next.beforeAgent()).toContain(HOJA_RULE);
	});

	it("combined off: Hoja off and Claw off persist through reload; neither mode bleeds into the other", async () => {
		const session: Session = { id: "chat-A", entries: [] };
		const first = instance(cwd, session, ALL, ensureCalls);
		await first.emit("session_start", { type: "session_start", reason: "startup" });
		await first.run("claw", "on");
		await first.run("hoja", "off");
		const next = await reload(first, cwd, session, ensureCalls);
		expect(clawModeOn()).toBe(true);
		expect(await next.beforeAgent()).not.toContain(HOJA_RULE);
		expect(session.entries.filter((e) => e.customType === HOJA_ENTRY).at(-1)?.data).toEqual({ enabled: false });
	});
});

