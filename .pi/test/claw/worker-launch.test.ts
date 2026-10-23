/** The worker tab must start from the identity-aware plan, and its stderr must be captured so a
 *  startup failure names a reason instead of only "lost". */
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { launchArguments, workerCommand, workerShell } from "../../lib/claw/launcher.ts";
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

describe("worker shell resolution", () => {
	it("prefers PI_CLAW_SHELL, then the login shell, then zsh", () => {
		const all = () => true;
		expect(workerShell({ PI_CLAW_SHELL: "/opt/homebrew/bin/zsh", SHELL: "/bin/bash" }, all)).toEqual({ shell: "/opt/homebrew/bin/zsh", flags: "-lic" });
		expect(workerShell({ SHELL: "/bin/bash" }, all).shell).toBe("/bin/bash");
		expect(workerShell({}, all).shell).toBe("/bin/zsh");
	});

	it("skips a shell that is not zsh or bash, and one that is not installed", () => {
		expect(workerShell({ SHELL: "/usr/bin/fish" }, () => true).shell).toBe("/bin/zsh");
		expect(workerShell({ SHELL: "/bin/zsh" }, (path) => path === "/bin/bash").shell).toBe("/bin/bash");
		expect(workerShell({ PI_CLAW_SHELL: "zsh" }, () => true).shell).toBe("/bin/zsh");
	});

	it("refuses the launch when no usable login shell exists", () => {
		expect(() => workerShell({}, () => false)).toThrow(/PI_CLAW_SHELL/);
	});

	it("launches this host through an installed shell with -lic, so the profile exports reach the worker", () => {
		const command = spec();
		expect(command[1]).toBe("-lic");
		expect(existsSync(command[0])).toBe(true);
		expect(command[0]).toMatch(/zsh|bash$/);
	});
});
