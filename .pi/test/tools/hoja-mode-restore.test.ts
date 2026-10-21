import { describe, expect, it } from "vitest";
import { HOJA_ENTRY, HOJA_RULE, registerHojaMode } from "../../../extensions/hoja-mode/extension.ts";

type Session = { id: string; entries: any[] };

/** One extension instance over a session; /reload and session switches create a new instance with that session's entries. */
function instance(session: Session) {
	const handlers: Record<string, Function[]> = {};
	const commands = new Map<string, any>();
	const tools: string[] = [];
	const pi: any = {
		on: (name: string, fn: Function) => { (handlers[name] ??= []).push(fn); },
		registerTool: (t: any) => { tools.push(t.name); },
		registerCommand: (name: string, def: any) => { commands.set(name, def); },
		appendEntry: (customType: string, data: unknown) => { session.entries.push({ type: "custom", customType, data }); },
	};
	registerHojaMode(pi, { gql: async () => ({ issues: { nodes: [] } }) } as any);
	const ctx = { sessionManager: { getSessionId: () => session.id, getBranch: () => session.entries } };
	return {
		tools,
		start: async (reason: string) => { for (const fn of handlers.session_start ?? []) await fn({ type: "session_start", reason }, ctx); },
		run: async (args: string) => { await commands.get("hoja").handler(args, { ui: { notify: () => undefined } }); },
		rule: async () => { let out = ""; for (const fn of handlers.before_agent_start ?? []) { const r = await fn({ systemPrompt: "" }, ctx); if (r?.systemPrompt) out = r.systemPrompt; } return out; },
	};
}

describe("hoja-mode persistence per chat", () => {
	it("a new chat starts on, and its default does not come from another chat's off", async () => {
		const a: Session = { id: "A", entries: [] };
		const hojaA = instance(a);
		await hojaA.start("startup");
		await hojaA.run("off");
		const b: Session = { id: "B", entries: [] };
		const hojaB = instance(b);
		await hojaB.start("new");
		expect(await hojaB.rule()).toContain(HOJA_RULE);
		const backToA = instance(a);
		await backToA.start("resume");
		expect(await backToA.rule()).toBe("");
	});

	it("off persists through a same-session reload, and on after off also persists", async () => {
		const s: Session = { id: "A", entries: [] };
		const first = instance(s);
		await first.start("startup");
		await first.run("off");
		const afterOff = instance(s);
		await afterOff.start("reload");
		expect(await afterOff.rule()).toBe("");
		await afterOff.run("on");
		const afterOn = instance(s);
		await afterOn.start("reload");
		expect(await afterOn.rule()).toContain(HOJA_RULE);
		expect(s.entries.filter((e) => e.customType === HOJA_ENTRY)).toHaveLength(2);
	});

	it("a chat saved as off stays off on resume, and registers each Hoja tool once per instance", async () => {
		const s: Session = { id: "A", entries: [{ type: "custom", customType: HOJA_ENTRY, data: { enabled: false } }] };
		const inst = instance(s);
		await inst.start("resume");
		expect(await inst.rule()).toBe("");
		expect(inst.tools).toEqual(["hoja_list", "hoja_get"]);
	});
});
