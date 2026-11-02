import { describe, expect, it } from "vitest";
import { buildUpgradePrompt, GOAL_CONDITION_LIMIT, registerUpgradePrompt, UPGRADE_TEMPLATE } from "../../../extensions/upgrade-prompt/extension.ts";
import { goalHostForSession, registerSwarmGoal } from "../../lib/tools/swarm-goal.ts";

/**
 * Pi gives every extension its own API object and module instance, so this builds the split the real runtime has:
 * the goal extension registers on `goalPi`, the upgrade commands on another object, and they meet only through the
 * process-global host table keyed by session id.
 */
async function goalSession(sessionId: string) {
	const sent: { text: string; options: unknown }[] = [];
	const notices: { text: string; level?: string }[] = [];
	const handlers = new Map<string, any[]>();
	const goalPi = {
		registerCommand: () => {},
		registerTool: () => {},
		on: (name: string, handler: any) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
		appendEntry: () => {},
		sendMessage: () => {},
	};
	const ctx = {
		ui: { notify: (text: string, level?: string) => notices.push({ text, level }) },
		sessionManager: { getSessionId: () => sessionId, getBranch: () => [] },
	};
	registerSwarmGoal(goalPi, { evaluate: async () => "MET" });
	for (const handler of handlers.get("session_start") ?? []) await handler({}, ctx);
	let handler: ((args: string, ctx: any) => Promise<void>) | undefined;
	registerUpgradePrompt({
		registerCommand: (name: string, spec: any) => { if (name === "upgradegoal") handler = spec.handler; },
		sendUserMessage: (text: string, options: unknown) => { sent.push({ text, options }); },
	});
	return { ctx, sent, notices, run: (args: string) => handler!(args, ctx), goal: () => goalHostForSession(ctx)?.status() };
}

describe("/upgrade", () => {
	it("returns undefined for empty input", () => {
		expect(buildUpgradePrompt("   ")).toBeUndefined();
	});

	it("wraps the trimmed prompt after the template", () => {
		const message = buildUpgradePrompt("  summarize the outage  ")!;
		expect(message.startsWith(UPGRADE_TEMPLATE)).toBe(true);
		expect(message.endsWith("<prompt>\nsummarize the outage\n</prompt>")).toBe(true);
	});

	it("submits exactly one follow-up turn with the wrapped prompt", async () => {
		const sent: { text: string; options: unknown }[] = [];
		let handler: ((args: string, ctx: any) => Promise<void>) | undefined;
		registerUpgradePrompt({
			registerCommand: (name: string, spec: any) => { if (name === "upgrade") handler = spec.handler; },
			sendUserMessage: (text: string, options: unknown) => { sent.push({ text, options }); },
		});
		await handler!("fix the build", {});
		expect(sent).toHaveLength(1);
		expect(sent[0].text).toBe(buildUpgradePrompt("fix the build"));
		expect(sent[0].options).toEqual({ deliverAs: "followUp", triggerTurn: true });
	});

	it("sends nothing and warns on empty input", async () => {
		const sent: string[] = [];
		const warnings: string[] = [];
		let handler: ((args: string, ctx: any) => Promise<void>) | undefined;
		registerUpgradePrompt({
			registerCommand: (name: string, spec: any) => { if (name === "upgrade") handler = spec.handler; },
			sendUserMessage: (text: string) => { sent.push(text); },
		});
		await handler!("  ", { ui: { notify: (m: string) => warnings.push(m) } });
		expect(sent).toHaveLength(0);
		expect(warnings).toEqual(["Usage: /upgrade <prompt>"]);
	});
});

describe("/upgradegoal", () => {
	it("sets the goal to the upgraded prompt and starts that same prompt once", async () => {
		const session = await goalSession("upgradegoal-established");
		await session.run("  fix the build  ");
		const message = buildUpgradePrompt("fix the build")!;
		expect(session.goal()).toMatchObject({ condition: message, status: "active" });
		expect(session.sent).toEqual([{ text: message, options: { deliverAs: "followUp", triggerTurn: true } }]);
		expect(session.notices.filter((n) => n.level === "warning")).toEqual([]);
	});

	it("refuses an over-long condition before anything is set or sent", async () => {
		const session = await goalSession("upgradegoal-too-long");
		const prompt = "x".repeat(GOAL_CONDITION_LIMIT);
		const length = buildUpgradePrompt(prompt)!.length;
		expect(length).toBeGreaterThan(GOAL_CONDITION_LIMIT);
		await session.run(prompt);
		expect(session.goal()).toBeUndefined();
		expect(session.sent).toEqual([]);
		expect(session.notices).toEqual([{
			text: `Goal condition is ${length} characters; the limit is ${GOAL_CONDITION_LIMIT}. Shorten the prompt and try again.`,
			level: "warning",
		}]);
	});

	it("refuses a second goal instead of replacing the active one", async () => {
		const session = await goalSession("upgradegoal-already-active");
		await session.run("first task");
		await session.run("second task");
		expect(session.goal()?.condition).toBe(buildUpgradePrompt("first task"));
		expect(session.sent).toHaveLength(1);
		expect(session.notices.at(-1)).toEqual({
			text: "No goal was created: a goal is already active in this session. Clear it with /goal clear first.",
			level: "warning",
		});
	});

	it("refuses when no goal host is loaded rather than silently running a plain upgrade", async () => {
		const sent: string[] = [];
		const notices: { text: string; level?: string }[] = [];
		let handler: ((args: string, ctx: any) => Promise<void>) | undefined;
		registerUpgradePrompt({
			registerCommand: (name: string, spec: any) => { if (name === "upgradegoal") handler = spec.handler; },
			sendUserMessage: (text: string) => { sent.push(text); },
		});
		const ctx = {
			ui: { notify: (text: string, level?: string) => notices.push({ text, level }) },
			sessionManager: { getSessionId: () => "upgradegoal-no-host", getBranch: () => [] },
		};
		await handler!("fix the build", ctx);
		expect(sent).toEqual([]);
		expect(goalHostForSession(ctx)).toBeUndefined();
		expect(notices).toEqual([{
			text: "No goal was created: the swarm-goal extension is not loaded in this session. Use /upgrade to run the prompt without a goal.",
			level: "warning",
		}]);
	});
});
