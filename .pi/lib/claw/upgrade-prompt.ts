/** The /upgrade template, shared by the `/upgrade` command (extensions/upgrade-prompt) and the Claw worker launch.
 *  It lives in the Claw library because the daemon builds a worker's first turn from it: the daemon's import closure and
 *  its code fingerprint (fingerprint.ts) cover only this directory, so a template elsewhere would neither load in a
 *  copied daemon tree nor restart a running daemon when it changes. */

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
