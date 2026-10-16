import { describe, expect, it } from "vitest";
import { runSwarmBash } from "../../lib/tools/swarm-bash.ts";

describe("live bash capture", () => {
	it("emits first stdout before exit, preserves stderr and split UTF-8", async () => {
		const updates: Array<{ stdout: string; stderr: string }> = [];
		let firstBeforeExit = false;
		let settled = false;
		const promise = runSwarmBash({ command: "printf first; sleep 0.25; printf second; printf err >&2", timeout_seconds: 60 }, {
			defaultCwd: process.cwd(),
			onOutput: (stdout, stderr) => { updates.push({ stdout, stderr }); if (stdout === "first" && !settled) firstBeforeExit = true; },
		}).then((result) => { settled = true; return result; });
		const result = await promise;
		expect(firstBeforeExit).toBe(true);
		expect(updates.at(-1)).toEqual({ stdout: "firstsecond", stderr: "err" });
		expect(result).toMatchObject({ stdout: "firstsecond", stderr: "err", exitCode: 0 });
	});

	it("does not expose a replacement character for split UTF-8 bytes", async () => {
		const updates: string[] = [];
		const result = await runSwarmBash({ command: "printf '\\342'; sleep 0.1; printf '\\202\\254'", timeout_seconds: 60 }, {
			defaultCwd: process.cwd(), onOutput: (stdout) => updates.push(stdout),
		});
		expect(updates).not.toContain("�");
		expect(updates.at(-1)).toBe("€");
		expect(result).toMatchObject({ stdout: "€", exitCode: 0 });
	});

	it("streams stderr while the process is still running", async () => {
		let earlyError = false;
		let finished = false;
		const result = await runSwarmBash({ command: "printf ALERT >&2; sleep 0.2; printf done", timeout_seconds: 60 }, {
			defaultCwd: process.cwd(),
			onOutput: (_stdout, stderr) => { if (stderr === "ALERT" && !finished) earlyError = true; },
		}).then((value) => { finished = true; return value; });
		expect(earlyError).toBe(true);
		expect(result).toMatchObject({ stdout: "done", stderr: "ALERT", exitCode: 0 });
	});

	it("preserves observed stdout/stderr arrival order in the live display", async () => {
		const views: string[] = [];
		await runSwarmBash({ command: "printf one; sleep 0.08; printf two >&2; sleep 0.08; printf three", timeout_seconds: 60 }, {
			defaultCwd: process.cwd(), onOutput: (_out, _err, display) => views.push(display),
		});
		expect(views).toContain("one");
		expect(views).toContain("onetwo");
		expect(views.at(-1)).toBe("onetwothree");
	});

	it("keeps output captured before cancellation and terminates the process", async () => {
		const controller = new AbortController();
		const updates: string[] = [];
		const result = await runSwarmBash({ command: "printf before; sleep 10", timeout_seconds: 60 }, {
			defaultCwd: process.cwd(), signal: controller.signal,
			onOutput: (stdout) => { updates.push(stdout); if (stdout === "before") controller.abort(); },
		});
		expect(updates).toContain("before");
		expect(result).toMatchObject({ stdout: "before", exitCode: -1 });
	});

	it("does not spawn when already cancelled", async () => {
		const controller = new AbortController();
		controller.abort();
		const result = await runSwarmBash({ command: "printf must-not-run", timeout_seconds: 60 }, {
			defaultCwd: process.cwd(), signal: controller.signal,
		});
		expect(result).toMatchObject({ error: "Error executing bash: command cancelled" });
	});
});
