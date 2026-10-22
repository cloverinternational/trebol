/** Lifecycle of the detached Claw supervisor: stop it cleanly, and replace it when it runs older code.
 *
 *  The daemon must outlive the Pi session (triggers, inbox, Hoja outbox), so it is never tied to the session's
 *  lifetime in general. What it must not do is outlive its own sources: after `/reload`, a branch switch or a merge it
 *  keeps running the code it was started from while the extension around it is new. Two entry points fix that:
 *   - `stopDaemon` — SIGTERM the pid recorded in `daemon.lock`, wait a bounded time, escalate to SIGKILL only if the
 *     process ignores it, and report what actually happened. It never signals a worker: only the lock's pid, and only
 *     after that pid is confirmed to be a claw daemon and not one of the runs' workers.
 *   - `refreshDaemon` — compare the lock's code stamp with the code on disk and, when they differ, stop the stale
 *     process and (optionally) start a daemon from the current code.
 *  Kill nothing on a guess: an unreadable tree, an unverifiable pid or a lock we cannot attribute is reported, never
 *  acted on. Workers keep running in their tabs throughout; the next daemon reconciles them from the store. */
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { readJson, ClawStore, type DaemonLock } from "./store.ts";
import { pidAlive, startDaemonProcess } from "./daemon.ts";
import { compareFingerprint, computeClawFingerprint, needsReplacement, type ClawFingerprint, type FingerprintState } from "./fingerprint.ts";

export const DAEMON_MAIN = new URL("./daemon-main.ts", import.meta.url).pathname;
/** How long a SIGTERM'd daemon has to exit before SIGKILL. The daemon's own handler exits immediately, so this is
 *  only reached by a process that is wedged. */
export const STOP_WAIT_MS = 2_000;
/** How long a SIGKILL'd daemon has to disappear before the stop is reported as failed. */
export const KILL_WAIT_MS = 1_000;

export type DaemonProbe = {
	alive: (pid: number) => boolean;
	/** The pid's command line, or undefined when it cannot be read. Used to refuse to signal a recycled pid. */
	command?: (pid: number) => string | undefined;
	signal: (pid: number, signal: "SIGTERM" | "SIGKILL") => void;
	sleep?: (ms: number) => Promise<void>;
	waitMs?: number;
	killWaitMs?: number;
};

export type StopOutcome = {
	/** true only when this call is what ended a daemon process. */
	stopped: boolean;
	state: "stopped" | "absent" | "stale-lock-taken" | "refused" | "failed";
	pid?: number;
	escalated: boolean;
	/** Always a sentence: what was found, what was done, and what to do next when nothing could be done. */
	reason: string;
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const DAEMON_COMMAND = /daemon-main/;

/** Real probe. `ps` is the only way to tell a recycled pid from our daemon; when it cannot answer, we do not signal. */
export function systemProbe(overrides: Partial<DaemonProbe> = {}): DaemonProbe {
	return {
		alive: pidAlive,
		command: (pid) => {
			try {
				const out = execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8", timeout: 3_000, stdio: ["ignore", "pipe", "ignore"] }).trim();
				return out || undefined;
			} catch { return undefined; }
		},
		signal: (pid, signal) => { process.kill(pid, signal); },
		sleep,
		...overrides,
	};
}

/** Pids that belong to runs' worker processes. They are never the daemon, whatever the lock says. */
function workerPids(store: ClawStore): Set<number> {
	const pids = new Set<number>();
	for (const run of store.listRuns()) if (run.pid !== undefined) pids.add(run.pid);
	return pids;
}

/** Stops the daemon named by the lock, if one is alive. Never throws: every outcome is a value with a reason. */
export async function stopDaemon(store: ClawStore, probe: DaemonProbe = systemProbe()): Promise<StopOutcome> {
	const lock = readJson<DaemonLock>(store.lockPath);
	if (!lock || !Number.isInteger(lock.pid) || lock.pid <= 1) {
		return { stopped: false, state: "absent", escalated: false, reason: "no daemon lock names a process; nothing to stop" };
	}
	const pid = lock.pid;
	if (pid === process.pid) {
		return { stopped: false, state: "refused", pid, escalated: false, reason: `the lock names this process (pid ${pid}); refusing to signal itself` };
	}
	if (workerPids(store).has(pid)) {
		return { stopped: false, state: "refused", pid, escalated: false, reason: `the lock names pid ${pid}, which is a run's worker; a worker is never signalled` };
	}
	if (!probe.alive(pid)) {
		// A lock left by a killed daemon. Removing it is what lets the next start claim the singleton; it is not a signal.
		releaseLockOf(store, pid);
		return { stopped: false, state: "stale-lock-taken", pid, escalated: false, reason: `the lock's pid ${pid} is dead; removed the leftover lock so a new daemon can claim it` };
	}
	if (probe.command) {
		const command = probe.command(pid);
		if (command === undefined) {
			return { stopped: false, state: "refused", pid, escalated: false, reason: `cannot read the command of pid ${pid}, so it cannot be confirmed as a claw daemon; not signalled. Stop it by hand if it is the daemon` };
		}
		if (!DAEMON_COMMAND.test(command)) {
			releaseLockOf(store, pid);
			return { stopped: false, state: "stale-lock-taken", pid, escalated: false, reason: `the lock names pid ${pid}, but that process is not a claw daemon (${command.slice(0, 120)}); removed the stale lock and signalled nothing` };
		}
	}
	try { probe.signal(pid, "SIGTERM"); } catch (error) {
		return { stopped: false, state: "failed", pid, escalated: false, reason: `SIGTERM to daemon pid ${pid} failed: ${(error as Error).message}` };
	}
	const wait = probe.sleep ?? sleep;
	if (await gone(probe, wait, pid, probe.waitMs ?? STOP_WAIT_MS)) {
		return { stopped: true, state: "stopped", pid, escalated: false, reason: `daemon pid ${pid} stopped with SIGTERM` };
	}
	try { probe.signal(pid, "SIGKILL"); } catch (error) {
		return { stopped: false, state: "failed", pid, escalated: true, reason: `daemon pid ${pid} ignored SIGTERM and SIGKILL failed: ${(error as Error).message}` };
	}
	if (await gone(probe, wait, pid, probe.killWaitMs ?? KILL_WAIT_MS)) {
		return { stopped: true, state: "stopped", pid, escalated: true, reason: `daemon pid ${pid} ignored SIGTERM and was killed with SIGKILL; unfilled work is retried by the next daemon` };
	}
	return { stopped: false, state: "failed", pid, escalated: true, reason: `daemon pid ${pid} is still alive after SIGTERM and SIGKILL; it is running older code until it is stopped by hand` };
}

async function gone(probe: DaemonProbe, wait: (ms: number) => Promise<void>, pid: number, waitMs: number): Promise<boolean> {
	const deadline = Date.now() + waitMs;
	while (Date.now() < deadline) {
		if (!probe.alive(pid)) return true;
		await wait(50);
	}
	return !probe.alive(pid);
}

/** Removes a lock that names `pid`, and only that one: a lock re-claimed by someone else in between is left alone. */
function releaseLockOf(store: ClawStore, pid: number): void {
	if (readJson<DaemonLock>(store.lockPath)?.pid === pid) rmSync(store.lockPath, { force: true });
}

export type RefreshOutcome = {
	/** current: the live daemon already runs this code. stopped: a stale one was stopped. restarted: stopped and a new
	 *  one was started. started: none was running and one was started. absent: none is running. skipped: nothing was
	 *  done, and `note` says why. */
	action: "current" | "stopped" | "restarted" | "started" | "absent" | "skipped";
	state: FingerprintState;
	pid?: number;
	fingerprint?: ClawFingerprint;
	stop?: StopOutcome;
	/** Set when a live stale daemon could not be replaced: callers must not queue work it will never answer. */
	blocked: boolean;
	note: string;
};

export type RefreshOptions = {
	/** Start a daemon when none is running (default false: only /claw on and a request do that). */
	start?: boolean;
	probe?: DaemonProbe;
	/** The current code fingerprint; `null` states explicitly that it cannot be computed (tests and degraded hosts). */
	fingerprint?: ClawFingerprint | null;
	workspace?: string;
	daemonMain?: string;
	/** How a daemon is spawned; injectable so a test never starts a real process. */
	spawnDaemon?: (workspace: string, store: ClawStore, daemonMain: string) => void;
};

/** Compares the running daemon's code stamp with the code on disk and replaces it when it is stale. */
export async function refreshDaemon(store: ClawStore, workspace: string, options: RefreshOptions = {}): Promise<RefreshOutcome> {
	const fingerprint = options.fingerprint === null ? undefined : options.fingerprint ?? computeClawFingerprint();
	const comparison = compareFingerprint(readJson<DaemonLock>(store.lockPath)?.fingerprint, fingerprint?.key);
	const probe = options.probe ?? systemProbe();
	const start = () => (options.spawnDaemon ?? startDaemonProcess)(workspace, store, options.daemonMain ?? DAEMON_MAIN);
	const pid = readJson<DaemonLock>(store.lockPath)?.pid;
	const live = pid !== undefined && Number.isInteger(pid) && pid > 1 && probe.alive(pid);

	if (!live) {
		// A lock naming a dead process is a leftover; removing it is harmless and lets the next claim succeed.
		if (pid !== undefined) releaseLockOf(store, pid);
		if (!options.start) return { action: "absent", state: comparison.state, fingerprint, blocked: false, note: "no daemon is running" };
		start();
		return { action: "started", state: comparison.state, fingerprint, blocked: false, note: "no daemon was running; started one from the current code" };
	}
	if (comparison.state === "current") {
		return { action: "current", state: "current", pid, fingerprint, blocked: false, note: `daemon pid ${pid} already runs this code` };
	}
	if (!needsReplacement(comparison)) {
		// unknown: this code cannot be fingerprinted, so the running daemon cannot be judged. Report, do not signal.
		return { action: "skipped", state: comparison.state, pid, fingerprint, blocked: false, note: `daemon pid ${pid} left running: ${comparison.detail}` };
	}
	const stop = await stopDaemon(store, probe);
	if (!stop.stopped && stop.state !== "stale-lock-taken") {
		return { action: "skipped", state: comparison.state, pid, fingerprint, stop, blocked: true, note: `daemon pid ${pid} runs older code and could not be stopped: ${stop.reason}` };
	}
	if (!options.start) {
		return { action: "stopped", state: comparison.state, pid, fingerprint, stop, blocked: false, note: `stopped the daemon that ran older code (${comparison.detail}); the next Claw call starts a new one` };
	}
	start();
	return { action: "restarted", state: comparison.state, pid, fingerprint, stop, blocked: false, note: `replaced daemon pid ${pid} with a daemon started from the current code` };
}
