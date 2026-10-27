/** Regression: two Claw orchestrator sessions on ONE workspace must not merge.
 *  Field report (2026-10-27): two claws on one machine, all agent sessions ended up in one. Cause: the store kept one
 *  inbox owner (orchestrator.json) and one Tern pane (control.json) per workspace, and `/claw on` plus every claw_* call
 *  overwrote both, so the last session to act received every run and every new worker tab opened in its Tern session.
 *  Sandbox only: temp workspace, fake Hoja and Tern, a fake `ensure`; the daemon runs as in-process `tick` calls. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerOrchestrator, stampOrigin } from "../../../extensions/claw/extension.ts";
import { applyEvent, tick, type DaemonDeps } from "../../lib/claw/daemon.ts";
import { deliveredInboxIds, INBOX_TYPE, pumpInbox, type InboxMessage } from "../../lib/claw/inbox.ts";
import type { TernExec } from "../../lib/claw/launcher.ts";
import { setClawAgentRoute, setClawMode } from "../../lib/claw/mode.ts";
import type { ClawHoja } from "../../lib/claw/spawn.ts";
import { flushDigest, DEFAULT_SLO } from "../../lib/claw/supervisor.ts";
import { ClawStore, type Request, type Run } from "../../lib/claw/store.ts";

/** Two Tern sessions: orchestrator A lives in block 100 (Tern session 1), orchestrator B in block 200 (Tern session 2). */
function twoWindowTern() {
	const opened: { session: number }[] = [];
	let next = 300;
	const exec: TernExec = async (args) => {
		if (args[0] === "inspect") return JSON.stringify({ sessions: [
			{ id: 1, tabs: [{ id: 10, name: "Claw", blocks: [{ id: 100, exited: null, live: true }] }] },
			{ id: 2, tabs: [{ id: 20, name: "Claw", blocks: [{ id: 200, exited: null, live: true }] }] },
		] });
		if (args[0] === "new") { opened.push({ session: Number(args[2]) }); next += 2; return JSON.stringify({ tab: next, block: next + 1 }); }
		return "{}";
	};
	return { exec, opened };
}

function fakeHoja(): ClawHoja {
	let n = 0;
	const issues = new Map<string, { id: string; identifier: string; description: string; state: string; comments: string[] }>();
	const team = { teamId: "t", teamKey: "TREBOL", projectId: "p", project: "P", assigneeId: "u", assignee: "Luis" };
	return {
		async resolve() { return { ...team, states: { "in progress": "s-ip", "in review": "s-ir", done: "s-done" } }; },
		async createIssue(_r: any, _title: string, description: string, state = "In Progress") {
			const issue = { id: `iss-${++n}`, identifier: `TREBOL-${900 + n}`, description, state, comments: [] as string[] };
			issues.set(issue.id, issue);
			return { id: issue.id, identifier: issue.identifier };
		},
		async readIssue(id: string) {
			const i = issues.get(id)!;
			return { id: i.id, identifier: i.identifier, title: "", description: i.description, state: i.state, teamId: "t", projectId: "p", assigneeId: "u", comments: [...i.comments] };
		},
		async findIssueByMarker(marker: string) { const hit = [...issues.values()].find((i) => i.description.includes(marker)); return hit && { id: hit.id, identifier: hit.identifier }; },
		async comment(id: string, body: string) { issues.get(id)!.comments.push(body); },
		async setState(_r: any, id: string, state: string) { issues.get(id)!.state = state; },
	} as ClawHoja;
}

function fakePi(cwd: string) {
	const handlers: Record<string, Function[]> = {};
	const reg = new Map<string, any>();
	const pi: any = {
		active: [] as string[],
		on: (name: string, fn: Function) => { (handlers[name] ??= []).push(fn); },
		emit: async (name: string, event: unknown, ctx: unknown) => { for (const fn of handlers[name] ?? []) await fn(event, ctx); },
		registerTool: (t: any) => { reg.set(t.name, t); },
		registerCommand: (name: string, def: any) => { reg.set(`/${name}`, def); },
		getCwd: () => cwd,
		getActiveTools: () => [...pi.active],
		getAllTools: () => [...reg.entries()].filter(([k]) => !k.startsWith("/")).map(([, t]) => t),
		setActiveTools: (names: string[]) => { pi.active = [...names]; },
		appendEntry: () => undefined,
		sendUserMessage: () => undefined,
		reg,
	};
	return pi;
}
const ctxFor = (sessionId: string) => ({ sessionManager: { getSessionId: () => sessionId, getBranch: () => [], getEntries: () => [] }, ui: { notify: () => undefined } });

/** One pump of `session`'s inbox, against an empty transcript; returns what it would wake the session with. */
async function pumpAs(store: ClawStore, session: string, pid = process.pid) {
	const sent: InboxMessage[] = [];
	const result = await pumpInbox({ store, session, pid, now: () => Date.now(), delivered: () => deliveredInboxIds([]), send: async (m) => { sent.push(m); return true; } });
	return { result, sent, text: sent.map((m) => m.content).join("\n") };
}

const baseRun = (id: string, dir: string, extra: Partial<Run> = {}): Run => ({ id, label: id, task: "t", cwd: dir, status: "running", phase: "tab_open", createdAt: "", updatedAt: "", project: "P", eventsOffset: 0, settles: 0, attempts: 0, outbox: [], seen: [], ...extra });
const finish = (store: ClawStore, run: Run, summary: string) =>
	applyEvent(run, { eid: `f-${run.id}`, type: "finish", at: "", runId: run.id, outcome: "completed", summary, evidence: ["x"] }, store);

describe("claw: two orchestrator sessions on one workspace", () => {
	let dir: string;
	let store: ClawStore;
	beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "claw-multi-")); store = ClawStore.forWorkspace(dir); setClawMode(false); });
	afterEach(() => { setClawMode(false); setClawAgentRoute(undefined); rmSync(dir, { recursive: true, force: true }); });

	/** A turns Claw on in pane 100, then B (another process) in pane 200: the order that used to hand B everything. */
	async function twoClaws() {
		const noDaemon = () => 4242; // pretend a daemon answers; never spawn one
		const a = fakePi(dir);
		registerOrchestrator(a, { tern: twoWindowTern().exec, env: { TERN_PANE: "100" }, ensure: noDaemon });
		await a.emit("session_start", {}, ctxFor("sess-A"));
		await a.reg.get("/claw").handler("on", ctxFor("sess-A"));
		setClawMode(false); // B is a separate process with its own process-local mode
		const b = fakePi(dir);
		registerOrchestrator(b, { tern: twoWindowTern().exec, env: { TERN_PANE: "200" }, ensure: noDaemon });
		await b.emit("session_start", {}, ctxFor("sess-B"));
		await b.reg.get("/claw").handler("on", ctxFor("sess-B"));
		return { a, b };
	}

	it("each session receives only its own runs' completions, whichever ran /claw on last", async () => {
		await twoClaws();
		const runA = store.saveRun(baseRun("run-a", dir, { owner: "sess-A", pane: 100 }));
		const runB = store.saveRun(baseRun("run-b", dir, { owner: "sess-B", pane: 200 }));
		finish(store, runA, "A's work");
		finish(store, runB, "B's work");
		const atA = await pumpAs(store, "sess-A");
		const atB = await pumpAs(store, "sess-B");
		expect(atA.sent.map((m) => m.customType)).toEqual([INBOX_TYPE]);
		expect(atA.text).toContain("A's work");
		expect(atA.text).not.toContain("B's work");
		expect(atB.text).toContain("B's work");
		expect(atB.text).not.toContain("A's work");
	});

	it("a later /claw on in B does not move A's cursor (near miss: re-registration is idempotent)", async () => {
		const { b } = await twoClaws();
		const cursorA = JSON.stringify(store.readCursor("sess-A"));
		await b.reg.get("/claw").handler("on", ctxFor("sess-B"));
		expect(JSON.stringify(store.readCursor("sess-A"))).toBe(cursorA);
	});

	it("daemon-wide items and runs from before owners reach every session (near miss: nothing is dropped)", async () => {
		await twoClaws();
		const legacy = store.saveRun(baseRun("run-old", dir));
		finish(store, legacy, "legacy work");
		store.appendInbox({ kind: "error", text: "claw daemon: something broke", key: "daemon:1" });
		for (const s of ["sess-A", "sess-B"]) {
			const got = await pumpAs(store, s);
			expect(got.text).toContain("legacy work");
			expect(got.text).toContain("something broke");
		}
	});

	it("a session that never turned Claw on receives nothing", async () => {
		await twoClaws();
		store.appendInbox({ kind: "error", text: "x", key: "daemon:2" });
		expect((await pumpAs(store, "sess-C")).result).toBe("not_owner");
	});

	it("the calling session and its pane are stamped on spawn and on a trigger, not on other requests", () => {
		const at = { kind: "at" as const, at: "2026-01-01T00:00:00Z" };
		expect(stampOrigin({ kind: "spawn", input: { task: "t", project: "P" } }, "sess-A", 100)).toMatchObject({ input: { owner: "sess-A", pane: 100 } });
		expect(stampOrigin({ kind: "trigger_add", when: at, action: { kind: "spawn", task: "t", project: "P" }, once: true }, "sess-A", 100))
			.toMatchObject({ owner: "sess-A", pane: 100, action: { owner: "sess-A", pane: 100 } });
		const notify = stampOrigin({ kind: "trigger_add", when: at, action: { kind: "notify", message: "m" }, once: true }, "sess-A", undefined);
		expect(notify).toMatchObject({ owner: "sess-A", action: { kind: "notify", message: "m" } });
		expect(notify).not.toHaveProperty("pane");
		expect(stampOrigin({ kind: "cancel", runId: "run-x" }, "sess-A", 100)).toEqual({ kind: "cancel", runId: "run-x" });
		expect(stampOrigin({ kind: "spawn", input: { task: "t", project: "P" } }, "", 100)).toEqual({ kind: "spawn", input: { task: "t", project: "P" } });
	});

	describe("through the daemon", () => {
		let tern: ReturnType<typeof twoWindowTern>;
		let deps: DaemonDeps;
		beforeEach(() => {
			tern = twoWindowTern();
			deps = { store, hoja: fakeHoja(), tern: tern.exec, workspace: dir, now: () => new Date(), alive: () => true, signal: () => undefined };
		});
		const request = (r: Record<string, unknown>) => store.writeRequest({ ...r, createdAt: new Date().toISOString() } as unknown as Request);
		const expiresAt = () => new Date(Date.now() + 60_000).toISOString();

		it("A's worker tab opens in A's Tern session even though B ran /claw on last", async () => {
			await twoClaws();
			expect(store.readControl().pane).toBe(200); // the shared pane names B: exactly the old trap
			request({ id: "req-a", kind: "spawn", expiresAt: expiresAt(), input: { task: "A's task", project: "P", owner: "sess-A", pane: 100 } });
			request({ id: "req-b", kind: "spawn", expiresAt: expiresAt(), input: { task: "B's task", project: "P", owner: "sess-B", pane: 200 } });
			await tick(deps);
			const byTask = Object.fromEntries(store.listRuns().map((r) => [r.task, r]));
			expect(byTask["A's task"]).toMatchObject({ owner: "sess-A", pane: 100, phase: "tab_open" });
			expect(byTask["B's task"]).toMatchObject({ owner: "sess-B", pane: 200, phase: "tab_open" });
			expect(tern.opened.map((o) => o.session).sort()).toEqual([1, 2]);
		});

		it("a run spawned without a pane still opens where /claw on recorded (near miss: old callers unchanged)", async () => {
			await twoClaws();
			request({ id: "req-n", kind: "spawn", expiresAt: expiresAt(), input: { task: "no pane", project: "P" } });
			await tick(deps);
			expect(tern.opened.map((o) => o.session)).toEqual([2]);
		});

		it("a trigger added by A fires a run owned by A, and its notices go to A only", async () => {
			await twoClaws();
			request({ id: "req-t", kind: "trigger_add", when: { kind: "at", at: new Date(Date.now() - 1000).toISOString() }, action: { kind: "spawn", task: "nightly", project: "P", owner: "sess-A", pane: 100 }, once: true, owner: "sess-A", pane: 100 });
			await tick(deps);
			await tick(deps);
			const run = store.listRuns().find((r) => r.task === "nightly");
			expect(run).toMatchObject({ owner: "sess-A", pane: 100 });
			expect(tern.opened.map((o) => o.session)).toEqual([1]);
			expect((await pumpAs(store, "sess-A")).text).toContain("fired");
			expect((await pumpAs(store, "sess-B")).text).not.toContain("fired");
		});
	});

	it("the digest is split per session: each digest names only that session's runs", async () => {
		await twoClaws();
		store.saveRun(baseRun("run-a", dir, { owner: "sess-A", label: "alpha-run" }));
		store.saveRun(baseRun("run-b", dir, { owner: "sess-B", label: "beta-run" }));
		store.appendNotice({ kind: "run_started", runId: "run-a", text: "alpha-run is running", key: "n-a" });
		store.appendNotice({ kind: "run_started", runId: "run-b", text: "beta-run is running", key: "n-b" });
		flushDigest(store, Date.now(), DEFAULT_SLO);
		const atA = await pumpAs(store, "sess-A");
		const atB = await pumpAs(store, "sess-B");
		expect(atA.text).toContain("alpha-run");
		expect(atA.text).not.toContain("beta-run");
		expect(atB.text).toContain("beta-run");
		expect(atB.text).not.toContain("alpha-run");
	});
});

describe("claw: per-session cursor lifecycle", () => {
	let dir: string;
	let store: ClawStore;
	beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "claw-cursor-")); store = ClawStore.forWorkspace(dir); });
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("a new session starts at the inbox end: it never replays history from before it registered", async () => {
		store.appendInbox({ kind: "error", text: "old news", key: "old" });
		store.registerSession("sess-new", process.pid, () => true);
		expect((await pumpAs(store, "sess-new")).result).toBe("idle");
	});

	it("the legacy single cursor goes to the session it named, with its undelivered items", async () => {
		store.appendInbox({ kind: "error", text: "pending for A", key: "p1" });
		store.writeOrchestrator({ offset: 0, owner: "sess-A", ownerPid: 999_999 });
		store.registerSession("sess-A", process.pid, () => true);
		expect((await pumpAs(store, "sess-A")).text).toContain("pending for A");
		expect(store.readOrchestrator().migratedTo).toBe("sess-A");
	});

	it("a live legacy owner keeps its cursor: another session does not take it (near miss)", async () => {
		store.appendInbox({ kind: "error", text: "pending for A", key: "p1" });
		store.writeOrchestrator({ offset: 0, owner: "sess-A", ownerPid: 4242 });
		store.registerSession("sess-B", process.pid, (p) => p === 4242);
		expect((await pumpAs(store, "sess-B")).result).toBe("idle");
		expect(store.readOrchestrator().migratedTo).toBeUndefined();
	});

	it("a dead legacy owner's cursor is inherited once, by the first session to register", () => {
		store.appendInbox({ kind: "error", text: "orphaned", key: "p1" });
		store.writeOrchestrator({ offset: 0, owner: "sess-gone", ownerPid: 4242 });
		store.registerSession("sess-B", process.pid, () => false);
		store.registerSession("sess-C", process.pid, () => false);
		expect(store.readCursor("sess-B")?.offset).toBe(0);
		expect(store.readCursor("sess-C")?.offset).toBe(store.inboxEnd());
	});

	it("a restarted process of the same session resends an undelivered batch at once", async () => {
		store.registerSession("sess-A", 111, () => true);
		store.appendInbox({ kind: "error", text: "lost wake", key: "w1" });
		expect((await pumpAs(store, "sess-A", 111)).result).toBe("sent");
		expect((await pumpAs(store, "sess-A", 111)).result).toBe("waiting");
		const after = await pumpAs(store, "sess-A", 222);
		expect(after.result).toBe("sent");
		expect(after.sent[0].details.eventIds).toEqual(["w1"]);
	});

	it("a session id that is not filename-safe cannot escape the sessions directory", () => {
		store.registerSession("../../evil", process.pid, () => true);
		expect(store.readCursor("../../evil")).toBeDefined();
		expect(store.readCursor("evil")).toBeUndefined();
	});
});
