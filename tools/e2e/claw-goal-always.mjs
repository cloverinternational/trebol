#!/usr/bin/env node
/**
 * Actual installed Pi, loopback scripted provider, the REAL Claw worker and goal extensions.
 * No network beyond 127.0.0.1, no credentials, no personal settings, no Hoja.
 *
 * Proves the always-on completion goal end to end on a throwaway run whose condition is a harmless file under /tmp:
 *   A. the loop repeats while the judge answers NOT_MET and stops when the /tmp condition becomes true (MET);
 *   B. claw_finish clears the goal BEFORE reporting, so the turn that follows pays for ZERO further judge calls.
 *
 * The run record, task file and goal spec are written with the same library functions the daemon uses; no Hoja issue is
 * created (this harness never touches the network).
 *
 *   node tools/e2e/claw-goal-always.mjs
 */
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const repo = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const JUDGE_MARK = "Evaluate the goal using observed evidence";

/** One scenario at a time: a real pi process against a scripted provider. */
async function scenario({ name, marker, main, judge, prompt }) {
	const root = mkdtempSync(join(tmpdir(), "claw-goal-e2e-"));
	const agent = join(root, "agent");
	const workspace = join(root, "workspace");
	const clawDir = join(root, "claw");
	const runId = `run-e2e-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
	mkdirSync(agent, { recursive: true });
	mkdirSync(workspace, { recursive: true });
	rmSync(marker, { force: true });

	// The run record, task file and goal spec exactly as the daemon writes them.
	const { ClawStore } = await import(join(repo, ".pi/lib/claw/store.ts"));
	const { startGoal, goalSpecOf, applyGoalEvent, goalRow } = await import(join(repo, ".pi/lib/claw/goal.ts"));
	const { taskFile } = await import(join(repo, ".pi/lib/claw/spawn.ts"));
	const store = new ClawStore(clawDir);
	const task = `Create the proof file ${marker} and report.\n\n- The file must exist when you report.\n- Report with claw_finish and list the file as evidence.`;
	const at = new Date().toISOString();
	const run = {
		id: runId, label: "goal-e2e", task, cwd: workspace, status: "running", phase: "tab_open",
		createdAt: at, updatedAt: at, project: "E2E", requestedAssignee: "me",
		eventsOffset: 0, settles: 0, attempts: 0, outbox: [], seen: [],
	};
	run.goal = startGoal(runId, task, at);
	store.saveRun(run);
	writeFileSync(store.taskPath(runId), taskFile(run));
	store.writeGoalSpec(goalSpecOf(runId, run.goal));

	const seen = { main: 0, judge: 0 };
	const server = createServer(async (req, res) => {
		let raw = "";
		for await (const chunk of req) raw += chunk;
		const body = JSON.parse(raw);
		const base = { id: "local", object: "chat.completion.chunk", created: 1, model: "script" };
		const send = (delta, finish) => {
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", ...delta }, finish_reason: null }] })}\n\n`);
			res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\n`);
			res.end("data: [DONE]\n\n");
		};
		if (JSON.stringify(body.messages).includes(JUDGE_MARK)) {
			seen.judge++;
			// A REAL /tmp condition: the judge reads the file, it is not told the answer.
			return send({ content: existsSync(marker) ? "MET" : "NOT_MET" }, "stop");
		}
		seen.main++;
		const step = main[Math.min(seen.main, main.length) - 1];
		const tool = step.toolCall;
		return send(tool
			? { tool_calls: [{ index: 0, id: `call-${seen.main}`, type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] }
			: { content: step.text }, tool ? "tool_calls" : "stop");
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	writeFileSync(join(agent, "models.json"), JSON.stringify({
		providers: { local: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: "openai-completions", apiKey: "dummy",
			models: [{ id: "script", contextWindow: 100000, maxTokens: 2048, reasoning: false }] } },
	}));

	const executable = process.env.PI_EXECUTABLE ?? "pi";
	const args = [
		"--model", "local/script", "--no-extensions",
		"--extension", join(repo, "extensions/claw/extension.ts"),
		"--extension", join(repo, "extensions/swarm-goal/extension.ts"),
		"--no-tools", "--tools", "bash,claw_finish,claw_goal",
		"--no-skills", "--no-context-files", "--mode", "json", "--print", "--approve", "--",
		prompt ?? `Read and execute your Claw task file in full: ${store.taskPath(runId)}`,
	];
	const child = spawn(executable, args, {
		cwd: workspace,
		env: { ...process.env, HOME: root, PI_CODING_AGENT_DIR: agent, PI_CLAW_RUN: runId, PI_CLAW_DIR: clawDir, PI_SWARM_SUBAGENT: "0" },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "", stderr = "";
	child.stdout.on("data", (b) => (stdout += b));
	child.stderr.on("data", (b) => (stderr += b));
	const timer = setTimeout(() => child.kill("SIGKILL"), 90_000);
	const code = await new Promise((r) => child.once("exit", r));
	clearTimeout(timer);
	server.close();

	const events = store.readEvents(runId, 0).items;
	const record = store.readGoalSpec(runId) ? store.getRun(runId) : store.getRun(runId);
	// Apply the worker's own events exactly as the daemon does, so the run record shows the real outcome.
	const daemon = store.getRun(runId);
	for (const event of events) if (event.type === "goal") applyGoalEvent(daemon, event.goal, event.at);
	return { name, code, stdout, stderr, events, goal: daemon.goal, row: goalRow(daemon.goal, Date.now()), runId };
}

const failures = [];
const check = (label, fn) => {
	try { fn(); console.log(`  ok   ${label}`); }
	catch (error) { failures.push(`${label}: ${error.message}`); console.log(`  FAIL ${label}: ${error.message}`); }
};
const goals = (result) => result.events.filter((e) => e.type === "goal").map((e) => e.goal);

// A: the loop repeats while the condition is false and stops when it becomes true.
{
	const marker = join(tmpdir(), `claw-goal-live-${process.pid}.txt`);
	console.log(`A. repeats on NOT_MET, stops on MET (condition: ${marker})`);
	const result = await scenario({
		name: "A", marker,
		main: [
			// Turn 1 alone cannot satisfy the condition: the file is not created yet.
			{ toolCall: { name: "bash", args: { command: `test -f ${marker} && echo present || echo absent` } } },
			{ text: "The file is not there yet; I will create it next." },
			// Turn 2, woken by the NOT_MET continuation, makes the condition true.
			{ toolCall: { name: "bash", args: { command: `touch ${marker} && echo created` } } },
			{ text: "The proof file now exists." },
		],
	});
	console.log(`  pi exit=${result.code} goal events=${goals(result).map((g) => g.state).join(",")}`);
	if (result.stderr.trim()) console.log(`  stderr: ${result.stderr.trim().split("\n").slice(-3).join(" | ")}`);
	check("the worker established the derived condition after launch", () => {
		const established = goals(result).find((g) => g.state === "established");
		assert.ok(established, `no established event: ${JSON.stringify(goals(result))}`);
		assert.match(established.condition, /Create the proof file/);
	});
	check("the judge answered NOT_MET before the condition was true", () => {
		assert.ok(goals(result).some((g) => g.state === "judged" && g.verdict === "NOT_MET"), JSON.stringify(goals(result)));
	});
	check("the loop stopped on MET once the /tmp condition became true", () => {
		assert.ok(goals(result).some((g) => g.state === "met"), JSON.stringify(goals(result)));
		assert.ok(existsSync(marker), "the worker never created the proof file");
	});
	check("the run record shows the met goal", () => assert.equal(result.goal?.status, "met"));
	rmSync(marker, { force: true });
}

// B: claw_finish clears the goal before reporting: no judge call is paid afterwards.
{
	const marker = join(tmpdir(), `claw-goal-live-finish-${process.pid}.txt`);
	console.log(`B. claw_finish clears the goal before reporting (zero further judge calls)`);
	const result = await scenario({
		name: "B", marker,
		main: [
			// Turn 1 settles with the condition still false: exactly one judge call, then one continuation.
			{ toolCall: { name: "bash", args: { command: "echo working" } } },
			{ text: "Still working." },
			// Turn 2 reports through claw_finish; the settle after it must not be judged again.
			{ toolCall: { name: "claw_finish", args: { outcome: "completed", summary: "Reported by the e2e harness", evidence: ["echo working"] } } },
			{ text: "Reported." },
		],
	});
	const judged = goals(result).filter((g) => g.state === "judged").length;
	console.log(`  pi exit=${result.code} goal events=${goals(result).map((g) => `${g.state}${g.reason ? `(${g.reason})` : ""}`).join(",")}`);
	if (result.stderr.trim()) console.log(`  stderr: ${result.stderr.trim().split("\n").slice(-3).join(" | ")}`);
	check("exactly one judge call happened, all before the report", () => assert.equal(judged, 1, `judged=${judged}`));
	check("the goal was cleared with reason finish", () => {
		const cleared = goals(result).find((g) => g.state === "cleared");
		assert.ok(cleared, JSON.stringify(goals(result)));
		assert.equal(cleared.reason, "finish");
	});
	check("the finish was recorded after the clear", () => {
		const order = result.events.map((e) => `${e.type}:${e.goal?.state ?? e.outcome ?? ""}`);
		const clearedAt = order.indexOf("goal:cleared");
		const finishAt = order.findIndex((entry) => entry.startsWith("finish:"));
		assert.ok(clearedAt >= 0 && finishAt > clearedAt, order.join(","));
	});
	check("the run record shows the cleared goal and no resurrection", () => {
		assert.equal(result.goal?.status, "cleared");
		assert.equal(result.goal?.endReason, "finish");
	});
	check("the launch prompt never carried the goal", () => {
		const prompt = `Read and execute your Claw task file in full: ${join("claw", "runs", `${result.runId}.task.md`)}`;
		assert.ok(!prompt.startsWith("/"), prompt);
	});
}

if (failures.length) {
	console.error(`FAIL ${failures.length} live check(s): ${failures.join("; ")}`);
	process.exit(1);
}
console.log("PASS always-on completion goal demonstrated live (real pi, real extensions, real /tmp condition)");
