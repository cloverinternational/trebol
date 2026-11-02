/** /upgrade <prompt>: wraps the typed prompt in the upgrade template and submits it as a follow-up user turn. */

import { establishGoal, goalHostForSession } from "../../.pi/lib/tools/swarm-goal.ts";

export const UPGRADE_TEMPLATE = `I want a deeper version of this task, not a bigger one. Before rewriting the prompt below:
(1) Say what a top professional in this field would do here that the prompt does not ask for.
(2) Name the rawest material they would start from instead of what has already been digested for me (primary sources, raw logs, data, code, original documents).
(3) Name the specific methods and tools they would use.
(4) Say what, other than you or me, would show the result is right (an independent check, test, measurement, or outside source).
Then rewrite the prompt to ask for exactly that, keep its original scope, and run the rewritten prompt.`;

/** A goal condition is persisted and judged whole, and the goal host rejects anything longer. */
export const GOAL_CONDITION_LIMIT = 4000;

export function buildUpgradePrompt(input: string): string | undefined {
	const prompt = input.trim();
	if (!prompt) return undefined;
	return `${UPGRADE_TEMPLATE}\n\n<prompt>\n${prompt}\n</prompt>`;
}

export function registerUpgradePrompt(pi: any) {
	pi.registerCommand?.("upgrade", {
		description: "Upgrade a prompt into a deeper version, then run it: /upgrade <prompt>",
		handler: async (args: string, ctx: any) => {
			const message = buildUpgradePrompt(args ?? "");
			if (!message) return ctx?.ui?.notify?.("Usage: /upgrade <prompt>", "warning");
			await (ctx?.sendUserMessage ?? pi.sendUserMessage)?.(message, { deliverAs: "followUp", triggerTurn: true });
		},
	});
	// /upgradegoal reuses the /upgrade wrapper as BOTH the goal condition and the submitted turn, so the loop
	// judges exactly the work the prompt asks for and there is no second template that can drift. The goal is
	// established before anything is sent: a goal that started after the turn would judge work it never asked for.
	pi.registerCommand?.("upgradegoal", {
		description: "Upgrade a prompt into a deeper version, set it as the goal, and start it: /upgradegoal <prompt>",
		handler: async (args: string, ctx: any) => {
			const notify = (text: string, level: string) => ctx?.ui?.notify?.(text, level);
			const message = buildUpgradePrompt(args ?? "");
			if (!message) return notify("Usage: /upgradegoal <prompt>", "warning");
			if (message.length > GOAL_CONDITION_LIMIT)
				return notify(`Goal condition is ${message.length} characters; the limit is ${GOAL_CONDITION_LIMIT}. Shorten the prompt and try again.`, "warning");
			// Refuse instead of degrading: a silent plain /upgrade would leave the user believing a goal is running.
			const outcome = establishGoal(goalHostForSession(ctx), { condition: message });
			if (outcome === "missing") return notify("No goal was created: the swarm-goal extension is not loaded in this session. Use /upgrade to run the prompt without a goal.", "warning");
			if (outcome === "existing") return notify("No goal was created: a goal is already active in this session. Clear it with /goal clear first.", "warning");
			notify("Goal set from the upgraded prompt. /goal status to inspect it, /goal clear to stop.", "info");
			await (ctx?.sendUserMessage ?? pi.sendUserMessage)?.(message, { deliverAs: "followUp", triggerTurn: true });
		},
	});
}

export default function upgradePrompt(pi: any) { registerUpgradePrompt(pi); }
