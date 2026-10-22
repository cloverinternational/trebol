// Pure factual summaries of tool steps for the work table. No model output, no raw argument dumps.
import { describe, expect, it } from "vitest";
import { activityView, currentTaskLine, summarizeWorkStep, type WorkStep } from "../../lib/tern/work-summary.ts";

describe("work step summaries (pure)", () => {
	it("names known tools with a plain action and a target from recognized arguments only", () => {
		expect(summarizeWorkStep({ id: "t-1", name: "read", args: { path: "src/a.ts", offset: 1, secret: "x" }, status: "ok", took: 120 }))
			.toEqual({ id: "t-1", label: "Read", target: "src/a.ts", result: "Done · 120 ms", tone: "success" });
	});

	it("reads the filePath alias used by file tools", () => {
		expect(summarizeWorkStep({ id: "t-6", name: "Edit", args: { filePath: "src/b.ts" }, status: "ok" })).toMatchObject({ label: "Edit", target: "src/b.ts" });
	});

	it("shows a bash description as its target, and otherwise only the command's executable name", () => {
		const running = summarizeWorkStep({ id: "t-2", name: "bash", args: { command: "cat ~/.ssh/id_rsa", description: "Check build" }, status: "running", startedAt: 0 });
		expect(running).toMatchObject({ label: "Run", target: "Check build", result: "Running", tone: "pending" });
		expect(JSON.stringify(running)).not.toContain("id_rsa");
		const bare = summarizeWorkStep({ id: "t-3", name: "bash", args: { command: "npm test --token=abc" }, status: "ok", took: 5 });
		expect(bare.target).toBe("npm");
		expect(JSON.stringify(bare)).not.toContain("token");
	});

	it("keeps only a plain executable name, and rejects a leading env assignment or quoting instead of skipping it", () => {
		expect(summarizeWorkStep({ id: "t-7", name: "bash", args: { command: "./scripts/deploy.sh --prod" }, status: "ok" }).target).toBe("deploy.sh");
		const assigned = summarizeWorkStep({ id: "t-7b", name: "bash", args: { command: "API_KEY=sk-secret ./scripts/deploy.sh --prod" }, status: "ok" });
		expect(assigned.target).toBeUndefined();
		expect(JSON.stringify(assigned)).not.toContain("sk-secret");
		const quotedEnv = summarizeWorkStep({ id: "t-7c", name: "bash", args: { command: "TOKEN=\"alpha secret-fragment\" ./run" }, status: "ok" });
		expect(quotedEnv.target).toBeUndefined();
		expect(JSON.stringify(quotedEnv)).not.toContain("secret-fragment");
		expect(summarizeWorkStep({ id: "t-8", name: "bash", args: { command: "\"quoted secret\" x" }, status: "ok" }).target).toBeUndefined();
		expect(summarizeWorkStep({ id: "t-9", name: "bash", args: { command: "   " }, status: "ok" }).target).toBeUndefined();
	});

	it("names apply_patch by the files its headers change, bounded and without the patch body", () => {
		const input = "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-old secret\n+new\n*** Add File: src/new.ts\n+body\n*** Delete File: old/x.ts\n*** End Patch";
		const row = summarizeWorkStep({ id: "t-p", name: "apply_patch", args: { input }, status: "ok", took: 9 });
		expect(row).toEqual({ id: "t-p", label: "Patch", target: "src/a.ts, src/new.ts +1 more", result: "Done · 9 ms", tone: "success" });
		expect(JSON.stringify(row)).not.toContain("secret");
		expect(summarizeWorkStep({ id: "t-q", name: "apply_patch", args: { input: "no headers" }, status: "ok" }).target).toBeUndefined();
	});

	it("keeps unknown tool names and never guesses a target", () => {
		expect(summarizeWorkStep({ id: "t-4", name: "mcp__x__frob", args: { id: 9 }, status: "ok" }))
			.toEqual({ id: "t-4", label: "mcp__x__frob", result: "Done", tone: "success" });
	});

	it("states failures, exit codes, timeouts and cancellations explicitly", () => {
		expect(summarizeWorkStep({ id: "a", name: "bash", status: "error", exit: 2, took: 10 })).toMatchObject({ result: "Failed · exit 2 · 10 ms", tone: "error" });
		expect(summarizeWorkStep({ id: "b", name: "bash", status: "error", timedOut: true })).toMatchObject({ result: "Timed out", tone: "warning" });
		expect(summarizeWorkStep({ id: "c", name: "read", status: "error", cancelled: true })).toMatchObject({ result: "Cancelled", tone: "muted" });
		expect(summarizeWorkStep({ id: "d", name: "read", status: "error" })).toMatchObject({ result: "Failed", tone: "error" });
	});

	it("bounds targets to one short line", () => {
		const row = summarizeWorkStep({ id: "t-5", name: "read", args: { path: "a\n".repeat(200) }, status: "ok" });
		expect(row.target!.length).toBeLessThanOrEqual(80);
		expect(row.target).not.toMatch(/\n/);
	});

	it("labels the current task line from the supplied focus only", () => {
		expect(currentTaskLine({ id: "7", subject: "Build\nthe table" })).toBe("Current task · #7 Build the table");
	});
});

describe("live activity view (pure)", () => {
	const run = (id: string, name = "read", args: unknown = { path: `${id}.ts` }): WorkStep => ({ id, name, args, status: "running" });
	const done = (step: WorkStep, doneSeq: number, status: "ok" | "error" = "ok"): WorkStep => ({ ...step, status, doneSeq, took: 10 });

	it("shows at most three active rows in call order and counts the overflow", () => {
		const steps = [run("a"), run("b"), run("c"), run("d"), run("e")];
		const view = activityView(steps);
		expect(view.active.map((r) => r.id)).toEqual(["a", "b", "c"]);
		expect(view.moreActive).toBe(2);
	});

	it("reports the latest completion by completion order, not by call order", () => {
		const a = run("a");
		const b = run("b");
		const late = activityView([done(a, 2), done(b, 1)]);
		expect(late.latest?.id).toBe("a");
		expect(activityView([done(a, 1), run("c")]).latest?.id).toBe("a");
	});

	it("keeps a failure indicator after later steps succeed, and names the latest failure", () => {
		const view = activityView([done(run("a", "bash", { description: "Build" }), 1, "error"), done(run("b"), 2), run("c")]);
		expect(view.failed).toEqual({ count: 1, last: expect.objectContaining({ id: "a", label: "Run", target: "Build" }) });
	});

	it("does not count cancelled steps as failures and never shows a running step as the latest result", () => {
		const cancelled = { ...run("x"), status: "error" as const, cancelled: true, doneSeq: 1 };
		const view = activityView([cancelled, run("y")]);
		expect(view.failed).toBeUndefined();
		expect(view.latest).toBeUndefined();
	});

	it("uses the authoritative task, else a labelled request, else no heading at all", () => {
		expect(activityView([], { id: "7", subject: "Fix login" }, "fix").heading).toBe("Current task · #7 Fix login");
		expect(activityView([], undefined, "fix the login bug").heading).toBe("Request · fix the login bug");
		expect(activityView([]).heading).toBeUndefined();
	});
});
