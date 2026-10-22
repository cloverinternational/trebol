/** Entry point for the detached /claw daemon: `node --experimental-strip-types daemon-main.ts <workspace>`. */
import { HojaClient } from "./hoja.ts";
import { computeClawFingerprint } from "./fingerprint.ts";
import { ternExec } from "./launcher.ts";
import { workerLaunchPlan } from "./launch-plan.ts";
import { ClawStore } from "./store.ts";
import { claimLock, pidAlive, releaseLock, runDaemon } from "./daemon.ts";

const workspace = process.argv[2];
if (!workspace) throw new Error("usage: daemon-main.ts <workspace>");
const store = ClawStore.forWorkspace(workspace);
const log = (line: string) => process.stderr.write(`${new Date().toISOString()} ${line}\n`);

// The code this process runs is stamped in the lock, and the loop stops as soon as the code on disk differs: a reload,
// a branch switch or a merge can never leave a stale supervisor running.
const stamp = computeClawFingerprint();
if (!stamp) log("warning: the Claw sources cannot be fingerprinted; this daemon cannot prove it is current, so it will not restart itself on a code change");
if (!claimLock(store, pidAlive, stamp?.key)) {
	log("another claw daemon owns the lock; exiting");
	process.exit(0);
}
const stop = () => { releaseLock(store); process.exit(0); };
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
process.on("exit", () => releaseLock(store));
log(`claw daemon ${process.pid} started for ${workspace}${stamp ? ` at code ${stamp.key}` : ""}`);
runDaemon({
	store,
	hoja: new HojaClient(),
	tern: ternExec,
	workspace,
	now: () => new Date(),
	alive: pidAlive,
	signal: (pid, sig) => process.kill(pid, sig),
	planLaunch: (cwd) => workerLaunchPlan(cwd),
}, { log, codeKey: () => computeClawFingerprint()?.key }).then((reason) => { log(`claw daemon exiting (${reason})`); process.exit(0); });
