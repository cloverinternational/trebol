import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claimLock, heartbeat, pidAlive, runDaemon, tick, type DaemonDeps } from "../../lib/claw/daemon.ts";
import { compareFingerprint, computeClawFingerprint, fingerprintKey, needsReplacement, sourcesHash, clawCodeDir } from "../../lib/claw/fingerprint.ts";
import { refreshDaemon, stopDaemon, type DaemonProbe } from "../../lib/claw/lifecycle.ts";
import { ensureDaemon, request } from "../../lib/claw/orchestrator.ts";
import { ClawStore, type DaemonLock, type Run } from "../../lib/claw/store.ts";
import { registerOrchestrator } from "../../../extensions/claw/extension.ts";
import { setClawAgentRoute, setClawMode } from "../../lib/claw/mode.ts";

const HEAD_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HEAD_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

/** A throwaway copy of the Claw library, so a test can edit "the code on disk" without touching this checkout. */
function codeTree(root: string): string {
	const dir = join(root, "lib", "claw");
	mkdirSync(dir, { recursive: true });
	for (const file of ["daemon.ts", "store.ts", "spawn.ts"]) {
		// Only the bytes matter: the fingerprint hashes paths and contents, it never executes them.
		writeFileSync(join(dir, file), `// ${file}\nexport const marker = 1;\n`);
	}
	return dir;
}

/** A probe whose processes live in a Set. `killsWith` decides which signal actually ends a process. */
function fakeProbe(options: { pids?: number[]; killableWith?: "SIGTERM" | "SIGKILL" | "never"; command?: (pid: number) => string | undefined } = {}) {
	const alive = new Set<number>(options.pids ?? []);
	const signals: { pid: number; signal: string }[] = [];
	const killable = options.killableWith ?? "SIGTERM";
	const probe: DaemonProbe = {
		alive: (pid) => alive.has(pid),
		signal: (pid, signal) => {
			signals.push({ pid, signal });
			if (killable !== "never" && signal === killable) alive.delete(pid);
		},
		sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, Math.min(ms, 2))),
		waitMs: 40,
		killWaitMs: 40,
	};
	if (options.command) probe.command = options.command;
	return { probe, alive, signals, terminations: () => signals.filter((s) => s.signal === "SIGTERM").length };
}

function workspace(dir: string): ClawStore {
	const store = ClawStore.forWorkspace(dir);
	store.writeControl(true, undefined);
	return store;
}

function lockOf(store: ClawStore): DaemonLock | undefined {
	try { return JSON.parse(readFileSync(store.lockPath, "utf8")) as DaemonLock; } catch { return undefined; }
}

describe("claw daemon code fingerprint", () => {
	let root: string;
	beforeEach(() => { root = mkdtempSync(join(tmpdir(), "claw-fp-")); });
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it("hashes the library sources and nothing else", () => {
		const dir = codeTree(root);
		const first = sourcesHash(dir);
		expect(sourcesHash(dir)).toBe(first);
		// An unrelated file in the same tree is not Claw code.
		writeFileSync(join(root, "lib", "claw", "notes.md"), "x");
		writeFileSync(join(root, "lib", "claw", "dist.ts.skip"), "x");
		expect(sourcesHash(dir)).toBe(first);
		// A changed byte is a changed fingerprint.
		appendFileSync(join(dir, "daemon.ts"), "// edit\n");
		expect(sourcesHash(dir)).not.toBe(first);
	});

	it("changes key for a new commit and for an uncommitted edit", () => {
		const dir = codeTree(root);
		const a = computeClawFingerprint({ codeDir: dir, head: () => HEAD_A })!;
		const b = computeClawFingerprint({ codeDir: dir, head: () => HEAD_B })!;
		expect(a.key).not.toBe(b.key);
		expect(a.head).toBe(HEAD_A);
		appendFileSync(join(dir, "store.ts"), "// uncommitted\n");
		const edited = computeClawFingerprint({ codeDir: dir, head: () => HEAD_A })!;
		expect(edited.key).not.toBe(a.key);
		// No git checkout is not "no fingerprint": the sources still identify the code.
		const noGit = computeClawFingerprint({ codeDir: dir, head: () => null })!;
		expect(noGit.head).toBeNull();
		expect(noGit.key).toBe(fingerprintKey({ head: null, sources: noGit.sources }));
	});

	it("an unreadable tree is unknown, never a change", () => {
		expect(computeClawFingerprint({ codeDir: join(root, "missing") })).toBeUndefined();
		const comparison = compareFingerprint("1:x:y", undefined);
		expect(comparison.state).toBe("unknown");
		expect(needsReplacement(comparison)).toBe(false);
	});

	it("compares a stamp as current, stale or unstamped", () => {
		const key = "1:abc:def";
		expect(compareFingerprint(key, key).state).toBe("current");
		expect(compareFingerprint("1:abc:other", key).state).toBe("stale");
		expect(compareFingerprint(undefined, key).state).toBe("unstamped");
		expect(compareFingerprint("", key).state).toBe("unstamped");
		expect(compareFingerprint(42, key).state).toBe("unstamped");
		// Only evidence of other code replaces a live daemon: current is kept, unknown is never acted on.
		expect(needsReplacement({ state: "current", detail: "" })).toBe(false);
		expect(needsReplacement({ state: "stale", detail: "" })).toBe(true);
		expect(needsReplacement({ state: "unstamped", detail: "" })).toBe(true);
	});

	it("the shipped library fingerprints itself", () => {
		const fingerprint = computeClawFingerprint()!;
		expect(fingerprint.sources).toMatch(/^[0-9a-f]{64}$/);
		expect(fingerprint.key.startsWith("1:")).toBe(true);
		expect(clawCodeDir()).toContain(".pi/lib/claw");
	});
});

describe("claw daemon lock stamping", () => {
	let dir: string;
	let store: ClawStore;
	beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "claw-stamp-")); store = workspace(dir); });
	afterEach(() => { setClawMode(false); setClawAgentRoute(undefined); rmSync(dir, { recursive: true, force: true }); });

	it("claimLock stamps the code key and heartbeat keeps it", () => {
		expect(claimLock(store, () => false, "1:head:sources")).toBe(true);
		expect(lockOf(store)?.fingerprint).toBe("1:head:sources");
		expect(lockOf(store)?.pid).toBe(process.pid);
		expect(heartbeat(store)).toBe(true);
		// A heartbeat that forgot the stamp would erase the only evidence of what this process runs.
		expect(lockOf(store)?.fingerprint).toBe("1:head:sources");
		expect(lockOf(store)?.startedAt).toBeDefined();
	});

	it("a daemon started while the code was unreadable stamps nothing and says so in the lock", () => {
		expect(claimLock(store, () => false)).toBe(true);
		expect(lockOf(store)?.fingerprint).toBeUndefined();
	});
});

describe("claw daemon shutdown path", () => {
	let dir: string;
	let store: ClawStore;
	beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "claw-stop-")); store = workspace(dir); });
	afterEach(() => { setClawMode(false); setClawAgentRoute(undefined); rmSync(dir, { recursive: true, force: true }); });

	const writeLock = (pid: number, fingerprint?: string) =>
		writeFileSync(store.lockPath, JSON.stringify({ pid, startedAt: "2026-10-21T16:00:00.000Z", heartbeat: 0, ...(fingerprint ? { fingerprint } : {}) }));

	it("SIGTERMs the pid the lock names and reports what it did", async () => {
		writeLock(424242, "1:a:b");
		const fake = fakeProbe({ pids: [424242], command: () => "node --experimental-strip-types /x/daemon-main.ts /ws" });
		const outcome = await stopDaemon(store, fake.probe);
		expect(outcome).toMatchObject({ stopped: true, state: "stopped", pid: 424242, escalated: false });
		expect(fake.signals).toEqual([{ pid: 424242, signal: "SIGTERM" }]);
		expect(outcome.reason).toContain("stopped with SIGTERM");
	});

	it("escalates to SIGKILL only when SIGTERM is ignored", async () => {
		writeLock(424243, "1:a:b");
		const fake = fakeProbe({ pids: [424243], killableWith: "SIGKILL", command: () => "node /x/daemon-main.ts /ws" });
		const outcome = await stopDaemon(store, fake.probe);
		expect(outcome).toMatchObject({ stopped: true, escalated: true });
		expect(fake.signals.map((s) => s.signal)).toEqual(["SIGTERM", "SIGKILL"]);
	});

	it("a daemon that survives both signals is reported, never silently ignored", async () => {
		writeLock(424244, "1:a:b");
		const fake = fakeProbe({ pids: [424244], killableWith: "never", command: () => "node /x/daemon-main.ts /ws" });
		const outcome = await stopDaemon(store, fake.probe);
		expect(outcome).toMatchObject({ stopped: false, state: "failed", escalated: true });
		expect(outcome.reason).toContain("still alive");
		expect(outcome.reason).toContain("by hand");
	});

	it("no lock means nothing to stop", async () => {
		const fake = fakeProbe();
		expect(await stopDaemon(store, fake.probe)).toMatchObject({ stopped: false, state: "absent" });
		expect(fake.signals).toEqual([]);
	});

	it("a lock left by a killed process is taken over without a signal", async () => {
		writeLock(424245, "1:a:b");
		const fake = fakeProbe({ pids: [], command: () => "node /x/daemon-main.ts /ws" });
		const outcome = await stopDaemon(store, fake.probe);
		expect(outcome).toMatchObject({ stopped: false, state: "stale-lock-taken" });
		expect(fake.signals).toEqual([]);
		// The leftover lock is gone, so the next daemon claims it instead of finding a phantom owner.
		expect(lockOf(store)).toBeUndefined();
		expect(claimLock(store, () => false, "1:new:code")).toBe(true);
	});

	it("a running worker is never signalled, even when the lock names it", async () => {
		const run: Run = { id: "run-w1", label: "w", task: "t", cwd: dir, status: "running", phase: "tab_open", createdAt: "2026-10-21T10:00:00.000Z", updatedAt: "", project: "p", pid: 424246, eventsOffset: 0, settles: 0, attempts: 0, outbox: [], seen: [] };
		store.saveRun(run);
		writeLock(424246, "1:a:b");
		const fake = fakeProbe({ pids: [424246], command: () => "node /x/daemon-main.ts /ws" });
		const outcome = await stopDaemon(store, fake.probe);
		expect(outcome).toMatchObject({ stopped: false, state: "refused" });
		expect(outcome.reason).toContain("worker");
		expect(fake.signals).toEqual([]);
		expect(fake.alive.has(424246)).toBe(true);
	});

	it("a recycled pid is not signalled and its stale lock is removed", async () => {
		writeLock(424247, "1:a:b");
		const fake = fakeProbe({ pids: [424247], command: () => "/usr/bin/some-unrelated-process --serve" });
		const outcome = await stopDaemon(store, fake.probe);
		expect(outcome).toMatchObject({ stopped: false, state: "stale-lock-taken" });
		expect(outcome.reason).toContain("not a claw daemon");
		expect(fake.signals).toEqual([]);
		expect(lockOf(store)).toBeUndefined();
	});

	it("an unverifiable pid is left alone and reported", async () => {
		writeLock(424248, "1:a:b");
		const fake = fakeProbe({ pids: [424248], command: () => undefined });
		const outcome = await stopDaemon(store, fake.probe);
		expect(outcome).toMatchObject({ stopped: false, state: "refused" });
		expect(outcome.reason).toContain("not signalled");
		expect(fake.signals).toEqual([]);
		// Nothing was proven, so the lock is still there for a human or a later check.
		expect(lockOf(store)?.pid).toBe(424248);
	});
});

describe("claw daemon refresh", () => {
	let dir: string;
	let store: ClawStore;
	beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "claw-refresh-")); store = workspace(dir); });
	afterEach(() => { setClawMode(false); setClawAgentRoute(undefined); rmSync(dir, { recursive: true, force: true }); });

	const live = (pid: number, fingerprint?: string) =>
		writeFileSync(store.lockPath, JSON.stringify({ pid, startedAt: "2026-10-21T16:00:00.000Z", heartbeat: 0, ...(fingerprint ? { fingerprint } : {}) }));
	const code = (key: string) => ({ version: 1 as const, head: HEAD_A, sources: "s", key });
	const daemonCommand = () => "node /x/daemon-main.ts /ws";

	it("the same code is left running: no signal, no restart", async () => {
		live(500001, "1:same:code");
		const fake = fakeProbe({ pids: [500001], command: daemonCommand });
		let started = 0;
		const outcome = await refreshDaemon(store, dir, { fingerprint: code("1:same:code"), probe: fake.probe, start: true, spawnDaemon: () => { started++; } });
		expect(outcome.action).toBe("current");
		expect(fake.signals).toEqual([]);
		expect(started).toBe(0);
		expect(lockOf(store)?.pid).toBe(500001);
	});

	it("a stale daemon is stopped, and restarted only when a start was asked for", async () => {
		live(500002, "1:old:code");
		const fake = fakeProbe({ pids: [500002], command: daemonCommand });
		let started = 0;
		const stopped = await refreshDaemon(store, dir, { fingerprint: code("1:new:code"), probe: fake.probe, spawnDaemon: () => { started++; } });
		expect(stopped).toMatchObject({ action: "stopped", blocked: false });
		expect(fake.terminations()).toBe(1);
		expect(started).toBe(0);

		live(500003, "1:old:code");
		const fake2 = fakeProbe({ pids: [500003], command: daemonCommand });
		const restarted = await refreshDaemon(store, dir, { fingerprint: code("1:new:code"), probe: fake2.probe, start: true, spawnDaemon: () => { started++; } });
		expect(restarted.action).toBe("restarted");
		expect(started).toBe(1);
	});

	it("a daemon that does not stamp its code counts as older code", async () => {
		live(500004);
		const fake = fakeProbe({ pids: [500004], command: daemonCommand });
		const outcome = await refreshDaemon(store, dir, { fingerprint: code("1:new:code"), probe: fake.probe });
		expect(outcome.state).toBe("unstamped");
		expect(outcome.action).toBe("stopped");
	});

	it("an unreadable tree never signals a daemon", async () => {
		live(500005, "1:any:code");
		const fake = fakeProbe({ pids: [500005], command: daemonCommand });
		const outcome = await refreshDaemon(store, dir, { fingerprint: null, probe: fake.probe });
		expect(outcome).toMatchObject({ action: "skipped", state: "unknown", blocked: false });
		expect(fake.signals).toEqual([]);
	});

	it("a daemon that cannot be stopped blocks the caller instead of queueing work it will never answer", async () => {
		live(500006, "1:old:code");
		const fake = fakeProbe({ pids: [500006], killableWith: "never", command: daemonCommand });
		const outcome = await refreshDaemon(store, dir, { fingerprint: code("1:new:code"), probe: fake.probe, start: true, spawnDaemon: () => undefined });
		expect(outcome).toMatchObject({ action: "skipped", blocked: true });
		expect(outcome.note).toContain("could not be stopped");
		// The client sees the refusal before it queues: a lock that names a live process is what triggers the check.
		writeFileSync(store.lockPath, JSON.stringify({ pid: process.pid, startedAt: "x", heartbeat: 0, fingerprint: "1:old:code" }));
		await expect(request(store, dir, { kind: "trigger_remove", triggerId: "trg-x" }, {
			refresh: () => Promise.resolve(outcome), ensure: () => undefined, timeoutMs: 500,
		})).rejects.toThrow(/could not be stopped/);
	});

	it("starts a daemon only when one is asked for, and only after a dead lock is cleared", async () => {
		writeFileSync(store.lockPath, JSON.stringify({ pid: 500007, heartbeat: 0, fingerprint: "1:old:code" }));
		let started = 0;
		const absent = await refreshDaemon(store, dir, { fingerprint: code("1:new:code"), probe: fakeProbe().probe, spawnDaemon: () => { started++; } });
		expect(absent.action).toBe("absent");
		expect(started).toBe(0);
		expect(lockOf(store)).toBeUndefined();
		const began = await refreshDaemon(store, dir, { fingerprint: code("1:new:code"), probe: fakeProbe().probe, start: true, spawnDaemon: () => { started++; } });
		expect(began.action).toBe("started");
		expect(started).toBe(1);
	});

	it("ensureDaemon does not start a second daemon beside a stale one", () => {
		// A real pid is required by ensureDaemon's liveness check; the current process is alive and is not signalled here.
		writeFileSync(store.lockPath, JSON.stringify({ pid: process.pid, startedAt: "x", heartbeat: 0, fingerprint: "1:old:code" }));
		expect(ensureDaemon(store, dir, code("1:new:code"))).toBeUndefined();
		writeFileSync(store.lockPath, JSON.stringify({ pid: process.pid, startedAt: "x", heartbeat: 0, fingerprint: "1:new:code" }));
		expect(ensureDaemon(store, dir, code("1:new:code"))).toBe(process.pid);
	});
});

describe("a daemon stops serving when the code under it changes", () => {
	let root: string;
	let dir: string;
	let store: ClawStore;
	beforeEach(() => { root = mkdtempSync(join(tmpdir(), "claw-codechange-")); dir = mkdtempSync(join(tmpdir(), "claw-ws-")); store = workspace(dir); });
	afterEach(() => { rmSync(root, { recursive: true, force: true }); rmSync(dir, { recursive: true, force: true }); });

	const deps = (): DaemonDeps => ({
		store,
		hoja: { resolve: async () => { throw new Error("unused"); } } as any,
		tern: async () => JSON.stringify({ sessions: [] }),
		workspace: dir,
		now: () => new Date(),
		alive: () => true,
		signal: () => undefined,
		planLaunch: () => ({ args: [], note: "test" }) as any,
	} as DaemonDeps);

	it("exits stale-code, releases the lock, and a new daemon claims the new code", async () => {
		const lib = codeTree(root);
		const before = computeClawFingerprint({ codeDir: lib, head: () => HEAD_A })!;
		expect(claimLock(store, () => false, before.key)).toBe(true);
		// The tree changes under the running daemon, exactly like /reload, a merge or a branch switch.
		appendFileSync(join(lib, "daemon.ts"), "// new behaviour\n");
		const exit = await runDaemon(deps(), {
			tickMs: 1, idleExitMs: 60_000, checkEveryMs: 0,
			codeKey: () => computeClawFingerprint({ codeDir: lib, head: () => HEAD_A })?.key,
		});
		expect(exit).toBe("stale-code");
		// Released, so the next daemon does not find a phantom owner and exits as "another daemon owns the lock".
		expect(lockOf(store)).toBeUndefined();
		const after = computeClawFingerprint({ codeDir: lib, head: () => HEAD_A })!;
		expect(after.key).not.toBe(before.key);
		expect(claimLock(store, () => false, after.key)).toBe(true);
		expect(lockOf(store)?.fingerprint).toBe(after.key);
	});

	it("keeps serving when the fingerprint is unchanged", async () => {
		const lib = codeTree(root);
		const key = computeClawFingerprint({ codeDir: lib, head: () => HEAD_A })!.key;
		expect(claimLock(store, () => false, key)).toBe(true);
		const controller = new AbortController();
		const loop = runDaemon(deps(), { tickMs: 1, idleExitMs: 60_000, checkEveryMs: 0, codeKey: () => key, stopSignal: controller.signal });
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(lockOf(store)?.pid).toBe(process.pid);
		controller.abort();
		expect(await loop).toBe("stopped");
	});

	it("keeps serving when the code cannot be read: unreadable is not a change", async () => {
		const lib = codeTree(root);
		expect(claimLock(store, () => false, "1:known:code")).toBe(true);
		const controller = new AbortController();
		const lines: string[] = [];
		const loop = runDaemon(deps(), { tickMs: 1, idleExitMs: 60_000, checkEveryMs: 0, codeKey: () => undefined, log: (line) => lines.push(line), stopSignal: controller.signal });
		await new Promise((resolve) => setTimeout(resolve, 30));
		controller.abort();
		expect(await loop).toBe("stopped");
		expect(lines.filter((l) => l.includes("cannot fingerprint")).length).toBe(1);
		void lib;
	});

	it("restarting the supervisor leaves a running worker alone and its run reconciles from the store", async () => {
		const fingerprint = computeClawFingerprint()!;
		writeFileSync(store.lockPath, JSON.stringify({ pid: 600001, startedAt: "2026-10-21T16:00:00.000Z", heartbeat: 0, fingerprint: "1:old:code" }));
		const run: Run = { id: "run-live1", label: "worker", task: "t", cwd: dir, status: "running", phase: "tab_open", createdAt: "2026-10-21T10:00:00.000Z", updatedAt: "", project: "p", pid: 600002, block: 77, eventsOffset: 0, settles: 0, attempts: 0, outbox: [], seen: [] };
		store.saveRun(run);
		store.appendEvent({ eid: "e1", type: "settled", at: "2026-10-21T10:05:00.000Z", runId: run.id, text: "still working" });
		const fake = fakeProbe({ pids: [600001, 600002], command: () => "node /x/daemon-main.ts /ws" });
		const outcome = await refreshDaemon(store, dir, { fingerprint, probe: fake.probe });
		expect(outcome.action).toBe("stopped");
		// Only the supervisor's pid was signalled; the worker keeps running in its tab.
		expect(fake.signals.map((s) => s.pid)).toEqual([600001]);
		expect(fake.alive.has(600002)).toBe(true);
		// The next daemon picks the run up from persisted state: the settle becomes an idle turn, not a lost worker.
		// The clock is pinned one minute after the settle: the scenario is the restart, and a run idle for a day is now
		// ended by the self-supervision bound (SLO S1d), which is a different assertion made in supervisor.test.ts.
		await tick({ ...deps(), now: () => new Date("2026-10-21T10:06:00.000Z"), alive: (pid) => pid === 600002 } as DaemonDeps);
		const after = store.getRun(run.id)!;
		expect(after.status).toBe("idle");
		expect(after.error).toBeUndefined();
		expect(after.eventsOffset).toBeGreaterThan(0);
	});
});

describe("the /reload hook", () => {
	let cwd: string;
	let store: ClawStore;
	const children: ChildProcess[] = [];
	beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), "claw-hook-")); store = workspace(cwd); });
	afterEach(() => {
		for (const child of children.splice(0)) { try { child.kill("SIGKILL"); } catch { /* already gone */ } }
		setClawMode(false); setClawAgentRoute(undefined);
		rmSync(cwd, { recursive: true, force: true });
	});

	/** A real process whose command line carries "daemon-main", so the real `ps` guard accepts it as a supervisor. */
	const fakeDaemon = (): number => {
		const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "daemon-main.ts", cwd], { stdio: "ignore" });
		children.push(child);
		return child.pid!;
	};
	const extension = () => {
		const handlers: Record<string, Function[]> = {};
		const pi: any = {
			on: (name: string, fn: Function) => { (handlers[name] ??= []).push(fn); },
			registerTool: () => undefined, registerCommand: () => undefined, appendEntry: () => undefined,
			getCwd: () => cwd, getActiveTools: () => [], getAllTools: () => [], setActiveTools: () => undefined,
		};
		registerOrchestrator(pi, { ensure: () => 1, tern: async () => "{}", env: {} });
		const ctx = { sessionManager: { getSessionId: () => "s1", getBranch: () => [], getCwd: () => cwd }, ui: { notify: () => undefined } };
		const emit = async (name: string, event: unknown) => { for (const fn of handlers[name] ?? []) await fn(event, ctx); };
		return { emit };
	};
	const waitForDeath = async (pid: number, ms = 3_000) => {
		const deadline = Date.now() + ms;
		while (Date.now() < deadline && pidAlive(pid)) await new Promise((resolve) => setTimeout(resolve, 25));
		return !pidAlive(pid);
	};

	it("a reload stops a daemon that runs other code", async () => {
		const pid = fakeDaemon();
		writeFileSync(store.lockPath, JSON.stringify({ pid, startedAt: "2026-10-21T16:00:00.000Z", heartbeat: 0, fingerprint: "1:old:code" }));
		await extension().emit("session_shutdown", { type: "session_shutdown", reason: "reload" });
		expect(await waitForDeath(pid)).toBe(true);
	});

	it("a reload leaves a daemon that already runs this code", async () => {
		const pid = fakeDaemon();
		const fingerprint = computeClawFingerprint()!;
		writeFileSync(store.lockPath, JSON.stringify({ pid, startedAt: "x", heartbeat: 0, fingerprint: fingerprint.key }));
		await extension().emit("session_shutdown", { type: "session_shutdown", reason: "reload" });
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(pidAlive(pid)).toBe(true);
	});

	it("a quit keeps the detached daemon alive on purpose", async () => {
		const pid = fakeDaemon();
		writeFileSync(store.lockPath, JSON.stringify({ pid, startedAt: "x", heartbeat: 0, fingerprint: "1:old:code" }));
		await extension().emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(pidAlive(pid)).toBe(true);
	});
});

/** The real entry point, run against a copied tree so this test can edit "the code on disk". The copy needs the repo's
 *  node_modules only for the cron helper the daemon imports; nothing else is resolved from it. */
describe("the real daemon entry point", () => {
	const source = join(process.cwd(), ".pi", "lib", "claw");
	const cron = join(process.cwd(), "packages", "tools", "schedule", "src", "cron.ts");
	let repo: string;
	let dir: string;
	const children: ChildProcess[] = [];
	beforeEach(() => {
		repo = mkdtempSync(join(tmpdir(), "claw-main-repo-"));
		dir = mkdtempSync(join(tmpdir(), "claw-main-ws-"));
		mkdirSync(join(repo, ".pi", "lib"), { recursive: true });
		mkdirSync(join(repo, "packages", "tools", "schedule", "src"), { recursive: true });
		cpSync(source, join(repo, ".pi", "lib", "claw"), { recursive: true });
		cpSync(cron, join(repo, "packages", "tools", "schedule", "src", "cron.ts"));
		symlinkSync(join(process.cwd(), "node_modules"), join(repo, "node_modules"));
	});
	afterEach(() => {
		for (const child of children.splice(0)) { try { child.kill("SIGKILL"); } catch { /* already gone */ } }
		rmSync(repo, { recursive: true, force: true });
		rmSync(dir, { recursive: true, force: true });
	});

	const waitFor = async <T>(what: () => T | undefined, ms: number): Promise<T | undefined> => {
		const deadline = Date.now() + ms;
		while (Date.now() < deadline) {
			const value = what();
			if (value !== undefined) return value;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		return undefined;
	};
	const boot = (logPath: string) => {
		const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", join(repo, ".pi", "lib", "claw", "daemon-main.ts"), dir], { stdio: ["ignore", "pipe", "pipe"] });
		children.push(child);
		let text = "";
		child.stderr?.on("data", (chunk) => { text += String(chunk); });
		child.stdout?.on("data", (chunk) => { text += String(chunk); });
		void logPath;
		return { child, log: () => text };
	};

	it("stamps its code, exits when the code changes, and a new daemon takes over with the new stamp", async () => {
		const store = ClawStore.forWorkspace(dir);
		const first = boot("first");
		const firstStamp = await waitFor(() => lockOf(store)?.pid === first.child.pid ? lockOf(store)?.fingerprint : undefined, 20_000);
		expect(firstStamp).toMatch(/^1:/);
		// The code changes under the running daemon, exactly like a merge or a /reload with new sources.
		appendFileSync(join(repo, ".pi", "lib", "claw", "store.ts"), "\n// changed under the running daemon\n");
		const exited = await waitFor(() => (first.child.exitCode === null ? undefined : first.child.exitCode), 40_000);
		expect(exited).toBe(0);
		expect(first.log()).toContain("code changed under this daemon");
		expect(first.log()).toContain("exiting (stale-code)");
		// It released the lock, so the takeover is a claim, not a fight with a phantom owner.
		expect(lockOf(store)).toBeUndefined();
		const second = boot("second");
		const secondStamp = await waitFor(() => lockOf(store)?.pid === second.child.pid ? lockOf(store)?.fingerprint : undefined, 20_000);
		expect(secondStamp).toMatch(/^1:/);
		expect(secondStamp).not.toBe(firstStamp);
		// The lock is claimed before the daemon logs its banner, so wait for the
		// line instead of reading the log the instant the stamp appears.
		const secondLog = await waitFor(() => (second.log().includes("started for") ? second.log() : undefined), 20_000);
		expect(secondLog).toContain("started for");
	}, 70_000);
});
