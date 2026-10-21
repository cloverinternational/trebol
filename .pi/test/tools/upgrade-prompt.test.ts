import { describe, expect, it } from "vitest";
import { buildUpgradePrompt, registerUpgradePrompt, UPGRADE_TEMPLATE } from "../../../extensions/upgrade-prompt/extension.ts";

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
			registerCommand: (_: string, spec: any) => { handler = spec.handler; },
			sendUserMessage: (text: string) => { sent.push(text); },
		});
		await handler!("  ", { ui: { notify: (m: string) => warnings.push(m) } });
		expect(sent).toHaveLength(0);
		expect(warnings).toEqual(["Usage: /upgrade <prompt>"]);
	});
});
