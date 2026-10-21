/** /upgrade <prompt>: wraps the typed prompt in the upgrade template and submits it as a follow-up user turn. */

export const UPGRADE_TEMPLATE = `I want a deeper version of this task, not a bigger one. Before rewriting the prompt below:
(1) Say what a top professional in this field would do here that the prompt does not ask for.
(2) Name the rawest material they would start from instead of what has already been digested for me (primary sources, raw logs, data, code, original documents).
(3) Name the specific methods and tools they would use.
(4) Say what, other than you or me, would show the result is right (an independent check, test, measurement, or outside source).
Then rewrite the prompt to ask for exactly that, keep its original scope, and run the rewritten prompt.`;

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
}

export default function upgradePrompt(pi: any) { registerUpgradePrompt(pi); }
