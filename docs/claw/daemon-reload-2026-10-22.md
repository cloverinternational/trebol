# /reload refreshes the Claw daemon (2026-10-22)

The Claw supervisor is a detached singleton: it has to outlive the Pi session (triggers, inbox, Hoja outbox), but it
must not outlive its own code. After `/reload`, a branch switch or a merge, the extension around it is new while the
daemon keeps executing the sources it was started from. On 2026-10-22 that left PID 72176 (started 2026-10-21 16:00)
supervising runs after tab cleanup, transition-only notices, the launch timeout, `awaiting_decision` and worker
clarification had all been merged; killing it and starting a daemon from `main` (`ac2fd8a`) closed 28 stale terminal
tabs immediately. The code was right, only the process was old.

## The lifecycle event

Pi fires `session_shutdown` on the OLD extension instance before it loads the new code:

```
@earendil-works/pi-coding-agent dist/core/agent-session.js:2932  async reload(options) {
@earendil-works/pi-coding-agent dist/core/agent-session.js:2935    await emitSessionShutdownEvent(oldRunner, { type: "session_shutdown", reason: "reload" });
```

`SessionShutdownEvent.reason` is `quit | reload | new | resume | fork` (`dist/core/extensions/types.d.ts:617-622`), and
handlers are awaited before the old runner is invalidated (`dist/core/extensions/runner.js:813-837`). Trebol's handler
is `extensions/claw/extension.ts` (`registerOrchestrator`, the `session_shutdown` registration); on `reason: "reload"`
it compares the running supervisor's code with the code on disk and stops it when they differ. `quit`, `new`, `resume`
and `fork` deliberately leave the daemon detached — triggers must keep firing across a session change, and those paths
do not change the code. A branch switch in those paths is still caught by the other two checks below.

## The code fingerprint

`.pi/lib/claw/fingerprint.ts` defines it:

- `head`: `git rev-parse HEAD` of the checkout that holds `.pi/lib/claw` (`nogit` when that is not a work tree).
- `sources`: sha256 over every `*.ts` in `.pi/lib/claw`, relative path, byte length and bytes, sorted by path
  (`node_modules`, `dist`, `.git` skipped). This catches uncommitted edits to the same tree.
- `key`: `1:<head|nogit>:<sources>` — the single value written to `daemon.lock` as `fingerprint` and compared later.

The commit catches branch and merge changes; the source hash catches an edited or rewritten tree. It contains no
secret: a commit id and a digest of files already in this repository. When the library cannot be read the fingerprint
is *unknown*, which is never treated as a change.

## Who stops whom

| Where | Code | What it does |
| --- | --- | --- |
| `/reload` | `extensions/claw/extension.ts` `session_shutdown` → `refreshDaemon` | compares the lock's stamp with the code on disk; stops a stale/unstamped daemon. Starts nothing (`/claw on` or the next request does) |
| session start | `registerOrchestrator` `start()` → `refreshDaemon` | same comparison, so a daemon left by another session or an earlier branch is replaced before it supervises this session |
| every request | `orchestrator.ts` `request()` | only when the lock names a *live* daemon with a different stamp: stop it before the request is queued; if it cannot be stopped the caller gets an error instead of a queue nobody will answer |
| `/claw on` | `refreshDaemon` then `ensure` | replaces a stale daemon, then starts one from the current code |
| the daemon itself | `daemon.ts` `runDaemon({ codeKey })`, `daemon-main.ts` | re-checks every `CODE_CHECK_MS` (10 s) and exits with `stale-code`, releasing the lock, when the code on disk no longer matches its own stamp |

`stopDaemon` (`lifecycle.ts`) is the only place that signals a process. It reads `daemon.lock`, and then:

- no lock, or no pid: nothing to stop (`absent`).
- pid not alive: a lock left by a killed daemon — removed so the next start claims the singleton (`stale-lock-taken`).
  This is the lock-takeover case; nothing is signalled.
- pid is this process, or a pid recorded as a run's worker: refused. A worker is never signalled.
- `ps -p <pid> -o command=` does not mention `daemon-main`: a recycled pid. The stale lock is removed and nothing is
  signalled. If the command cannot be read at all, the pid is left alone and reported — never killed on a guess.
- otherwise SIGTERM, wait up to 2 s (`STOP_WAIT_MS`), escalate to SIGKILL only if the process ignored it, wait 1 s
  (`KILL_WAIT_MS`). A process that survives both is reported as `failed` with a reason that says it runs older code
  until it is stopped by hand; nothing silently pretends success.

## What is preserved

- **Workers keep running.** Only the supervisor's pid is signalled. Worker tabs and worker pids are untouched, and their
  runs stay `running`; the next daemon reads `runs/<id>.json` plus the events file offset and reconciles them (a settle
  becomes `idle`, a dead worker becomes `lost` — exactly as for any other daemon restart).
- **No double daemons.** `claimLock` is still an exclusive create that reclaims a dead owner's lock; `ensureDaemon` will
  not start a second process beside a live stale one, and a process that loses the claim exits with
  `another claw daemon owns the lock`.
- **Nothing queued for a daemon that must die.** `request()` performs the comparison before writing the request file,
  and throws a clear error when the stale daemon cannot be stopped. On the normal path (no daemon, or a current one)
  the request file is still written synchronously, so the caller's durable handle is never delayed.
- **Failures are visible.** `statusSummary().daemon` reports `{ pid, startedAt, code: current|stale|unstamped|unknown,
  note }`; a stop or start failure also goes to the session (`ui.notify`) and to the store inbox as an `error` item.

## Tests

`.pi/test/claw/daemon-reload.test.ts` (29 tests):

fingerprint — source hash follows library bytes only; a commit change and an uncommitted edit both change the key;
unreadable tree is `unknown`, not a change; current/stale/unstamped comparison; the shipped library fingerprints
itself. Lock — `claimLock` stamps the key, `heartbeat` keeps it; a daemon started while the tree was unreadable stamps
nothing. Shutdown — SIGTERM stop; SIGKILL escalation only after a timeout; a daemon surviving both is reported; no lock;
a lock from a killed process is taken over without a signal; a worker pid is never signalled even if the lock names it;
a recycled pid is not signalled and its lock is removed; an unverifiable pid is left alone. Refresh — same code means
no signal and no restart; stale is stopped, and restarted only when asked; unstamped counts as older code; an
unreadable tree never signals; a daemon that cannot be stopped blocks the caller (`request` rejects); a dead lock is
cleared before a start; `ensureDaemon` does not start a second daemon beside a stale one. Self-check — the loop exits
`stale-code`, releases the lock and a new daemon claims the new code; an unchanged fingerprint keeps it serving;
unreadable code keeps it serving. Reconciliation — restarting the supervisor signals only the daemon, leaves the worker
alive, and the run reconciles from persisted state instead of becoming `lost`. Hook — a real child process whose
command line carries `daemon-main` is stopped by `session_shutdown {reason:"reload"}` when its stamp is old, left alone
when its stamp is current, and left alone on `quit`.

## Live check

Run on 2026-10-22 against a copy of the library in `/tmp/claw-live-323` (so the checkout itself was not edited) with a
scratch workspace `/tmp/claw-live-ws-323`. Real `node --experimental-strip-types .pi/lib/claw/daemon-main.ts`, real
`daemon.lock`, real source change:

```
STAMP-1 {"pid":3128,…,"fingerprint":"1:nogit:7736061464d2ad1f68fec992297183a27e97767cfee2df421e34ed1009047e45"}
changed store.ts at 17:21:18
17:21:18.017Z claw daemon 3128 started for /tmp/claw-live-ws-323 at code 1:nogit:7736061464…45
17:21:28.141Z code changed under this daemon (the running daemon was started from different code); exiting so a daemon from the current code takes over
17:21:28.141Z claw daemon exiting (stale-code)
lock after exit: absent (released)      old daemon gone
STAMP-2 {"pid":15270,…,"fingerprint":"1:nogit:c9450098c98440473f50e8aeaca9a9fe809a76620c84640498c6fab9a50f7df7"}
17:21:38.918Z claw daemon 15270 started for /tmp/claw-live-ws-323 at code 1:nogit:c9450098…f7
SIGTERM -> process exits, lock released
```

The same takeover is covered hermetically by `.pi/test/claw/daemon-reload.test.ts` ("the real daemon entry point"),
which spawns the real `daemon-main.ts` against a copied tree and asserts the stamp, the `stale-code` exit, the released
lock and the new stamp of the daemon that follows.
