import { describe, expect, it } from "vitest";
import { workerCommand } from "../../lib/claw/launcher.ts";
import { workerModel } from "../../lib/claw/spawn.ts";

const line = (extra: object) => workerCommand({ session: 1, cwd: "/w", label: "x", runId: "run-1", clawDir: "/c", prompt: "p", ...extra })[2];

describe("worker provider and model", () => {
	it("passes --provider and --model to pi when chosen", () => {
		expect(line({ provider: "anthropic", model: "claude-opus-5-5" })).toContain("pi --name 'x' --provider 'anthropic' --model 'claude-opus-5-5' 'p'");
	});

	it("omits both flags by default so pi uses its configured model", () => {
		expect(line({})).toContain("pi --name 'x' 'p'");
		expect(line({})).not.toMatch(/--model|--provider/);
	});

	it("accepts a model alone, including provider/id form", () => {
		expect(workerModel({ model: "openai/gpt-4o" })).toEqual({ provider: undefined, model: "openai/gpt-4o" });
		expect(line({ model: "openai/gpt-4o" })).toContain("--model 'openai/gpt-4o'");
	});

	it("refuses a provider without a model, and trims blanks to the default", () => {
		expect(() => workerModel({ provider: "anthropic" })).toThrow(/provider needs model/);
		expect(workerModel({ provider: "  ", model: "" })).toEqual({ provider: undefined, model: undefined });
	});

	it("refuses values that are not plain identifiers, so nothing reaches the shell unquoted", () => {
		expect(() => workerModel({ provider: "anthropic", model: "x; rm -rf ~" })).toThrow(/plain identifiers/);
		expect(() => workerModel({ provider: "a b", model: "m" })).toThrow(/plain identifiers/);
	});
});
