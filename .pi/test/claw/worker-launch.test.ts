/** The worker tab must start from the identity-aware plan, and its stderr must be captured so a
 *  startup failure names a reason instead of only "lost". */
import { describe, expect, it } from "vitest";
import { launchArguments, workerCommand } from "../../lib/claw/launcher.ts";
import { PI_BUILTIN_EXTENSIONS, type LaunchPlan } from "../../lib/claw/launch-plan.ts";

const spec = (extra: Record<string, unknown> = {}) => workerCommand({ session: 1, cwd: "/w", label: "x", runId: "run-1", clawDir: "/c", prompt: "p", ...extra });
const line = (extra: Record<string, unknown> = {}) => spec(extra)[2];
const plan: LaunchPlan = { mode: "explicit", extensions: ["/wt/extensions/tool.js"], builtins: ["codemode", "mcp"], kept: ["/wt"], dropped: ["/main"] };

describe("worker launch arguments", () => {
	it("keeps Pi's own discovery when there is nothing to deduplicate", () => {
		expect(launchArguments(undefined)).toEqual([]);
		expect(launchArguments({ mode: "discovery" })).toEqual([]);
		expect(line()).not.toContain("--no-extensions");
	});

	it("replaces package discovery with the planned extension list and the built-ins it re-adds", () => {
		expect(launchArguments(plan)).toEqual(["--no-extensions", "--extension", "/wt/extensions/tool.js", "--extension", "builtin:codemode", "--extension", "builtin:mcp"]);
		const command = line({ plan });
		expect(command).toContain("pi --name 'x' '--no-extensions' '--extension' '/wt/extensions/tool.js' '--extension' 'builtin:codemode'");
		expect(command).toContain("'p'");
	});

	it("falls back to ignoring project-local files when the plan cannot enumerate local sources", () => {
		const ignored: LaunchPlan = { mode: "project-ignored", kept: ["/main"], dropped: ["/wt"], reason: "remote source" };
		expect(launchArguments(ignored)).toEqual(["--no-approve"]);
	});

	it("names the built-ins the host ships, so a replaceable one is not silently dropped", () => {
		expect([...PI_BUILTIN_EXTENSIONS]).toContain("codemode");
		expect([...PI_BUILTIN_EXTENSIONS]).toContain("mcp");
	});

	it("captures the worker's stderr only when a log path is given, leaving stdout a terminal", () => {
		expect(line({ logPath: "/c/runs/run-1.worker.log" })).toContain("2> >(tee -a '/c/runs/run-1.worker.log' >&2)");
		expect(line()).not.toContain("tee");
		expect(line({ logPath: "/c/runs/run-1.worker.log" })).not.toContain(">/dev/null");
	});
});
