/** Entry point for the detached /claw daemon: `node --experimental-strip-types daemon-main.ts <workspace>`. */
import { HojaClient } from "./hoja.ts";
import { ternExec } from "./launcher.ts";
import { workerLaunchPlan } from "./launch-plan.ts";
import { ClawStore } from "./store.ts";
import { claimLock, pidAlive, releaseLock, runDaemon } from "./daemon.ts";

const workspace = process.argv[2];
if (!workspace) throw new Error("usage: daemon-main.ts <workspace>");
const store = ClawStore.forWorkspace(workspace);
const log = (line: string) => process.stderr.write(`${new Date().toISOString()} ${line}\n`);

if (!claimLock(store, pidAlive)) {
	log("another claw daemon owns the lock; exiting");
	process.exit(0);
}
const stop = () => { releaseLock(store); process.exit(0); };
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
process.on("exit", () => releaseLock(store));
log(`claw daemon ${process.pid} started for ${workspace}`);
runDaemon({
	store,
	hoja: new HojaClient(),
	tern: ternExec,
	workspace,
	now: () => new Date(),
	alive: pidAlive,
	signal: (pid, sig) => process.kill(pid, sig),
	planLaunch: (cwd) => workerLaunchPlan(cwd),
}, { log }).then(() => { log("claw daemon exiting"); process.exit(0); });
