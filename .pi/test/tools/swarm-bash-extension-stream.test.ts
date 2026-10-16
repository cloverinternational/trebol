import { describe, expect, it } from "vitest";
import { registerSwarmBash } from "../../../extensions/swarm-bash/extension.ts";

describe("registered foreground Bash streaming", () => {
	it("forwards the first pipe output through Pi's update callback before execute resolves", async () => {
		let tool: any;
		const pi = { registerTool(value: unknown) { tool = value; }, getCwd: () => process.cwd() };
		registerSwarmBash(pi);
		const updates: string[] = [];
		let completed = false;
		let early = false;
		const result = await tool.execute("stream-test", {
			command: "printf EARLY; sleep 0.25; printf LATE; printf ERR >&2", timeout_seconds: 60,
		}, undefined, (partial: { content: Array<{ text: string }> }) => {
			updates.push(partial.content[0]?.text ?? "");
			if (!completed && partial.content[0]?.text === "EARLY") early = true;
		}, { cwd: process.cwd() });
		completed = true;
		expect(early).toBe(true);
		expect(updates.at(-1)).toBe("EARLYLATEERR");
		expect(result.content[0].text).toContain("<result exit_code=\"0\"");
	});

	it("delivers stderr while executing and keeps the final stdout/stderr envelope separate", async () => {
		let tool: any;
		registerSwarmBash({ registerTool(value: unknown) { tool = value; } });
		const updates: string[] = [];
		let resolved = false;
		let sawEarlyError = false;
		const result = await tool.execute("stderr-test", {
			command: "printf EARLY_ERROR >&2; sleep 0.2; printf OUTPUT", timeout_seconds: 60,
		}, undefined, (partial: { content: Array<{ text: string }> }) => {
			const body = partial.content[0]?.text ?? "";
			updates.push(body);
			if (body === "EARLY_ERROR" && !resolved) sawEarlyError = true;
		}, { cwd: process.cwd() });
		resolved = true;
		expect(sawEarlyError).toBe(true);
		expect(updates.at(-1)).toBe("EARLY_ERROROUTPUT");
		expect(result.content[0].text).toContain("<stdout><![CDATA[OUTPUT]]>");
		expect(result.content[0].text).toContain("<stderr><![CDATA[EARLY_ERROR]]>");
	});
});
