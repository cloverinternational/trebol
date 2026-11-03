/** /upgrade <prompt>: wraps the typed prompt in the upgrade template and submits it as a follow-up user turn. */

import { buildUpgradePrompt } from "../../.pi/lib/claw/upgrade-prompt.ts";
import { establishGoal, goalHostForSession } from "../../.pi/lib/tools/swarm-goal.ts";

/** A goal condition is persisted and judged whole, and the goal host rejects anything longer. */
export const GOAL_CONDITION_LIMIT = 4000;

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
