import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyEvent, handleRequest, reconcileRun, tick, type DaemonDeps } from "../../lib/claw/daemon.ts";
import { runListing } from "../../lib/claw/orchestrator.ts";
import { runIdFor, type ClawHoja } from "../../lib/claw/spawn.ts";
import { ClawStore, type ClawEvent, type Request, type Run } from "../../lib/claw/store.ts";

const START = "2026-10-21T10:00:00.000Z";

/** Tern double. Closing a block Tern no longer has answers the way the real CLI does: an error naming "no block". */
function fakeTern() {
	const live = new Set<number>([1]);
	const calls: string[][] = [];
	const exec = async (args: string[]) => {
		calls.push(args);
		if (args[0] === "inspect") return JSON.stringify({ sessions: [{ id: 1, tabs: [{ id: 1, name: "Claw", blocks: [...live].map((id) => ({ id, exited: null, live: true })) }] }] });
		if (args[0] === "new") {
			const block = 200 + calls.filter((c) => c[0] === "new").length - 1;
			live.add(block);
			return JSON.stringify({ tab: block + 1000, block });
		}
		if (args[0] === "close") {
			const block = Number(args[1]);
			if (!live.has(block)) throw new Error(`Command failed: tern close ${block} --json\nno block is called ${block} in this window`);
			live.delete(block);
		}
		return "{}";
	};
	return { exec, live, calls, closes: (block: number) => calls.filter((c) => c[0] === "close" && c[1] === String(block)).length };
}

/** Hoja double that accepts a create and reads it back with the same team, project, assignee and state. */
function fakeHoja(): ClawHoja {
	const issues = new Map<string, any>();
	let n = 0;
	return {
		async resolve(project: string) {
			if (project !== "CRM Clover File") throw new Error(`Hoja project "${project}" not found`);
			return { teamId: "t", teamKey: "TREBOL", projectId: "p", project, assigneeId: "u", assignee: "Luis", states: { "in progress": "s-ip" } } as any;
		},
		async createIssue(_r: any, _title: string, description: string) {
			n++;
			const identifier = `TREBOL-${900 + n}`;
			issues.set(`iss-${n}`, { id: `iss-${n}`, identifier, description, state: "In Progress", teamId: "t", projectId: "p", assigneeId: "u", comments: [] });
			return { id: `iss-${n}`, identifier };
		},
		async readIssue(id: string) { const i = issues.get(id); if (!i) throw new Error("missing"); return { ...i, comments: [...i.comments] }; },
		async findIssueByMarker(marker: string) { const hit = [...issues.values()].find((i) => i.description.includes(marker)); return hit ? { id: hit.id, identifier: hit.identifier } : undefined; },
		async comment(id: string, body: string) { issues.get(id).comments.push(body); },
		async setState(_r: any, id: string, state: string) { issues.get(id).state = state; },
	} as ClawHoja;
}

describe("claw daemon noise, stuck runs and tabs", () => {
	let dir: string;
	let store: ClawStore;
	let tern: ReturnType<typeof fakeTern>;
	let clock: Date;
	let deps: DaemonDeps;
	const advance = (ms: number) => { clock = new Date(clock.getTime() + ms); };
	const seq = { n: 0 };

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "claw-noise-"));
		store = ClawStore.forWorkspace(dir);
		clock = new Date(START);
		tern = fakeTern();
		deps = { store, hoja: fakeHoja(), tern: tern.exec, workspace: dir, now: () => clock, alive: () => false, signal: () => undefined };
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	/** A persisted run in a given state. The daemon owns runs/, so tests write them the way the daemon would. */
	const makeRun = (over: Partial<Run>): Run => {
		seq.n++;
		const at = clock.toISOString();
		const run = { id: `run-test-${seq.n}`, label: "Label", task: "t", cwd: dir, status: "running", phase: "tab_open", createdAt: at, updatedAt: at, project: "CRM Clover File", eventsOffset: 0, settles: 0, attempts: 0, outbox: [], seen: [], ...over } as Run;
		store.saveRun(run);
		return run;
	};
	const settled = (runId: string, eid: string): ClawEvent => ({ eid, type: "settled", at: clock.toISOString(), runId, text: "" });
	const started = (runId: string, eid: string): ClawEvent => ({ eid, type: "started", at: clock.toISOString(), runId, pid: 77 });
	const idleNotices = () => store.readInbox(0).items.filter((i) => i.kind === "run_idle");
	const sendReq = (runId: string, text = "continue"): Request => ({ id: `req-send-${seq.n++}`, kind: "send", createdAt: clock.toISOString(), runId, text } as Request);

	describe("1. settled notice fires once per idle transition", () => {
		it("a running worker that settles twice with no restart in between gets one notice", () => {
			const run = makeRun({ status: "running" });
			applyEvent(run, settled(run.id, "e1"), store);
			applyEvent(run, settled(run.id, "e2"), store);
			expect(run.status).toBe("idle");
			expect(idleNotices()).toHaveLength(1);
		});

		it("a settle on an awaiting_user run adds no notice and keeps the status", () => {
			const run = makeRun({ status: "awaiting_user" });
			applyEvent(run, settled(run.id, "e1"), store);
			applyEvent(run, settled(run.id, "e2"), store);
			expect(run.status).toBe("awaiting_user");
			expect(idleNotices()).toHaveLength(0);
		});

		it("a settle on a cancelled run adds no notice", () => {
			const run = makeRun({ status: "cancelled" });
			applyEvent(run, settled(run.id, "e1"), store);
			expect(run.status).toBe("cancelled");
			expect(idleNotices()).toHaveLength(0);
		});

		it("near miss: a new idle transition after the worker restarts gets its own notice", () => {
			const run = makeRun({ status: "running" });
			applyEvent(run, settled(run.id, "e1"), store);
			applyEvent(run, started(run.id, "e2"), store);
			applyEvent(run, settled(run.id, "e3"), store);
			expect(idleNotices()).toHaveLength(2);
			expect(new Set(idleNotices().map((i) => i.id)).size).toBe(2);
		});
	});

	describe("2. send re-activates awaiting_user runs or names the next step", () => {
		it("an awaiting_user run with a live tab is re-activated and receives the input", async () => {
			tern.live.add(300);
			const run = makeRun({ status: "awaiting_user", block: 300 });
			const res = await handleRequest(sendReq(run.id), deps) as { reactivated: boolean };
			expect(res.reactivated).toBe(true);
			expect(store.getRun(run.id)!.status).toBe("running");
			expect(tern.calls).toContainEqual(["send", "300", "text", "continue"]);
		});

		it("an awaiting_user run whose tab is gone refuses with the relaunch step", async () => {
			const run = makeRun({ status: "awaiting_user", block: 999 });
			await expect(handleRequest(sendReq(run.id), deps)).rejects.toThrow(/relaunch with claw_spawn using the summary/);
		});

		it("near miss: a running run still accepts input without re-activation", async () => {
			tern.live.add(301);
			const run = makeRun({ status: "running", block: 301 });
			const res = await handleRequest(sendReq(run.id), deps) as { reactivated: boolean };
			expect(res.reactivated).toBe(false);
		});

		it("a completed run refuses with a clear next step", async () => {
			const run = makeRun({ status: "completed", block: 302 });
			await expect(handleRequest(sendReq(run.id), deps)).rejects.toThrow(/completed; it cannot take input. Start a new run with claw_spawn/);
		});
	});

	describe("3. launching runs time out and show their age", () => {
		it("a run still launching after the timeout is failed with a reason", async () => {
			const run = makeRun({ status: "launching", phase: "tab_open", createdAt: new Date(Date.parse(START) - 6 * 60_000).toISOString() });
			await reconcileRun(run, deps, new Set());
			const after = store.getRun(run.id)!;
			expect(after.status).toBe("failed");
			expect(after.error).toMatch(/launch timed out after 300s in phase tab_open with no worker started event/);
			expect(store.readInbox(0).items.some((i) => i.kind === "run_failed" && i.runId === run.id)).toBe(true);
		});

		it("a create whose outcome is unknown says a late issue may exist when it times out", async () => {
			const run = makeRun({ status: "launching", phase: "create_dispatched", createdAt: new Date(Date.parse(START) - 6 * 60_000).toISOString() });
			await reconcileRun(run, deps, new Set());
			expect(store.getRun(run.id)!.error).toMatch(/late issue carrying the run marker may exist/);
		});

		it("near miss: a launching run inside the timeout stays launching", async () => {
			const run = makeRun({ status: "launching", phase: "tab_open", createdAt: new Date(Date.parse(START) - 4 * 60_000).toISOString() });
			await reconcileRun(run, deps, new Set());
			expect(store.getRun(run.id)!.status).toBe("launching");
		});

		it("claw list rows carry the age, and a launching row shows seconds left before timeout", () => {
			const launching = makeRun({ status: "launching", createdAt: new Date(Date.parse(START) - 90_000).toISOString() });
			const running = makeRun({ status: "running", createdAt: new Date(Date.parse(START) - 90_000).toISOString() });
			const rows = runListing([launching, running], clock.getTime());
			expect(rows[0]).toMatchObject({ status: "launching", ageSeconds: 90, launchTimeoutInSeconds: 210 });
			expect(rows[1]).toMatchObject({ status: "running", ageSeconds: 90 });
			expect(rows[1].launchTimeoutInSeconds).toBeUndefined();
		});
	});

	describe("4. cancel treats an already-closed tab as closed", () => {
		it("a cancel whose tab is already gone records cancelled with no tab error", async () => {
			const run = makeRun({ status: "running", block: 999 });
			await handleRequest({ id: "req-c", kind: "cancel", createdAt: clock.toISOString(), runId: run.id } as Request, deps);
			const after = store.getRun(run.id)!;
			expect(after.status).toBe("cancelled");
			expect(after.error).toBeUndefined();
		});
	});

	describe("5. daemon closes its own tabs when a run ends", () => {
		it("a completed run's tab is closed once; a later tick does not close it again", async () => {
			tern.live.add(300);
			const run = makeRun({ status: "completed", block: 300 });
			await reconcileRun(run, deps, new Set(tern.live));
			expect(tern.closes(300)).toBe(1);
			expect(store.getRun(run.id)!.tabClosedAt).toBeDefined();
			await reconcileRun(store.getRun(run.id)!, deps, new Set(tern.live));
			expect(tern.closes(300)).toBe(1);
		});

		it("a failed run whose tab is already gone is closed without error", async () => {
			const run = makeRun({ status: "failed", block: 998 });
			await reconcileRun(run, deps, new Set(tern.live));
			const after = store.getRun(run.id)!;
			expect(after.tabClosedAt).toBeDefined();
			expect(after.tabCloseError).toBeUndefined();
		});

		it("near miss: awaiting_user, running and idle runs keep their tabs", async () => {
			tern.live.add(310);
			tern.live.add(311);
			tern.live.add(312);
			for (const [status, block] of [["awaiting_user", 310], ["running", 311], ["idle", 312]] as const) {
				const run = makeRun({ status, block });
				await reconcileRun(run, deps, new Set(tern.live));
			}
			expect(tern.calls.filter((c) => c[0] === "close")).toHaveLength(0);
		});

		it("near miss: a terminal run that never got a tab is not closed", async () => {
			const run = makeRun({ status: "completed" });
			await reconcileRun(run, deps, new Set(tern.live));
			expect(tern.calls.filter((c) => c[0] === "close")).toHaveLength(0);
		});
	});

	describe("6. new worker tabs carry the Hoja identifier and are renamed with tern rename", () => {
		it("the launch renames the tab to '<identifier> <label>' through tern rename <block>", async () => {
			const requestId = "req-tab-1";
			store.writeRequest({ id: requestId, kind: "spawn", createdAt: clock.toISOString(), expiresAt: new Date(clock.getTime() + 3600_000).toISOString(), input: { task: "Check the build", project: "CRM Clover File", label: "Fix login" } } as Request);
			await tick(deps);
			await tick(deps);
			expect(store.getRun(runIdFor(requestId))!.phase).toBe("tab_open");
			expect(tern.calls).toContainEqual(["rename", "200", "TREBOL-901 Fix login", "--json"]);
		});
	});
});
