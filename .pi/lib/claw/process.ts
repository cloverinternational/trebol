/** Process identity for /claw: "does this pid exist" is the wrong question after a host reboot.
 *
 *  `process.kill(pid, 0)` answers "does *some* process own this number". PID numbers are reused — immediately after a
 *  reboot they are handed out from the bottom of the range — so a worker that died in the reboot can look alive
 *  forever: `claw_list` reports the run resumable (it checks the pid separately) while `claw_resume` refuses it as
 *  "still running (pid N)", and the conversation becomes unreachable (TREBOL-388). Liveness therefore has to be
 *  decided by identity, in this order:
 *
 *   1. The host boot the process belonged to. A process recorded on another boot cannot still be running, so no
 *      probe is needed: the reboot itself is proof. (Linux `/proc/stat` `btime`, macOS `sysctl kern.boottime`.)
 *   2. The kernel start time, which is unique per process on one boot. Linux: `/proc/<pid>/stat` field 22
 *      (starttime, in clock ticks since boot). Elsewhere: `ps -p <pid> -o lstart=` (one-second resolution).
 *   3. The argv, as a hash, when a start time cannot be read or a legacy record has none.
 *
 *  Every failure is `undefined` — "cannot tell", never "dead". An unreadable process is not evidence that a worker is
 *  gone, and this module never turns that into a decision; the callers refuse conservatively. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/** How a process identifies itself: the kernel start token, the argv it runs, and (on the record) its boot. */
export type ProcessIdentity = {
	/** Unique on this boot: `kernel-start:<ticks>` on Linux, `lstart:<timestamp>` elsewhere. */
	start: string;
	/** The argv as the kernel reports it, truncated for messages. Never used as the only evidence of a match. */
	command?: string;
	/** Hash of the full argv, so a long command can be compared without storing it. */
	commandHash?: string;
};

/** What a decision about one recorded worker needs. Injectable so tests never touch the real process table. */
export type ProcessProbe = {
	/** Does a process with this number exist? EPERM counts as existing (the pid is taken, whoever owns it). */
	alive: (pid: number) => boolean;
	/** Identity of the process that currently owns this number, or undefined when it cannot be read. */
	identity: (pid: number) => ProcessIdentity | undefined;
	/** The current host boot, as a stable token; undefined when the platform cannot tell. */
	boot: () => string | undefined;
	/** When this host booted (epoch ms); undefined when unknown. A worker started before it cannot be alive. */
	bootedAt: () => number | undefined;
	/** Wall clock, injected so the freshness window of an identity read is testable. */
	now: () => number;
};

/** The pid exists. `EPERM` means a process owns the number but belongs to someone else: still taken, so still alive. */
export function pidAlive(pid: number): boolean {
	try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

const withCommand = (start: string, command: string | undefined): ProcessIdentity => {
	const text = command?.trim();
	if (!text) return { start };
	return { start, command: text.slice(0, 300), commandHash: createHash("sha1").update(text).digest("hex") };
};

/** Linux: the starttime field is the process's identity for the life of this boot. */
function linuxProcessIdentity(pid: number): ProcessIdentity | undefined {
	let stat: string;
	try { stat = readFileSync(`/proc/${pid}/stat`, "utf8"); } catch { return undefined; }
	// `comm` may contain spaces and parentheses, so fields are counted from the last ')'. Field 3 (state) is the first
	// token after it, which makes field 22 (starttime) index 19.
	const close = stat.lastIndexOf(")");
	if (close < 0) return undefined;
	const startTicks = stat.slice(close + 1).trim().split(/\s+/)[19];
	if (!startTicks || !/^\d+$/.test(startTicks)) return undefined;
	let command: string | undefined;
	try { command = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\u0000").filter(Boolean).join(" "); } catch { command = undefined; }
	return withCommand(`kernel-start:${startTicks}`, command);
}

/** macOS and other Unixes: `ps` is the portable way to read a start time and argv. */
function psProcessIdentity(pid: number): ProcessIdentity | undefined {
	let out: string;
	try {
		out = execFileSync("ps", ["-p", String(pid), "-o", "lstart=", "-o", "command="], {
			encoding: "utf8", timeout: 3_000, stdio: ["ignore", "pipe", "ignore"],
		});
	} catch { return undefined; }
	const line = out.trim();
	if (!line) return undefined;
	// `lstart` is a fixed 24-column timestamp ("Tue Nov  3 09:31:31 2026"); everything after it is the command.
	const match = /^(.{24})\s+(.*)$/s.exec(line);
	const start = (match?.[1] ?? line.slice(0, 24)).trim();
	return withCommand(`lstart:${start}`, match?.[2] ?? "");
}

export function readProcessIdentity(pid: number): ProcessIdentity | undefined {
	if (!Number.isInteger(pid) || pid <= 0) return undefined;
	return linuxProcessIdentity(pid) ?? psProcessIdentity(pid);
}

/** Boot time in epoch ms, read once per process: it cannot change while this process runs. */
let bootedAtCache: { value: number | undefined } | undefined;

function readBootedAt(): number | undefined {
	// Linux publishes the boot instant as `btime <seconds>` in /proc/stat.
	try {
		const seconds = /^btime\s+(\d+)$/m.exec(readFileSync("/proc/stat", "utf8"))?.[1];
		if (seconds) return Number(seconds) * 1000;
	} catch { /* not Linux, or /proc is not mounted */ }
	try {
		const out = execFileSync("sysctl", ["-n", "kern.boottime"], { encoding: "utf8", timeout: 3_000, stdio: ["ignore", "pipe", "ignore"] });
		const sec = /\bsec\s*=\s*(\d+)/.exec(out)?.[1];
		const usec = /\busec\s*=\s*(\d+)/.exec(out)?.[1];
		if (sec) return Number(sec) * 1000 + (usec ? Math.round(Number(usec) / 1000) : 0);
	} catch { /* not macOS, or sysctl is unavailable */ }
	return undefined;
}

export function bootedAtMs(): number | undefined {
	bootedAtCache ??= { value: readBootedAt() };
	return bootedAtCache.value;
}

/** A token that changes on every boot, so a recorded worker from another boot is provably gone. */
export function bootIdentity(): string | undefined {
	const at = bootedAtMs();
	return at === undefined ? undefined : `boot:${at}`;
}

/** The real host. Tests inject their own probe through the daemon/resume facts. */
export const systemProcessProbe: ProcessProbe = {
	alive: pidAlive,
	identity: readProcessIdentity,
	boot: bootIdentity,
	bootedAt: bootedAtMs,
	now: () => Date.now(),
};

/** Did the host boot after this instant (ISO)? Such a process cannot be running, whatever its pid now owns. */
export function bootedAfter(bootedAt: number | undefined, iso: string | undefined): boolean {
	if (bootedAt === undefined || !iso) return false;
	const at = Date.parse(iso);
	return Number.isFinite(at) && bootedAt > at;
}
