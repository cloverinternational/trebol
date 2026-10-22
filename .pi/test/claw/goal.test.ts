/** TREBOL-325: every Claw worker runs under an ALWAYS-ON completion goal.
 *
 *  No turn cap, no deadline, no expiry, and not opt-in. The condition is derived from the task the run was spawned for
 *  and recorded on the run; the worker establishes it after launch in its own process (never through the positional
 *  launch prompt). Only semantic brakes end the loop, each exactly once: MET, IMPOSSIBLE, claw_finish (which clears the
 *  goal before reporting), cancellation, the worker's own question, and any terminal run state. Nothing bounds the loop,
 *  so status exposes its progress and one warning is raised for a goal that runs unusually long — without stopping it. */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyEvent, endRunGoal, isActive, tick, warnLongGoal, type DaemonDeps } from "../../lib/claw/daemon.ts";
import { ClawStore, TERMINAL, type ClawEvent, type Request, type Run } from "../../lib/claw/store.ts";
import { recordFinish } from "../../lib/claw/child.ts";
import { GOAL_LONG_MS, applyGoalEvent, deriveGoal, endGoal, goalRow, isGoalActive, startGoal } from "../../lib/claw/goal.ts";
import { taskFile, type ClawHoja } from "../../lib/claw/spawn.ts";
import { runListing, statusSummary } from "../../lib/claw/orchestrator.ts";
import { goalHost, registerSwarmGoal } from "../../lib/tools/swarm-goal.ts";
import type { IssueView } from "../../lib/claw/hoja.ts";
import clawExtension, { PI_ASK_STARTED_EVENT } from "../../../extensions/claw/extension.ts";

const TEAM = { teamId: "team-trebol", teamKey: "TREBOL", projectId: "proj-hoja", project: "Hoja", assigneeId: "user-luis", assignee: "Luis" };
/** A task shaped like a real Claw task: an objective, explicit requirements, and closing acceptance instructions. */
const TASK = `Add a retry to the uploader so a failed chunk is retried instead of aborting the whole upload.

Requirements:
- Retry a failed chunk at most three times with exponential backoff.
- Log every retry attempt with the chunk index.

Run the uploader tests and report their results. Do not change the public API.`;

function fakeHoja() {
	const issues = new Map<string, { id: string; identifier: string; description: string; state: string; comments: string[] }>();
	let n = 0;
	const hoja: ClawHoja = {
		async resolve(project: string) {
			if (project !== TEAM.project) throw new Error(`Hoja project "${project}" not found`);
			return { ...TEAM, states: { "in progress": "s-ip", "in review": "s-ir", done: "s-done" } };
		},
		async createIssue(_r: any, _title: string, description: string, state = "In Progress") {
			const issue = { id: `iss-${++n}`, identifier: `TREBOL-${900 + n}`, description, state, comments: [] as string[] };
			issues.set(issue.id, issue);
			return { id: issue.id, identifier: issue.identifier };
		},
		async readIssue(id: string): Promise<IssueView> {
			const i = issues.get(id);
			if (!i) throw new Error(`Hoja issue ${id} not found on read-back`);
			return { id: i.id, identifier: i.identifier, title: "", description: i.description, state: i.state, teamId: TEAM.teamId, projectId: TEAM.projectId, assigneeId: TEAM.assigneeId, comments: [...i.comments] };
		},
		async findIssueByMarker(marker: string) {
			const hit = [...issues.values()].find((i) => i.description.includes(marker));
			return hit ? { id: hit.id, identifier: hit.identifier } : undefined;
		},
		async comment(id: string, body: string) { issues.get(id)!.comments.push(body); },
		async setState(_r: any, id: string, state: string) { issues.get(id)!.state = state; },
	};
	return { hoja, issues };
}

function fakeTern() {
	const live = new Set<number>([1]);
	const calls: string[][] = [];
	let nextBlock = 100;
	const exec = async (args: string[]) => {
		calls.push(args);
		if (args[0] === "inspect") return JSON.stringify({ sessions: [{ id: 1, tabs: [{ id: 1, name: "Claw", blocks: [...live].map((id) => ({ id, exited: null, live: true })) }] }] });
		if (args[0] === "new") { const block = ++nextBlock; live.add(block); return JSON.stringify({ tab: block + 1000, block }); }
		if (args[0] === "close") { live.delete(Number(args[1])); return "{}"; }
		return "{}";
	};
	return { exec, live, calls };
}

/** A fake Pi that can host the REAL goal extension and the REAL Claw worker extension at once. */
function workerHarness(options: { evaluate?: any; branch?: any[] } = {}) {
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const handlers = new Map<string, ((...args: any[]) => any)[]>();
	const listeners: Record<string, (event: any) => void> = {};
	const entries: any[] = options.branch ?? [];
	const pi = {
		on: (name: string, handler: (...args: any[]) => any) => { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
		events: { on: (name: string, handler: (event: any) => void) => { listeners[name] = handler; } },
		registerTool: (tool: any) => { tools.set(tool.name, tool); },
		registerCommand: (name: string, command: any) => { commands.set(name, command); },
		// The goal state persists through the session branch, exactly as Pi does it.
		appendEntry: (customType: string, data: unknown) => { entries.push({ type: "custom_message", customType, data }); },
		sendMessage: vi.fn(async () => undefined),
	};
	const ctx = {
		ui: { notify: vi.fn() },
		sessionManager: { getBranch: () => entries, getSessionFile: () => "/tmp/session.jsonl" },
		model: { id: "judge-model" },
		modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, headers: {} }) },
	};
	const emit = async (name: string, event: any = {}) => {
		let result: any;
		for (const handler of handlers.get(name) ?? []) {
			const payload = name === "agent_before_settle"
				? { outcome: "completed", continue: false, entries: [], context: { canContinue: true, contextMessages: [] }, ...event }
				: event;
			const next = await handler(payload, ctx);
			if (next) result = next;
		}
		return result;
	};
	return { pi, tools, commands, handlers, listeners, entries, ctx, emit };
}

describe("claw completion goal: derivation", () => {
	it("derives the objective and the acceptance criteria the task states, deterministically", () => {
		const derived = deriveGoal(TASK)!;
		expect(derived.objective).toContain("Add a retry to the uploader");
		// Explicit requirements are criteria, and so are the closing instructions the task states as constraints.
		expect(derived.criteria).toEqual(expect.arrayContaining([
			expect.stringContaining("Retry a failed chunk at most three times"),
			expect.stringContaining("Log every retry attempt"),
		]));
		expect(derived.criteria.join(" ")).toContain("Run the uploader tests and report their results");
		expect(derived.criteria.join(" ")).toContain("Do not change the public API");
		// The same task always yields the same condition: a judge verdict must be reproducible.
		expect(deriveGoal(TASK)).toEqual(derived);
		expect(derived.condition).toContain("Acceptance criteria:");
		expect(derived.condition).toContain("MET requires evidence");
	});

	it("prefers the task section and ignores the task file's own scaffolding", () => {
		const derived = deriveGoal(`# Claw worker — run run-1\n\nYou are a worker started by the Claw orchestrator.\n\n## Task\n\nShip the CSV export with a header row.\n\n- The header row names every column.\n`)!;
		expect(derived.objective).toBe("Ship the CSV export with a header row.");
		expect(derived.criteria).toEqual(["The header row names every column."]);
		expect(derived.condition).not.toContain("You are a worker started by the Claw orchestrator");
	});

	it("bounds the condition under the goal command's limit even for a very long task", () => {
		const long = ["Do the thing.", ...Array.from({ length: 40 }, (_, i) => `- Requirement ${i}: ${"detail ".repeat(40)}`)].join("\n\n");
		const derived = deriveGoal(long)!;
		expect(derived.condition.length).toBeLessThanOrEqual(3500);
		expect(derived.criteria.length).toBeLessThanOrEqual(8);
	});

	it("a task with no objective derives nothing instead of inventing a goal", () => {
		expect(deriveGoal("")).toBeUndefined();
		expect(deriveGoal("   \n\n  ")).toBeUndefined();
		expect(deriveGoal("<!-- claw-run:run-1 -->")).toBeUndefined();
		expect(startGoal("run-x", "", "2026-10-22T10:00:00.000Z")).toMatchObject({ status: "unavailable", source: "claw:run-x" });
	});
});

describe("claw completion goal: spawn records it, launch never carries it", () => {
	let dir: string;
	let store: ClawStore;
	let deps: DaemonDeps;
	let clock: Date;
	let pids: Set<number>;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "claw-goal-"));
		store = ClawStore.forWorkspace(dir);
		clock = new Date("2026-10-22T10:00:00.000Z");
		pids = new Set<number>([4242]);
		const { hoja } = fakeHoja();
		const tern = fakeTern();
		deps = { store, hoja, tern: tern.exec, workspace: dir, now: () => clock, alive: (p) => pids.has(p) || p === process.pid, signal: (p) => { pids.delete(p); } };
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	let spawns = 0;
	const spawn = async (task = TASK) => {
		store.writeRequest({ id: `req-goal1-${++spawns}`, kind: "spawn", createdAt: clock.toISOString(), expiresAt: new Date(clock.getTime() + 60_000).toISOString(), input: { task, project: "Hoja" } } as Request);
		await tick(deps);
		const run = store.listRuns().at(-1)!;
		expect(run.phase).toBe("tab_open");
		return store.getRun(run.id)!;
	};
	const worker = (run: Run, options: { evaluate?: any; branch?: any[] } = {}) => {
		const harness = workerHarness(options);
		const prev = { run: process.env.PI_CLAW_RUN, dir: process.env.PI_CLAW_DIR };
		process.env.PI_CLAW_RUN = run.id; process.env.PI_CLAW_DIR = store.dir;
		try {
			// Real load order: the goal extension registers before Claw.
			registerSwarmGoal(harness.pi, { evaluate: options.evaluate ?? (async () => "MET") });
			clawExtension(harness.pi);
		} finally { process.env.PI_CLAW_RUN = prev.run; process.env.PI_CLAW_DIR = prev.dir; }
		return harness;
	};
	const goalEvents = (run: Run) => store.readEvents(run.id, 0).items.filter((e): e is ClawEvent & { goal: NonNullable<ClawEvent["goal"]> } => e.type === "goal");

	it("every worker run records a derived goal, its spec, and it in the task file — but not in the launch prompt", async () => {
		const run = await spawn();
		expect(run.goal).toMatchObject({ status: "pending", source: `claw:${run.id}`, turns: 0, judgeCalls: 0 });
		expect(run.goal!.condition).toContain("Add a retry to the uploader");
		expect(run.goal!.condition).toContain("Do not change the public API");
		// Auditable on disk, and handed to the worker as a file, not through the positional prompt.
		expect(store.readGoalSpec(run.id)).toMatchObject({ runId: run.id, source: `claw:${run.id}`, condition: run.goal!.condition });
		const file = taskFile(run);
		expect(file).toContain("## Completion goal (always on)");
		expect(file).toContain(run.goal!.condition);
		// The launch prompt stays the plain instruction: a leading slash would be dispatched as a command, not a turn.
		const launched = fakeTern().calls;
		expect(launched).toEqual([]);
		expect(`Read and execute your Claw task file in full: ${store.taskPath(run.id)}`).not.toMatch(/^\//);
	});

	it("a task with no derivable goal launches anyway, records unavailable, and writes no spec", async () => {
		const run = await spawn("<!-- no objective here -->");
		expect(run.goal).toMatchObject({ status: "unavailable" });
		expect(run.goal!.condition).toBe("");
		expect(store.readGoalSpec(run.id)).toBeUndefined();
		expect(existsSync(store.goalPath(run.id))).toBe(false);
		expect(taskFile(run)).not.toContain("Completion goal (always on)");
		const harness = worker(run);
		await harness.emit("session_start");
		await harness.emit("before_agent_start");
		expect(goalEvents(run)[0].goal).toMatchObject({ state: "unavailable" });
		expect(harness.tools.has("claw_finish")).toBe(true);
	});
});

describe("claw completion goal: the loop", () => {
	let dir: string;
	let store: ClawStore;
	let deps: DaemonDeps;
	let clock: Date;
	let pids: Set<number>;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "claw-goal-loop-"));
		store = ClawStore.forWorkspace(dir);
		clock = new Date("2026-10-22T10:00:00.000Z");
		pids = new Set<number>([4242]);
		const { hoja } = fakeHoja();
		const tern = fakeTern();
		deps = { store, hoja, tern: tern.exec, workspace: dir, now: () => clock, alive: (p) => pids.has(p) || p === process.pid, signal: (p) => { pids.delete(p); } };
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	let spawns = 0;
	const spawn = async (task = TASK) => {
		store.writeRequest({ id: `req-goal2-${++spawns}`, kind: "spawn", createdAt: clock.toISOString(), expiresAt: new Date(clock.getTime() + 60_000).toISOString(), input: { task, project: "Hoja" } } as Request);
		await tick(deps);
		const run = store.listRuns().at(-1)!;
		store.appendEvent({ eid: `started-${spawns}`, type: "started", at: clock.toISOString(), runId: run.id, pid: 4242 });
		await tick(deps);
		return store.getRun(run.id)!;
	};
	const worker = (run: Run, options: { evaluate?: any; branch?: any[] } = {}) => {
		const harness = workerHarness(options);
		const prev = { run: process.env.PI_CLAW_RUN, dir: process.env.PI_CLAW_DIR };
		process.env.PI_CLAW_RUN = run.id; process.env.PI_CLAW_DIR = store.dir;
		try {
			registerSwarmGoal(harness.pi, { evaluate: options.evaluate ?? (async () => "MET") });
			clawExtension(harness.pi);
		} finally { process.env.PI_CLAW_RUN = prev.run; process.env.PI_CLAW_DIR = prev.dir; }
		return harness;
	};
	const events = (run: Run) => store.readEvents(run.id, 0).items;
	const goalEvents = (run: Run) => events(run).filter((e) => e.type === "goal");

	it("establishes the derived condition after launch, through the worker's own process", async () => {
		const run = await spawn();
		const harness = worker(run);
		await harness.emit("session_start");
		await harness.emit("before_agent_start");

		expect(goalHost(harness.pi)!.status()).toMatchObject({ status: "active", source: `claw:${run.id}`, condition: run.goal!.condition });
		expect(goalEvents(run)[0].goal).toMatchObject({ state: "established", condition: run.goal!.condition });
		// A second turn must not establish a second goal.
		await harness.emit("before_agent_start");
		expect(goalEvents(run)).toHaveLength(1);
		expect(harness.entries.filter((e) => e.customType === "pi-swarm-goal")).toHaveLength(1);
	});

	it("repeats while the judge answers NOT_MET and stops on MET, with no turn cap and no expiry", async () => {
		const run = await spawn();
		// 40 consecutive NOT_MET verdicts: the loop must keep going (there is no cap to hit).
		const verdicts = [...Array(40).fill("NOT_MET"), "MET"];
		const evaluate = vi.fn(async () => verdicts.shift() ?? "MET");
		const harness = worker(run, { evaluate });
		await harness.emit("session_start");
		await harness.emit("before_agent_start");
		for (let turn = 1; turn <= 40; turn++) {
			const continuation = await harness.emit("agent_before_settle");
			expect(continuation, `turn ${turn} must continue`).toMatchObject({ continue: true });
			expect(continuation.entries[0].content).toContain("NOT_MET");
		}
		expect(evaluate).toHaveBeenCalledTimes(40);
		expect(goalHost(harness.pi)!.status()).toMatchObject({ status: "active", turns: 40, judgeCalls: 40 });
		// The 41st settlement is MET: the loop ends and nothing is continued.
		expect(await harness.emit("agent_before_settle")).toBeUndefined();
		expect(goalHost(harness.pi)!.status()).toMatchObject({ status: "met", lastVerdict: "MET" });
		expect(goalHost(harness.pi)!.status()!.turns).toBe(40);
	});

	it("stops on IMPOSSIBLE exactly like MET, once", async () => {
		const run = await spawn();
		const evaluate = vi.fn(async () => "IMPOSSIBLE");
		const harness = worker(run, { evaluate });
		await harness.emit("session_start");
		await harness.emit("before_agent_start");
		expect(await harness.emit("agent_before_settle")).toBeUndefined();
		expect(goalHost(harness.pi)!.status()).toMatchObject({ status: "impossible" });
		// Nothing further is judged: the brake is final.
		await harness.emit("agent_before_settle");
		expect(evaluate).toHaveBeenCalledTimes(1);
	});

	it("claw_finish clears the goal BEFORE reporting, so zero further judge calls happen", async () => {
		const run = await spawn();
		const evaluate = vi.fn(async () => "NOT_MET");
		const harness = worker(run, { evaluate });
		await harness.emit("session_start");
		await harness.emit("before_agent_start");
		// One continued turn, then the worker reports.
		expect(await harness.emit("agent_before_settle")).toMatchObject({ continue: true });
		expect(evaluate).toHaveBeenCalledTimes(1);
		await harness.tools.get("claw_finish")!.execute("c1", { outcome: "completed", summary: "Retry added", evidence: ["npm test: 12 passed"] });
		// The settle that follows the reporting turn must not pay for a judge call (the measured zombie loop).
		expect(await harness.emit("agent_before_settle")).toBeUndefined();
		expect(evaluate).toHaveBeenCalledTimes(1);
		expect(goalHost(harness.pi)!.status()).toBeUndefined();
		// Cleared first, reported second: the daemon sees the brake before the result.
		// (a "started" event also comes from the worker's own session_start)
		expect(events(run).filter((e) => e.type !== "started").map((e) => `${e.type}:${e.goal?.state ?? e.outcome ?? ""}`)).toEqual(["goal:established", "goal:judged", "goal:cleared", "finish:completed"]);
		const cleared = events(run).find((e) => e.type === "goal" && e.goal!.state === "cleared")!;
		expect(cleared.goal!.reason).toBe("finish");
		expect(harness.entries.at(-1)).toMatchObject({ customType: "pi-swarm-goal", data: { status: "cleared", source: `claw:${run.id}` } });

		await tick(deps);
		const after = store.getRun(run.id)!;
		expect(after.status).toBe("completed");
		expect(after.goal).toMatchObject({ status: "cleared", endReason: "finish" });
		expect(existsSync(store.goalPath(run.id))).toBe(false);
	});

	it("a worker question ends the loop once, so no judge call is paid while a human decides", async () => {
		const run = await spawn();
		const evaluate = vi.fn(async () => "NOT_MET");
		const harness = worker(run, { evaluate });
		await harness.emit("session_start");
		await harness.emit("before_agent_start");
		harness.listeners[PI_ASK_STARTED_EVENT]({ version: 1, flowId: "tool:c1", source: "tool", questions: [{ id: "branch" }], createdAt: 1 });
		expect(goalHost(harness.pi)!.status()).toBeUndefined();
		expect(await harness.emit("agent_before_settle", { outcome: "completed" })).toBeUndefined();
		expect(evaluate).not.toHaveBeenCalled();
		const cleared = goalEvents(run).find((e) => e.goal!.state === "cleared")!;
		expect(cleared.goal!.reason).toBe("awaiting_decision");
	});

	it("a task can widen the goal but nothing in the worker can remove it", async () => {
		const run = await spawn();
		const harness = worker(run);
		await harness.emit("session_start");
		await harness.emit("before_agent_start");
		const widened = await harness.tools.get("claw_goal")!.execute("g1", { action: "widen", criteria: "The retry metric is exported in the health endpoint." });
		expect(widened.content[0].text).toContain("The retry metric is exported in the health endpoint.");
		expect(goalHost(harness.pi)!.status()!.condition).toContain("The retry metric is exported in the health endpoint.");
		expect(goalHost(harness.pi)!.status()!.condition).toContain("Add a retry to the uploader");
		// The worker surface has no remove action, and the host offers widening only.
		expect(harness.tools.get("claw_goal")!.parameters.properties.action.enum).toEqual(["status", "widen"]);
		await expect(harness.tools.get("claw_goal")!.execute("g2", { action: "widen", criteria: "  " })).rejects.toThrow("criteria is required");
		await expect(harness.tools.get("claw_goal")!.execute("g3", { action: "clear" })).rejects.toThrow("action must be status or widen");
		expect(isGoalActive({ ...startGoal(run.id, TASK, clock.toISOString()), status: "active" })).toBe(true);
	});

	it("a judge provider error ends the loop once and leaves the worker with an ordinary turn", async () => {
		const run = await spawn();
		const evaluate = vi.fn(async () => { throw new Error("invalid api key"); });
		const harness = worker(run, { evaluate });
		await harness.emit("session_start");
		await harness.emit("before_agent_start");
		expect(await harness.emit("agent_before_settle")).toBeUndefined();
		expect(goalHost(harness.pi)!.status()).toMatchObject({ status: "error" });
		expect(harness.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("invalid api key"), "error");
		await harness.emit("agent_before_settle");
		expect(evaluate).toHaveBeenCalledTimes(1);
		await tick(deps);
		const after = store.getRun(run.id)!;
		expect(after.goal).toMatchObject({ status: "error", endReason: "error" });
		expect(after.status).not.toBe("lost");
		expect(isActive(after)).toBe(true);
		expect(store.readInbox(0).items.some((i) => i.kind === "run_goal_ended" && i.text.includes("error"))).toBe(true);
	});
});

describe("claw completion goal: brakes, restart and observability on the daemon side", () => {
	let dir: string;
	let store: ClawStore;
	let deps: DaemonDeps;
	let clock: Date;
	let pids: Set<number>;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "claw-goal-daemon-"));
		store = ClawStore.forWorkspace(dir);
		clock = new Date("2026-10-22T10:00:00.000Z");
		pids = new Set<number>([4242]);
		const { hoja } = fakeHoja();
		const tern = fakeTern();
		deps = { store, hoja, tern: tern.exec, workspace: dir, now: () => clock, alive: (p) => pids.has(p) || p === process.pid, signal: (p) => { pids.delete(p); } };
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	let spawns = 0;
	const spawn = async () => {
		store.writeRequest({ id: `req-goal3-${++spawns}`, kind: "spawn", createdAt: clock.toISOString(), expiresAt: new Date(clock.getTime() + 60_000).toISOString(), input: { task: TASK, project: "Hoja" } } as Request);
		await tick(deps);
		const run = store.listRuns().at(-1)!;
		store.appendEvent({ eid: `started-${spawns}`, type: "started", at: clock.toISOString(), runId: run.id, pid: 4242 });
		await tick(deps);
		return store.getRun(run.id)!;
	};
	const goalEvent = (run: Run, eid: string, goal: NonNullable<ClawEvent["goal"]>) =>
		store.appendEvent({ eid, type: "goal", at: clock.toISOString(), runId: run.id, goal });
	const kinds = () => store.readInbox(0).items.map((i) => i.kind);

	it("applies the worker's goal events to the run: condition, counters, verdict", async () => {
		const run0 = await spawn();
		goalEvent(run0, "g1", { state: "established", condition: run0.goal!.condition });
		await tick(deps);
		let run = store.getRun(run0.id)!;
		expect(run.goal).toMatchObject({ status: "active", condition: run0.goal!.condition });
		expect(run.goal!.establishedAt).toBe(clock.toISOString());
		goalEvent(run0, "g2", { state: "judged", verdict: "NOT_MET", turns: 1, judgeCalls: 1 });
		goalEvent(run0, "g3", { state: "judged", verdict: "NOT_MET", turns: 2, judgeCalls: 2 });
		await tick(deps);
		run = store.getRun(run0.id)!;
		expect(run.goal).toMatchObject({ status: "active", turns: 2, judgeCalls: 2, lastVerdict: "NOT_MET" });
		goalEvent(run0, "g4", { state: "met", verdict: "MET", turns: 2, judgeCalls: 3 });
		await tick(deps);
		run = store.getRun(run0.id)!;
		expect(run.goal).toMatchObject({ status: "met", endReason: "met", turns: 2, judgeCalls: 3, lastVerdict: "MET" });
		expect(kinds()).toContain("run_goal_ended");
	});

	it("status exposes condition, turns used, judge calls, last verdict and elapsed time", async () => {
		const run0 = await spawn();
		goalEvent(run0, "g1", { state: "established", condition: run0.goal!.condition });
		goalEvent(run0, "g2", { state: "judged", verdict: "NOT_MET", turns: 7, judgeCalls: 7 });
		await tick(deps);
		clock = new Date(Date.parse(clock.toISOString()) + 90_000);
		await tick(deps);
		const row = statusSummary(store, clock.getTime()).goals.find((g) => g.id === run0.id)!;
		expect(row).toMatchObject({ status: "active", turns: 7, judgeCalls: 7, lastVerdict: "NOT_MET", condition: run0.goal!.condition });
		expect(row.elapsedSeconds).toBe(90);
		const listed = runListing(store.listRuns(), clock.getTime()).find((r) => r.id === run0.id)!;
		expect(listed.goal).toMatchObject({ turns: 7, judgeCalls: 7, lastVerdict: "NOT_MET" });
	});

	it("a long-running goal raises ONE warning and keeps looping: the warning never stops the run", async () => {
		const run0 = await spawn();
		goalEvent(run0, "g1", { state: "established", condition: run0.goal!.condition });
		await tick(deps);
		clock = new Date(Date.parse(clock.toISOString()) + GOAL_LONG_MS + 60_000);
		await tick(deps);
		let run = store.getRun(run0.id)!;
		const warnings = () => store.readInbox(0).items.filter((i) => i.kind === "run_goal_long");
		expect(warnings()).toHaveLength(1);
		expect(warnings()[0].text).toContain("warning, not a stop");
		expect(run.goal).toMatchObject({ status: "active" });
		expect(run.status).not.toBe("failed");
		expect(isActive(run)).toBe(true);
		// Still looping afterwards: later events keep counting and no second warning appears.
		goalEvent(run0, "g2", { state: "judged", verdict: "NOT_MET", turns: 1, judgeCalls: 1 });
		clock = new Date(clock.getTime() + 60_000);
		await tick(deps);
		run = store.getRun(run0.id)!;
		expect(warnings()).toHaveLength(1);
		expect(run.goal).toMatchObject({ status: "active", turns: 1, judgeCalls: 1 });
		expect(warnLongGoal(run, store, clock.getTime() + GOAL_LONG_MS)).toBe(false);
	});

	it("needs_user, cancellation and terminal states end the goal exactly once", async () => {
		// needs_user
		const run0 = await spawn();
		goalEvent(run0, "g1", { state: "established", condition: run0.goal!.condition });
		recordFinish(store, run0.id, { outcome: "needs_user", summary: "Which branch?", evidence: [] });
		await tick(deps);
		let run = store.getRun(run0.id)!;
		expect(run.status).toBe("awaiting_user");
		expect(run.goal).toMatchObject({ status: "cleared", endReason: "needs_user" });
		expect(store.readGoalSpec(run0.id)).toBeUndefined();
		expect(endRunGoal(run, store, "needs_user", clock.toISOString())).toBe(false);
		expect(endGoal(run, "terminal", clock.toISOString())).toBe(false);

		// cancellation
		const run1 = await spawn();
		goalEvent(run1, "g1", { state: "established", condition: run1.goal!.condition });
		await tick(deps);
		store.writeRequest({ id: "req-cancel", kind: "cancel", createdAt: clock.toISOString(), runId: run1.id } as Request);
		await tick(deps);
		run = store.getRun(run1.id)!;
		expect(run.status).toBe("cancelled");
		expect(run.goal).toMatchObject({ status: "cleared", endReason: "cancel" });
		expect(store.readGoalSpec(run1.id)).toBeUndefined();
		const cancelNotices = store.readInbox(0).items.filter((i) => i.kind === "run_cancelled");
		await tick(deps);
		expect(store.readInbox(0).items.filter((i) => i.kind === "run_cancelled")).toHaveLength(cancelNotices.length);
	});

	it("a daemon restart mid-goal resumes the persisted goal and never duplicates it", async () => {
		const run0 = await spawn();
		goalEvent(run0, "g1", { state: "established", condition: run0.goal!.condition });
		goalEvent(run0, "g2", { state: "judged", verdict: "NOT_MET", turns: 3, judgeCalls: 3 });
		await tick(deps);
		const before = store.getRun(run0.id)!;
		expect(before.goal).toMatchObject({ status: "active", turns: 3, judgeCalls: 3 });
		const establishedAt = before.goal!.establishedAt;

		// A fresh daemon process reads the same store: the goal (and its counters) is exactly where it was.
		const restarted: DaemonDeps = { ...deps, now: () => new Date(clock.getTime() + 5_000) };
		await tick(restarted);
		let run = store.getRun(run0.id)!;
		expect(run.goal).toMatchObject({ status: "active", turns: 3, judgeCalls: 3, establishedAt });
		expect(isActive(run)).toBe(true);

		// A restarted worker re-runs its establishment: the same source is already active, so nothing is duplicated and
		// the original establishment time (elapsed time and the long-run warning depend on it) is preserved.
		const later = new Date(clock.getTime() + 120_000).toISOString();
		expect(applyGoalEvent(run, { state: "established", condition: run0.goal!.condition }, later)).toBe(true);
		expect(run.goal).toMatchObject({ turns: 3, judgeCalls: 3, establishedAt });
		expect(run.goal!.establishedAt).toBe(establishedAt);
		expect(store.listRuns()).toHaveLength(1);
	});

	it("a worker that reported before its goal was established is not restarted by the late goal event", async () => {
		const run0 = await spawn();
		recordFinish(store, run0.id, { outcome: "completed", summary: "Done fast", evidence: ["npm test: 9 passed"] });
		await tick(deps);
		let run = store.getRun(run0.id)!;
		expect(run.status).toBe("completed");
		expect(run.goal).toMatchObject({ status: "cleared", endReason: "finish" });
		// The establishment arrives late (the worker started establishing as it finished). It is ignored, both for a
		// terminal run and — independently — for a goal that already ended.
		applyEvent(run, { eid: "late", type: "goal", at: clock.toISOString(), runId: run0.id, goal: { state: "established", condition: "late" } }, store);
		expect(applyGoalEvent({ goal: { ...run.goal! } }, { state: "established", condition: "late" }, clock.toISOString())).toBe(false);
		expect(run.goal).toMatchObject({ status: "cleared", endReason: "finish" });
		expect(run.goal!.condition).toBe(run0.goal!.condition);
		store.saveRun(run);
		await tick(deps);
		run = store.getRun(run0.id)!;
		expect(run.status).toBe("completed");
		expect(run.goal).toMatchObject({ status: "cleared" });
		expect(store.readInbox(0).items.filter((i) => i.kind === "run_goal_ended")).toHaveLength(0);
	});

	it("a duplicate met event ends the goal once and never repeats its notice", async () => {
		const run0 = await spawn();
		goalEvent(run0, "g1", { state: "established", condition: run0.goal!.condition });
		await tick(deps);
		goalEvent(run0, "g2", { state: "met", verdict: "MET", judgeCalls: 4 });
		goalEvent(run0, "g3", { state: "met", verdict: "MET", judgeCalls: 4 });
		await tick(deps);
		const run = store.getRun(run0.id)!;
		expect(run.goal).toMatchObject({ status: "met", judgeCalls: 4 });
		expect(store.readInbox(0).items.filter((i) => i.kind === "run_goal_ended")).toHaveLength(1);
	});

	it("goalRow reports an ended goal without pretending it is still running", () => {
		const goal = { ...startGoal("run-r", TASK, "2026-10-22T10:00:00.000Z"), status: "active" as const, establishedAt: "2026-10-22T10:00:00.000Z" };
		const target = { goal: { ...goal } };
		endGoal(target, "cancel", "2026-10-22T10:10:00.000Z");
		expect(goalRow(target.goal, Date.now())).toMatchObject({ status: "cleared", endReason: "cancel", elapsedSeconds: 600 });
		expect(goalRow(undefined, Date.now())).toBeUndefined();
	});

	it("a goal spec written by an older daemon is still read safely", async () => {
		const run0 = await spawn();
		writeFileSync(store.goalPath(run0.id), JSON.stringify({ runId: run0.id, source: `claw:${run0.id}`, condition: "Ship it", criteria: [] }));
		expect(store.readGoalSpec(run0.id)).toMatchObject({ condition: "Ship it" });
		writeFileSync(store.goalPath(run0.id), "not json");
		expect(store.readGoalSpec(run0.id)).toBeUndefined();
	});
});
