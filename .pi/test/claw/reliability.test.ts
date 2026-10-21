import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tick, type DaemonDeps } from "../../lib/claw/daemon.ts";
import { HojaRequestError, type IssueView } from "../../lib/claw/hoja.ts";
import { runIdFor, runMarker, type ClawHoja } from "../../lib/claw/spawn.ts";
import { request, WITHDRAW_WAIT_MS } from "../../lib/claw/orchestrator.ts";
import { ClawStore, type Request, type Run } from "../../lib/claw/store.ts";

const TEAM = { teamId: "team-trebol", teamKey: "TREBOL", projectId: "proj-crm", project: "CRM Clover File", assigneeId: "user-luis", assignee: "Luis" };
const STATES = { "in progress": "s-ip", "in review": "s-ir", done: "s-done", canceled: "s-canceled" };

type Issue = IssueView & { description: string };

/** Hoja boundary double. `committed` is the server truth; the client may see an ambiguous or lost answer. */
function fakeHoja(options: { onCreate?: () => void } = {}) {
	const issues = new Map<string, Issue>();
	const calls = { create: 0, setState: 0, comment: 0, lookups: 0 };
	let n = 0;
	const commit = (title: string, description: string, state: string): string => {
		n++;
		const id = `iss-${n}`;
		issues.set(id, { id, identifier: `TREBOL-${900 + n}`, title, description, state, teamId: TEAM.teamId, projectId: TEAM.projectId, assigneeId: TEAM.assigneeId, comments: [] });
		return id;
	};
	const hoja = {
		calls,
		issues,
		/** Mode for the next create: committed+ok, committed but answer lost (ambiguous), not committed + lost, or rejected. */
		nextCreate: "ok" as "ok" | "ambiguous-committed" | "ambiguous-uncommitted" | "rejected",
		hoja: {
			async resolve(project: string) {
				if (project !== TEAM.project) throw new Error(`Hoja project "${project}" not found`);
				return { ...TEAM, states: STATES };
			},
			async createIssue(_r: unknown, title: string, description: string, state = "In Progress") {
				calls.create++;
				options.onCreate?.();
				const mode = (fake as any).nextCreate as string;
				if (mode === "rejected") throw new Error("Hoja issueCreate did not succeed");
				if (mode === "ambiguous-uncommitted") throw new HojaRequestError("Hoja request timed out; outcome unknown for writes.", true);
				const id = commit(title, description, state);
				if (mode === "ambiguous-committed") throw new HojaRequestError("Hoja request timed out; outcome unknown for writes.", true);
				return { id, identifier: issues.get(id)!.identifier };
			},
			async readIssue(id: string): Promise<IssueView> {
				const i = issues.get(id);
				if (!i) throw new HojaRequestError("Hoja issue not found on read-back");
				return { ...i, comments: [...i.comments] };
			},
			async findIssueByMarker(marker: string) {
				calls.lookups++;
				const hit = [...issues.values()].find((i) => i.description.includes(marker));
				return hit ? { id: hit.id, identifier: hit.identifier } : undefined;
			},
			async comment(id: string, body: string) { calls.comment++; issues.get(id)!.comments.push(body); },
			async setState(_r: unknown, id: string, state: string) { calls.setState++; issues.get(id)!.state = state; },
		} as unknown as ClawHoja,
	};
	const fake = hoja;
	return fake;
}

function fakeTern() {
	const live = new Set<number>([1]);
	const launched: { block: number; args: string[] }[] = [];
	const exec = async (args: string[]) => {
		if (args[0] === "inspect") return JSON.stringify({ sessions: [{ id: 1, tabs: [{ id: 1, name: "Claw", blocks: [...live].map((id) => ({ id, exited: null, live: true })) }] }] });
		if (args[0] === "new") {
			const block = 200 + launched.length;
			launched.push({ block, args });
			live.add(block);
			return JSON.stringify({ tab: block + 1000, block });
		}
		return "{}";
	};
	return { exec, live, launched, opened: () => launched.length };
}

describe("claw Hoja create: ambiguous outcomes never send a second create", () => {
	let dir: string;
	let store: ClawStore;
	let fh: ReturnType<typeof fakeHoja>;
	let tern: ReturnType<typeof fakeTern>;
	let clock: Date;
	let deps: DaemonDeps;
	const advance = (ms: number) => { clock = new Date(clock.getTime() + ms); };

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "claw-create-"));
		store = ClawStore.forWorkspace(dir);
		clock = new Date("2026-10-21T10:00:00.000Z");
		fh = fakeHoja();
		tern = fakeTern();
		deps = { store, hoja: fh.hoja, tern: tern.exec, workspace: dir, now: () => clock, alive: () => false, signal: () => undefined };
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	const spawn = (id = "req-create-1", expiresInMs = 60 * 60_000) => store.writeRequest({ id, kind: "spawn", createdAt: clock.toISOString(), expiresAt: new Date(clock.getTime() + expiresInMs).toISOString(), input: { task: "Check the build", project: "CRM Clover File" } } as Request);
	const runOf = (id = "req-create-1") => store.getRun(runIdFor(id)) as Run;

	it("a create whose answer is lost but was committed is found by its marker; one issue, one tab", async () => {
		fh.nextCreate = "ambiguous-committed";
		spawn();
		await tick(deps);
		await tick(deps);
		expect(fh.calls.create).toBe(1);
		expect(fh.issues.size).toBe(1);
		expect(runOf().phase).toBe("tab_open");
		expect(tern.opened()).toBe(1);
	});

	it("a delayed commit (not visible at first lookup) never causes a second create; the late issue is adopted", async () => {
		fh.nextCreate = "ambiguous-uncommitted";
		spawn();
		await tick(deps);
		for (let i = 0; i < 4; i++) { advance(20_000); await tick(deps); }
		expect(fh.calls.create).toBe(1);
		expect(runOf().phase).toBe("create_dispatched");
		expect(runOf().status).toBe("launching");
		expect(tern.opened()).toBe(0);
		// The server commits late: the marker now exists. Only reconciliation sees it; no create is sent.
		fh.issues.set("late", { id: "late", identifier: "TREBOL-950", title: "[claw] late", description: `late ${runMarker(runIdFor("req-create-1"))}`, state: "In Progress", teamId: TEAM.teamId, projectId: TEAM.projectId, assigneeId: TEAM.assigneeId, comments: [] });
		advance(20_000);
		await tick(deps);
		await tick(deps);
		await tick(deps);
		expect(fh.calls.create).toBe(1);
		expect(runOf().phase).toBe("tab_open");
		expect(runOf().hoja?.identifier).toBe("TREBOL-950");
		expect(tern.opened()).toBe(1);
	});

	it("an unresolved create stays blocked and is never re-sent on absence; the run is reported, not failed", async () => {
		fh.nextCreate = "ambiguous-uncommitted";
		spawn();
		await tick(deps);
		for (let i = 0; i < 5; i++) { advance(20_000); await tick(deps); }
		const run = runOf();
		expect(fh.calls.create).toBe(1);
		expect(run.phase).toBe("create_dispatched");
		expect(run.error).toContain("Not re-created");
		expect(tern.opened()).toBe(0);
	});

	it("a definitive Hoja rejection fails the run without any retry of the create", async () => {
		fh.nextCreate = "rejected";
		spawn();
		await tick(deps);
		advance(20_000);
		await tick(deps);
		expect(fh.calls.create).toBe(1);
		expect(runOf().status).toBe("failed");
		expect(runOf().error).toContain("nothing was committed");
		expect(tern.opened()).toBe(0);
	});

	it("a failed marker lookup before dispatch sends no create at all, then the create happens once the lookup works", async () => {
		const original = fh.hoja.findIssueByMarker;
		fh.hoja.findIssueByMarker = async () => { throw new HojaRequestError("lookup down"); };
		spawn();
		await tick(deps);
		expect(fh.calls.create).toBe(0);
		expect(runOf().phase).toBe("intent");
		fh.hoja.findIssueByMarker = original;
		advance(20_000);
		await tick(deps);
		await tick(deps);
		await tick(deps);
		expect(fh.calls.create).toBe(1);
		expect(runOf().phase).toBe("tab_open");
		expect(tern.opened()).toBe(1);
	});

	it("a run persisted in create_dispatched with a visible marker adopts the issue; no create is sent", async () => {
		const run: Run = { id: runIdFor("req-adopt"), label: "Adopt", task: "t", cwd: dir, status: "launching", phase: "create_dispatched", createdAt: clock.toISOString(), updatedAt: clock.toISOString(), project: TEAM.project, requestedAssignee: "me", eventsOffset: 0, settles: 0, attempts: 0, outbox: [], seen: [], target: { ...TEAM, states: STATES } as any };
		store.saveRun(run);
		await fh.hoja.createIssue({}, "x", `x ${runMarker(run.id)}`, "In Progress");
		fh.calls.create = 0;
		await tick(deps);
		expect(fh.calls.create).toBe(0);
		await tick(deps);
		expect(runOf("req-adopt").phase).toBe("tab_open");
	});

	it("cancelling an unresolved create changes no Hoja state and says a late issue needs a manual check", async () => {
		fh.nextCreate = "ambiguous-uncommitted";
		spawn();
		await tick(deps);
		store.writeRequest({ id: "req-cancel-1", kind: "cancel", createdAt: clock.toISOString(), runId: runIdFor("req-create-1") } as Request);
		await tick(deps);
		const run = runOf();
		expect(run.status).toBe("cancelled");
		expect(run.error).toContain("manual check");
		expect(fh.calls.setState).toBe(0);
		expect(fh.calls.create).toBe(1);
	});
});

describe("claw spawn deadline and withdrawal", () => {
	let dir: string;
	let store: ClawStore;
	let fh: ReturnType<typeof fakeHoja>;
	let tern: ReturnType<typeof fakeTern>;
	let clock: Date;
	let deps: DaemonDeps;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "claw-deadline-"));
		store = ClawStore.forWorkspace(dir);
		clock = new Date("2026-10-21T10:00:00.000Z");
		fh = fakeHoja();
		tern = fakeTern();
		deps = { store, hoja: fh.hoja, tern: tern.exec, workspace: dir, now: () => clock, alive: () => false, signal: () => undefined };
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	const spawn = (id: string, expiresAt: Date) => store.writeRequest({ id, kind: "spawn", createdAt: clock.toISOString(), expiresAt: expiresAt.toISOString(), input: { task: "Check", project: "CRM Clover File" } } as Request);

	it("a request past its deadline before dispatch never starts: refused, no run, no Hoja issue, no tab", async () => {
		spawn("req-late", new Date(clock.getTime() - 1000));
		await tick(deps);
		expect(store.readResponse("req-late")).toMatchObject({ ok: false, code: "not_started" });
		expect(store.listRuns()).toHaveLength(0);
		expect(fh.calls.create).toBe(0);
		expect(tern.opened()).toBe(0);
	});

	it("a withdrawal that arrives before dispatch refuses the request for good", async () => {
		spawn("req-zz-spawn", new Date(clock.getTime() + 60_000));
		store.writeRequest({ id: "req-aa-withdraw", kind: "withdraw", createdAt: clock.toISOString(), requestId: "req-zz-spawn" } as Request);
		await tick(deps);
		expect(store.readResponse("req-aa-withdraw")).toMatchObject({ ok: true, result: { withdrawn: true, state: "not_started" } });
		expect(store.readResponse("req-zz-spawn")).toMatchObject({ ok: false, code: "not_started" });
		await tick(deps);
		expect(store.listRuns()).toHaveLength(0);
		expect(tern.opened()).toBe(0);
	});

	it("a withdrawal after dispatch reports the accepted run and never cancels or re-launches it", async () => {
		spawn("req-acc", new Date(clock.getTime() + 60_000));
		await tick(deps);
		expect(store.readResponse("req-acc")?.ok).toBe(true);
		store.writeRequest({ id: "req-wd-acc", kind: "withdraw", createdAt: clock.toISOString(), requestId: "req-acc" } as Request);
		await tick(deps);
		expect(store.readResponse("req-wd-acc")).toMatchObject({ ok: true, result: { withdrawn: false, state: "accepted", result: { id: runIdFor("req-acc") } } });
		expect(tern.opened()).toBe(1);
	});

	it("the deadline is re-checked before the tab: a create that outlives the deadline launches no worker", async () => {
		const original = fh.hoja.createIssue;
		fh.hoja.createIssue = async (...args: any[]) => {
			const ref = await (original as any)(...args);
			clock = new Date(clock.getTime() + 120_000);
			return ref;
		};
		spawn("req-slow", new Date(clock.getTime() + 60_000));
		await tick(deps);
		const run = store.getRun(runIdFor("req-slow"))!;
		expect(tern.opened()).toBe(0);
		expect(run.status).toBe("failed");
		expect(run.error).toContain("deadline passed before the worker tab; not launched");
		expect(fh.issues.size).toBe(1);
		await tick(deps);
		expect(tern.opened()).toBe(0);
	});

	it("the run id is derived from the request id, so the caller's handle exists before the daemon acts", () => {
		expect(runIdFor("req-x")).toBe(runIdFor("req-x"));
		expect(runIdFor("req-x")).not.toBe(runIdFor("req-y"));
	});
});

describe("claw client: timeouts become structured outcomes, not generic errors", () => {
	let dir: string;
	let store: ClawStore;
	beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "claw-client-")); store = ClawStore.forWorkspace(dir); });
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("with no daemon, a timed-out spawn is pending with its run id, and a later daemon pass refuses it", async () => {
		const outcome = await request(store, dir, { kind: "spawn", input: { task: "Check", project: "CRM Clover File" } } as any, { timeoutMs: 300, withdrawWaitMs: 200, ensure: () => undefined });
		expect(outcome.state).toBe("pending");
		if (outcome.state !== "pending") return;
		expect(outcome.runId).toBe(runIdFor(outcome.requestId));
		const tern = fakeTern();
		const fh = fakeHoja();
		const later = new Date(Date.now() + 10_000);
		await tick({ store, hoja: fh.hoja, tern: tern.exec, workspace: dir, now: () => later, alive: () => false, signal: () => undefined });
		expect(store.listRuns()).toHaveLength(0);
		expect(fh.calls.create).toBe(0);
		expect(tern.opened()).toBe(0);
	});

	it("a dispatched spawn whose caller gives up resolves to done with the real result when the daemon answers", async () => {
		const tern = fakeTern();
		const fh = fakeHoja();
		const deps: DaemonDeps = { store, hoja: fh.hoja, tern: tern.exec, workspace: dir, now: () => new Date(), alive: () => false, signal: () => undefined };
		const outcome = request(store, dir, { kind: "spawn", input: { task: "Check", project: "CRM Clover File" } } as any, { timeoutMs: 60_000, withdrawWaitMs: 2000, ensure: () => undefined });
		await tick(deps);
		const result = await outcome;
		expect(result.state).toBe("done");
	});

	it("the default withdrawal wait is bounded", () => {
		expect(WITHDRAW_WAIT_MS).toBeLessThanOrEqual(5000);
	});
});

export type { Request };
