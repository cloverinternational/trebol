import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tick, claimLock, applyEvent, runDaemon, type DaemonDeps } from "../../lib/claw/daemon.ts";
import { ClawStore, readLines, type Run, type Trigger, type Request } from "../../lib/claw/store.ts";
import { validateFinish, recordFinish, recordSettled, lastAssistant, WORKER_BLOCKED_TOOLS } from "../../lib/claw/child.ts";
import { HojaClient, type IssueView } from "../../lib/claw/hoja.ts";
import { runMarker, type ClawHoja } from "../../lib/claw/spawn.ts";
import { findRunBlock } from "../../lib/claw/launcher.ts";
import clawExtension from "../../../extensions/claw/extension.ts";

type FakeIssue = { id: string; identifier: string; title: string; description: string; state: string; teamId: string; projectId: string; assigneeId: string; comments: string[] };

function fakeHoja() {
	const issues = new Map<string, FakeIssue>();
	const calls = { create: 0, comment: 0, setState: 0, states: [] as string[] };
	let n = 0;
	const team = { teamId: "team-trebol", teamKey: "TREBOL", projectId: "proj-crm", project: "CRM Clover File", assigneeId: "user-luis", assignee: "Luis" };
	const hoja: ClawHoja = {
		async resolve(project: string) {
			if (project !== team.project) throw new Error(`Hoja project "${project}" not found`);
			return { ...team, states: { "in progress": "s-ip", "in review": "s-ir", done: "s-done" } };
		},
		async createIssue(_r: any, title: string, description: string, state = "In Progress") {
			calls.create++;
			n++;
			const issue: FakeIssue = { id: `iss-${n}`, identifier: `TREBOL-${900 + n}`, title, description, state, teamId: team.teamId, projectId: team.projectId, assigneeId: team.assigneeId, comments: [] };
			issues.set(issue.id, issue);
			return { id: issue.id, identifier: issue.identifier };
		},
		async readIssue(id: string): Promise<IssueView> {
			const i = issues.get(id);
			if (!i) throw new Error(`Hoja issue ${id} not found on read-back`);
			return { id: i.id, identifier: i.identifier, title: i.title, description: i.description, state: i.state, teamId: i.teamId, projectId: i.projectId, assigneeId: i.assigneeId, comments: [...i.comments] };
		},
		async findIssueByMarker(marker: string) {
			const hit = [...issues.values()].find((i) => i.description.includes(marker));
			return hit ? { id: hit.id, identifier: hit.identifier } : undefined;
		},
		async comment(id: string, body: string) { calls.comment++; issues.get(id)!.comments.push(body); },
		async setState(_r: any, id: string, state: string) { calls.setState++; calls.states.push(state); issues.get(id)!.state = state; },
	};
	return { hoja, issues, calls, team };
}

function fakeTern() {
	const live = new Set<number>([1]);
	const calls: string[][] = [];
	const state = { failNew: false, nextBlock: 100 };
	const exec = async (args: string[]) => {
		calls.push(args);
		if (args[0] === "inspect") return JSON.stringify({ sessions: [{ id: 1, tabs: [{ id: 1, name: "Claw", blocks: [...live].map((id) => ({ id, exited: null, live: true })) }] }] });
		if (args[0] === "new") {
			if (state.failNew) throw new Error("tern refused");
			const block = ++state.nextBlock;
			live.add(block);
			return JSON.stringify({ tab: block + 1000, block });
		}
		if (args[0] === "close") { live.delete(Number(args[1])); return "{}"; }
		return "{}";
	};
	return { exec, live, calls, state, opened: () => calls.filter((c) => c[0] === "new").length };
}

describe("claw store", () => {
	let dir: string;
	beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "claw-store-")); });
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("reads whole JSON lines and leaves a partial trailing line for the next read", () => {
		const path = join(dir, "x.jsonl");
		writeFileSync(path, '{"a":1}\n{"b":2}\n{"c"');
		const first = readLines<{ a?: number; b?: number }>(path, 0);
		expect(first.items).toEqual([{ a: 1 }, { b: 2 }]);
		writeFileSync(path, '{"a":1}\n{"b":2}\n{"c":3}\n');
		expect(readLines<{ c?: number }>(path, first.offset).items).toEqual([{ c: 3 }]);
	});

	it("skips a corrupt line without blocking the stream", () => {
		const path = join(dir, "y.jsonl");
		writeFileSync(path, 'not-json\n{"ok":true}\n');
		expect(readLines<{ ok?: boolean }>(path, 0).items).toEqual([{ ok: true }]);
	});

	it("appends inbox items once per key (replay safe)", () => {
		const store = new ClawStore(dir);
		store.appendInbox({ kind: "notify", text: "hi", key: "k1" });
		store.appendInbox({ kind: "notify", text: "hi again", key: "k1" });
		expect(store.readInbox(0).items).toHaveLength(1);
	});

	it("is absent-means-on for control", () => {
		const store = new ClawStore(dir);
		expect(store.readControl().enabled).toBe(true);
		store.writeControl(false);
		expect(store.readControl().enabled).toBe(false);
	});
});

describe("claw daemon", () => {
	let dir: string;
	let store: ClawStore;
	let fh: ReturnType<typeof fakeHoja>;
	let tern: ReturnType<typeof fakeTern>;
	let deps: DaemonDeps;
	let clock: Date;
	let pids: Set<number>;
	let signals: number[];

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "claw-daemon-"));
		store = ClawStore.forWorkspace(dir);
		fh = fakeHoja();
		tern = fakeTern();
		clock = new Date("2026-10-21T10:00:00.000Z");
		pids = new Set([4242]);
		signals = [];
		deps = { store, hoja: fh.hoja, tern: tern.exec, workspace: dir, now: () => clock, alive: (p) => pids.has(p), signal: (p) => { signals.push(p); pids.delete(p); } };
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	const request = (r: Omit<Request, "createdAt">) => store.writeRequest({ ...r, createdAt: clock.toISOString() } as Request);
	const spawnReq = (id = "req-a1", task = "Check the build", extra: Record<string, unknown> = {}) =>
		request({ id, kind: "spawn", input: { task, project: "CRM Clover File", ...extra } } as any);
	const response = (id: string) => store.readResponse(id);
	const runs = () => store.listRuns();
	const worker = (run: Run, type: "started" | "settled" | "finish", extra: Record<string, unknown> = {}) =>
		store.appendEvent({ eid: `${type}-${Math.random().toString(36).slice(2)}`, type, at: clock.toISOString(), runId: run.id, ...extra } as any);

	it("spawn creates one Hoja issue and one worker tab, then reports the Hoja identifier", async () => {
		spawnReq();
		await tick(deps);
		const res = response("req-a1");
		expect(res?.ok).toBe(true);
		const [run] = runs();
		expect(run.phase).toBe("tab_open");
		expect(run.hoja?.identifier).toMatch(/^TREBOL-/);
		expect(fh.calls.create).toBe(1);
		expect(tern.opened()).toBe(1);
		expect(fh.issues.get(run.hoja!.issueId)!.description).toContain(runMarker(run.id));
		expect(fh.issues.get(run.hoja!.issueId)!.state).toBe("In Progress");
	});

	it("a duplicate spawn request is served once", async () => {
		spawnReq("req-dup");
		await tick(deps);
		spawnReq("req-dup");
		await tick(deps);
		expect(runs()).toHaveLength(1);
		expect(fh.calls.create).toBe(1);
		expect(tern.opened()).toBe(1);
	});

	it("settled is idle, never completed; only an explicit finish with evidence completes and moves to In Review, never Done", async () => {
		spawnReq();
		await tick(deps);
		const [run0] = runs();
		worker(run0, "started", { pid: 4242, sessionFile: "/tmp/s.jsonl" });
		await tick(deps);
		worker(run0, "settled", { text: "I looked at it.", stopReason: "stop" });
		await tick(deps);
		let run = store.getRun(run0.id)!;
		expect(run.status).toBe("idle");
		expect(fh.calls.states).toEqual([]);
		expect(store.readInbox(0).items.map((i) => i.kind)).toContain("run_idle");

		worker(run, "finish", { outcome: "completed", summary: "Build fixed", evidence: ["npm test: 12 passed"] });
		await tick(deps);
		run = store.getRun(run0.id)!;
		expect(run.status).toBe("completed");
		expect(fh.calls.states).toEqual(["In Review"]);
		expect(fh.calls.states).not.toContain("Done");
		const issue = fh.issues.get(run.hoja!.issueId)!;
		expect(issue.state).toBe("In Review");
		expect(issue.comments.some((c) => c.includes("npm test: 12 passed"))).toBe(true);
	});

	it("duplicate and replayed finish events are applied once (one comment, one state change)", async () => {
		spawnReq();
		await tick(deps);
		const [run0] = runs();
		const ev = { eid: "finish-fixed-1", type: "finish", at: clock.toISOString(), runId: run0.id, outcome: "completed", summary: "done", evidence: ["ls ok"] } as const;
		store.appendEvent(ev as any);
		store.appendEvent(ev as any);
		await tick(deps);
		store.appendEvent({ ...ev, eid: "finish-other" } as any);
		await tick(deps);
		const run = store.getRun(run0.id)!;
		expect(run.status).toBe("completed");
		expect(fh.issues.get(run.hoja!.issueId)!.comments.filter((c) => c.includes("reported **completed**"))).toHaveLength(1);
		expect(fh.calls.setState).toBe(1);
	});

	it("a completion without evidence is downgraded to failed even when written directly", async () => {
		spawnReq();
		await tick(deps);
		const [run0] = runs();
		worker(run0, "finish", { outcome: "completed", summary: "trust me", evidence: [] });
		await tick(deps);
		const run = store.getRun(run0.id)!;
		expect(run.status).toBe("failed");
		expect(run.finish?.summary).toContain("completed requires evidence");
		expect(fh.calls.states).toEqual([]);
	});

	it("needs_user is reported as awaiting_user and is not completion", async () => {
		spawnReq();
		await tick(deps);
		const [run0] = runs();
		worker(run0, "finish", { outcome: "needs_user", summary: "Which branch?", evidence: [] });
		worker(run0, "settled", { text: "Which branch?" });
		await tick(deps);
		const run = store.getRun(run0.id)!;
		expect(run.status).toBe("awaiting_user");
		expect(store.readInbox(0).items.some((i) => i.kind === "run_needs_user")).toBe(true);
	});

	it("restart after the Hoja issue was created reuses it by marker and never creates a second", async () => {
		// Simulate: the daemon persisted intent, created the issue, then died before saving the issue reference.
		const run: Run = { id: "run-crash1", label: "Crash", task: "t", cwd: dir, status: "launching", phase: "intent", createdAt: clock.toISOString(), updatedAt: clock.toISOString(), project: "CRM Clover File", requestedAssignee: "me", eventsOffset: 0, settles: 0, attempts: 0, outbox: [], seen: [] };
		store.saveRun(run);
		await fh.hoja.createIssue({} as any, "[claw] Crash", `x ${runMarker(run.id)}`, "In Progress");
		await tick(deps);
		await tick(deps);
		expect(fh.calls.create).toBe(1);
		const after = store.getRun(run.id)!;
		expect(after.phase).toBe("tab_open");
		expect(tern.opened()).toBe(1);
	});

	it("a crash during tab opening is ambiguous: reported as failed and never retried (no duplicate tab)", async () => {
		const issue = await fh.hoja.createIssue({} as any, "[claw] Tab", "x", "In Progress");
		const run: Run = { id: "run-tabcrash", label: "Tab", task: "t", cwd: dir, status: "launching", phase: "tab_opening", createdAt: clock.toISOString(), updatedAt: clock.toISOString(), project: "CRM Clover File", hoja: { issueId: issue.id, identifier: issue.identifier, teamKey: "TREBOL", project: "CRM Clover File", assignee: "Luis" }, eventsOffset: 0, settles: 0, attempts: 0, outbox: [], seen: [] };
		store.saveRun(run);
		await tick(deps);
		await tick(deps);
		const after = store.getRun(run.id)!;
		expect(after.status).toBe("failed");
		expect(after.error).toContain("not retried automatically");
		expect(tern.opened()).toBe(0);
	});

	it("a tab whose response is lost after creation is located by its run id and recorded; no second tab", async () => {
		const created: { block: number; args: string[] }[] = [];
		deps = { ...deps, tern: async (args: string[]) => {
			if (args[0] === "inspect") {
				return JSON.stringify({ sessions: [{ id: 1, tabs: [{ id: 1, name: "Claw", blocks: [{ id: 1, exited: null, live: true }, ...created.map((c) => ({ id: c.block, exited: null, live: true, args: c.args }))] }] }] });
			}
			if (args[0] === "new") {
				created.push({ block: 777, args });
				throw new Error("harness: response lost after tab creation");
			}
			return "{}";
		} };
		spawnReq();
		await tick(deps);
		await tick(deps);
		const [run] = runs();
		expect(run.status).toBe("failed");
		expect(run.block).toBe(777);
		expect(run.error).toContain("(block 777) carries this run id");
		expect(created).toHaveLength(1);
	});

	it("findRunBlock locates a block by the run id in Tern's shell-escaped command, and not a different run", async () => {
		const escaped = "/bin/zsh -lic 'exec env PI_TERN_UI=0 PI_CLAW_RUN='\\''run-acc-x1'\\'' pi'";
		const tern = async () => JSON.stringify({ sessions: [{ id: 1, tabs: [{ id: 5, name: null, blocks: [{ id: 50, command: escaped, args: ["-l", "-c", escaped] }] }] }] });
		expect(await findRunBlock(tern, "run-acc-x1")).toEqual({ tab: 5, block: 50 });
		expect(await findRunBlock(tern, "run-acc-x")).toBeUndefined();
		expect(await findRunBlock(tern, "run-acc-x12")).toBeUndefined();
	});

	it("a tern failure at tab open records failed, locates no block for the run id, and never retries", async () => {
		tern.state.failNew = true;
		spawnReq();
		await tick(deps);
		const [run] = runs();
		expect(run.status).toBe("failed");
		expect(run.error).toContain("tab open failed (not retried)");
		expect(run.error).toContain("No Tern block carries this run id");
		tern.state.failNew = false;
		await tick(deps);
		expect(tern.opened()).toBe(1);
		expect(runs()).toHaveLength(1);
	});

	it("Hoja read-back mismatch blocks the tab (no worker opens for an unverified issue)", async () => {
		const original = fh.hoja.readIssue;
		fh.hoja.readIssue = async (id: string) => ({ ...(await original(id)), projectId: "some-other-project" });
		spawnReq();
		await tick(deps);
		expect(tern.opened()).toBe(0);
		const [run] = runs();
		expect(run.error).toContain("project");
	});

	it("unknown project is refused before any run exists", async () => {
		request({ id: "req-bad", kind: "spawn", input: { task: "x", project: "Nope" } } as any);
		await tick(deps);
		expect(response("req-bad")?.ok).toBe(false);
		expect(response("req-bad")?.error).toContain('"Nope" not found');
		expect(runs()).toHaveLength(0);
		expect(fh.calls.create).toBe(0);
	});

	it("a spawn trigger with an unknown project is refused at add time and never saved", async () => {
		spawnReq();
		await tick(deps);
		const [run0] = runs();
		request({ id: "req-trg-bad", kind: "trigger_add", when: { kind: "on_exit", runId: run0.id }, action: { kind: "spawn", task: "follow-up", project: "Nope" }, once: true } as any);
		await tick(deps);
		expect(response("req-trg-bad")?.ok).toBe(false);
		expect(response("req-trg-bad")?.error).toContain('"Nope" not found');
		expect(store.listTriggers()).toHaveLength(0);
		expect(runs()).toHaveLength(1);
	});

	it("a worker whose process vanished without finish is lost, not completed", async () => {
		spawnReq();
		await tick(deps);
		const [run0] = runs();
		worker(run0, "started", { pid: 7777 });
		pids.add(7777);
		await tick(deps);
		expect(store.getRun(run0.id)!.status).toBe("running");
		pids.delete(7777);
		await tick(deps);
		const run = store.getRun(run0.id)!;
		expect(run.status).toBe("lost");
		expect(run.error).toContain("without claw_finish");
		expect(store.readInbox(0).items.some((i) => i.kind === "run_lost")).toBe(true);
	});

	it("a worker that never reached session_start is failed with the reason it wrote, not reported lost", async () => {
		spawnReq();
		await tick(deps);
		const [run0] = runs();
		writeFileSync(store.workerLogPath(run0.id), 'Failed to load extension "/main/extensions/ask-user/index.ts": Tool "ask_user_question" conflicts with "/wt/extensions/ask-user/index.ts"\n');
		await tern.exec(["close", String(run0.block)]);
		clock = new Date(clock.getTime() + 5 * 60_000);
		await tick(deps);
		const run = store.getRun(run0.id)!;
		expect(run.status).toBe("failed");
		expect(run.error).toContain("before session_start");
		expect(run.error).toContain('Tool "ask_user_question" conflicts with');
		const inbox = store.readInbox(0).items;
		expect(inbox.some((i) => i.kind === "run_failed")).toBe(true);
		expect(inbox.some((i) => i.kind === "run_lost")).toBe(false);
	});

	it("a worker that never started and wrote nothing still fails with a bounded reason", async () => {
		spawnReq();
		await tick(deps);
		const [run0] = runs();
		await tern.exec(["close", String(run0.block)]);
		clock = new Date(clock.getTime() + 5 * 60_000);
		await tick(deps);
		const run = store.getRun(run0.id)!;
		expect(run.status).toBe("failed");
		expect(run.error).toContain("wrote no reason");
		expect(run.error).toContain("worker.log");
	});

	it("records how the worker's extensions were resolved", async () => {
		deps = { ...deps, planLaunch: () => ({ mode: "explicit", extensions: ["/wt/extensions/tool.js"], builtins: ["codemode"], kept: ["/wt"], dropped: ["/main"] }) };
		spawnReq();
		await tick(deps);
		const run = store.getRun(runs()[0].id)!;
		expect(run.launchNote).toContain("loaded /wt once");
		expect(run.launchNote).toContain("skipped /main");
		const launched = tern.calls.find((args) => args[0] === "new");
		expect(launched?.join(" ")).toContain("'--no-extensions' '--extension' '/wt/extensions/tool.js'");
	});

	it("a finish written just before the process exited is honored, not reported lost", async () => {
		spawnReq();
		await tick(deps);
		const [run0] = runs();
		worker(run0, "started", { pid: 7777 });
		pids.add(7777);
		await tick(deps);
		worker(run0, "finish", { outcome: "completed", summary: "ok", evidence: ["ran it"] });
		pids.delete(7777);
		await tick(deps);
		expect(store.getRun(run0.id)!.status).toBe("completed");
	});

	it("Tern unavailable never marks block-only runs lost", async () => {
		spawnReq();
		await tick(deps);
		const [run0] = runs();
		clock = new Date(clock.getTime() + 5 * 60_000);
		const broken = { ...deps, tern: async (args: string[]) => { if (args[0] === "inspect") throw new Error("tern down"); return tern.exec(args); } };
		await tick(broken);
		expect(store.getRun(run0.id)!.status).toBe("launching");
	});

	it("cancel terminates the worker and closes the tab; the run is cancelled, never completed; Hoja Canceled only once verified gone", async () => {
		spawnReq();
		await tick(deps);
		const [run0] = runs();
		worker(run0, "started", { pid: 4242 });
		await tick(deps);
		request({ id: "req-cancel", kind: "cancel", runId: run0.id } as any);
		await tick(deps);
		const run = store.getRun(run0.id)!;
		expect(run.status).toBe("cancelled");
		expect(signals).toEqual([4242]);
		expect(tern.live.has(run.block!)).toBe(false);
		// Policy change: a verified cancel of a Claw-owned issue maps to Hoja "Canceled" (never "Done").
		expect(fh.calls.states).toEqual(["Canceled"]);
		expect(fh.issues.get(run.hoja!.issueId)!.state).toBe("Canceled");
	});

	it("a cancel whose worker is still alive is not verified: Hoja state is left unchanged", async () => {
		spawnReq();
		await tick(deps);
		const [run0] = runs();
		worker(run0, "started", { pid: 4242 });
		await tick(deps);
		deps = { ...deps, alive: () => true, cancelVerifyMs: 0 };
		request({ id: "req-cancel-u", kind: "cancel", runId: run0.id } as any);
		await tick(deps);
		const run = store.getRun(run0.id)!;
		expect(run.status).toBe("cancelled");
		expect(fh.calls.states).toEqual([]);
		expect(fh.issues.get(run.hoja!.issueId)!.state).toBe("In Progress");
		expect(fh.issues.get(run.hoja!.issueId)!.comments.at(-1)).toContain("not confirmed gone");
	});

	it("control off suspends new runs and triggers, but running workers are still reconciled", async () => {
		spawnReq("req-on");
		await tick(deps);
		const [run0] = runs();
		store.writeControl(false);
		spawnReq("req-off", "second task");
		await tick(deps);
		expect(response("req-off")?.ok).toBe(false);
		expect(response("req-off")?.error).toContain("claw is off");
		store.saveTrigger({ id: "trg-off", when: { kind: "at", at: clock.toISOString() }, action: { kind: "spawn", task: "scheduled", project: "CRM Clover File" }, enabled: true, once: true, createdAt: clock.toISOString(), nextFireAt: clock.toISOString(), fired: 0 } as Trigger);
		await tick(deps);
		expect(runs()).toHaveLength(1);
		worker(run0, "finish", { outcome: "completed", summary: "done", evidence: ["ok"] });
		await tick(deps);
		expect(store.getRun(run0.id)!.status).toBe("completed");
	});

	it("a cron trigger fires once per due time, even if the daemon restarts before advancing it", async () => {
		request({ id: "req-trg", kind: "trigger_add", when: { kind: "cron", cron: "* * * * *" }, action: { kind: "spawn", task: "Nightly check", project: "CRM Clover File" }, once: false } as any);
		await tick(deps);
		const trigger = store.listTriggers()[0];
		expect(trigger.nextFireAt).toBeDefined();
		clock = new Date(Date.parse(trigger.nextFireAt!) + 1000);
		const stale = JSON.parse(JSON.stringify(trigger));
		await tick(deps);
		expect(runs()).toHaveLength(1);
		// Crash simulation: the trigger file rolls back to its pre-fire state, as if the daemon died before saving.
		store.saveTrigger(stale);
		await tick(deps);
		expect(runs()).toHaveLength(1);
		expect(fh.calls.create).toBe(1);
		expect(store.listTriggers()[0].fired).toBe(1);
	});

	it("an at-trigger fires once and disables itself", async () => {
		store.saveTrigger({ id: "trg-at", when: { kind: "at", at: clock.toISOString() }, action: { kind: "spawn", task: "once", project: "CRM Clover File" }, enabled: true, once: true, createdAt: clock.toISOString(), nextFireAt: clock.toISOString(), fired: 0 } as Trigger);
		await tick(deps);
		await tick(deps);
		const t = store.getTrigger("trg-at")!;
		expect(t.fired).toBe(1);
		expect(t.enabled).toBe(false);
		expect(runs()).toHaveLength(1);
	});

	it("an on_exit trigger fires once when its run completes", async () => {
		spawnReq();
		await tick(deps);
		const [run0] = runs();
		request({ id: "req-onexit", kind: "trigger_add", when: { kind: "on_exit", runId: run0.id }, action: { kind: "spawn", task: "follow-up", project: "CRM Clover File" }, once: true } as any);
		await tick(deps);
		expect(runs()).toHaveLength(1);
		worker(run0, "finish", { outcome: "completed", summary: "done", evidence: ["x"] });
		await tick(deps);
		await tick(deps);
		await tick(deps);
		expect(runs()).toHaveLength(2);
		expect(runs()[1].trigger).toBeDefined();
	});

	it("outbox replay does not duplicate a Hoja comment that already landed", async () => {
		spawnReq();
		await tick(deps);
		const [run0] = runs();
		worker(run0, "finish", { outcome: "failed", summary: "could not reproduce", evidence: [] });
		// Comment lands on Hoja, but the daemon dies before marking the op done.
		const op = (await Promise.resolve()) && undefined;
		void op;
		const issue = fh.issues.get(run0.hoja?.issueId ?? store.getRun(run0.id)!.hoja!.issueId)!;
		await tick(deps);
		const run = store.getRun(run0.id)!;
		const body = run.outbox.find((o) => o.kind === "comment" && o.done)!.body;
		expect(issue.comments.filter((c) => c === body)).toHaveLength(1);
		const rolled = { ...run, outbox: run.outbox.map((o) => ({ ...o, done: false })) };
		store.saveRun(rolled as Run);
		await tick(deps);
		expect(issue.comments.filter((c) => c === body)).toHaveLength(1);
	});

	it("a second daemon cannot claim a live lock; a dead owner's lock is reclaimed", () => {
		writeFileSync(store.lockPath, JSON.stringify({ pid: 999991, heartbeat: 0 }));
		expect(claimLock(store, (p) => p === 999991)).toBe(false);
		expect(claimLock(store, () => false)).toBe(true);
		expect(JSON.parse(readFileSync(store.lockPath, "utf8")).pid).toBe(process.pid);
	});

	it("the daemon loop exits when there is nothing left to do and releases its lock", async () => {
		await runDaemon({ ...deps, now: () => new Date() }, { tickMs: 1, idleExitMs: 0 });
		expect(() => readFileSync(store.lockPath, "utf8")).toThrow();
	});
});

describe("claw worker side", () => {
	it("completion requires evidence and a summary; outcomes are closed", () => {
		expect(() => validateFinish({ outcome: "completed", summary: "x", evidence: [] })).toThrow("completed requires evidence");
		expect(() => validateFinish({ outcome: "done", summary: "x", evidence: ["a"] })).toThrow("outcome must be");
		expect(() => validateFinish({ outcome: "failed", summary: "  ", evidence: [] })).toThrow("summary is required");
		expect(validateFinish({ outcome: "failed", summary: "no", evidence: [] }).outcome).toBe("failed");
	});

	it("depth one: agent-spawning tools are blocked for workers", () => {
		for (const name of ["Subagent", "Delegate", "BackgroundTask", "Agent", "claw_spawn"]) expect(WORKER_BLOCKED_TOOLS).toContain(name);
		expect(WORKER_BLOCKED_TOOLS).not.toContain("Read");
	});

	it("worker extension gates tool calls only for blocked names and refuses completion without evidence", async () => {
		const dir = mkdtempSync(join(tmpdir(), "claw-worker-"));
		try {
			const store = ClawStore.forWorkspace(dir);
			const run: Run = { id: "run-wk1", label: "w", task: "t", cwd: dir, status: "running", phase: "tab_open", createdAt: "", updatedAt: "", project: "p", eventsOffset: 0, settles: 0, attempts: 0, outbox: [], seen: [] };
			store.saveRun(run);
			const handlers: Record<string, (...a: any[]) => any> = {};
			const tools: Record<string, any> = {};
			const pi = { on: (name: string, h: any) => { handlers[name] = h; }, registerTool: (t: any) => { tools[t.name] = t; } };
			const prev = { run: process.env.PI_CLAW_RUN, dir: process.env.PI_CLAW_DIR };
			process.env.PI_CLAW_RUN = run.id; process.env.PI_CLAW_DIR = store.dir;
			try { clawExtension(pi); } finally { process.env.PI_CLAW_RUN = prev.run; process.env.PI_CLAW_DIR = prev.dir; }
			expect(handlers.tool_call({ toolName: "Subagent" })).toMatchObject({ block: true });
			expect(handlers.tool_call({ toolName: "Read" })).toBeUndefined();
			await expect(tools.claw_finish.execute("c1", { outcome: "completed", summary: "x", evidence: [] })).rejects.toThrow("completed requires evidence");
			await tools.claw_finish.execute("c2", { outcome: "completed", summary: "x", evidence: ["ls"] });
			expect(store.readEvents(run.id, 0).items.map((e) => e.type)).toEqual(["finish"]);
			expect(Object.keys(tools)).toEqual(["claw_finish"]);
		} finally { rmSync(dir, { recursive: true, force: true }); }
	});

	it("settled text comes from the last assistant message, not from a claim", () => {
		expect(lastAssistant([{ role: "user", content: "go" }, { role: "assistant", content: [{ type: "text", text: "done?" }], stopReason: "stop" }])).toEqual({ text: "done?", stopReason: "stop" });
		expect(lastAssistant(undefined)).toEqual({ text: "" });
	});
});

describe("claw Hoja client", () => {
	it("findIssueByMarker uses the server-side description filter, not a bounded page of recent issues", async () => {
		const queries: string[] = [];
		const marker = "<!-- claw-run:run-x1 -->";
		const client = new HojaClient({ url: "https://hoja.test/graphql", token: "t", fetch: async (_url, init) => {
			queries.push(JSON.parse(init.body).query);
			return { status: 200, text: async () => JSON.stringify({ data: { issues: { nodes: [{ id: "i9", identifier: "TREBOL-9", description: `x ${marker}` }, { id: "i8", identifier: "TREBOL-8", description: "no marker" }] } } }) };
		} });
		expect(await client.findIssueByMarker(marker)).toEqual({ id: "i9", identifier: "TREBOL-9" });
		expect(queries[0]).toContain('filter: { description: { contains: "<!-- claw-run:run-x1 -->" } }');
		expect(queries[0]).not.toContain("first: 250");
	});

	it("never puts the token in an error message", async () => {
		const token = "lin_api_SECRET_VALUE_123";
		const client = new HojaClient({ url: "https://hoja.test/graphql", token, fetch: async () => ({ status: 500, text: async () => `boom ${token}` }) });
		const err = await client.gql("{ viewer { id } }").catch((e: Error) => e);
		expect(String((err as Error).message)).not.toContain(token);
	});

	it("resolve refuses a project that belongs to no visible team and an ambiguous assignee", async () => {
		const catalog = {
			data: {
				viewer: { id: "u1", name: "Luis", email: "l@x" },
				projects: { nodes: [{ id: "p1", name: "CRM", teams: { nodes: [{ id: "t1", key: "TREBOL" }] } }] },
				teams: { nodes: [{ id: "t1", key: "TREBOL", states: { nodes: [{ id: "s1", name: "In Progress" }] }, members: { nodes: [{ id: "u1", name: "Luis", email: "l@x" }, { id: "u2", name: "Luisa", email: "x@x" }, { id: "u3", name: "Luis Two", email: "y@x" }] } }] },
			},
		};
		const client = new HojaClient({ url: "https://hoja.test/graphql", token: "t", fetch: async () => ({ status: 200, text: async () => JSON.stringify(catalog) }) });
		expect((await client.resolve("CRM")).assignee).toBe("Luis");
		await expect(client.resolve("CRM", "Luis")).resolves.toBeDefined();
		await expect(client.resolve("CRM", "Lui")).rejects.toThrow("ambiguous");
		await expect(client.resolve("Missing")).rejects.toThrow('not found');
	});
});

describe("claw helpers", () => {
	it("recordSettled appends the final assistant text as a settled event", () => {
		const dir = mkdtempSync(join(tmpdir(), "claw-settled-"));
		try {
			const store = ClawStore.forWorkspace(dir);
			recordSettled(store, "run-s1", [{ role: "assistant", content: "waiting on you", stopReason: "stop" }]);
			const [ev] = store.readEvents("run-s1", 0).items;
			expect(ev).toMatchObject({ type: "settled", text: "waiting on you", stopReason: "stop" });
			recordFinish(store, "run-s1", { outcome: "failed", summary: "no", evidence: [] });
			expect(store.readEvents("run-s1", 0).items.at(-1)).toMatchObject({ type: "finish", outcome: "failed" });
		} finally { rmSync(dir, { recursive: true, force: true }); }
	});
});
