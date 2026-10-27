# /claw v1

Orchestrator in one Pi session; each worker is a visible Tern tab running pi on one task, with one Hoja issue.
Code: `.pi/lib/claw/` (store, spawn lifecycle, daemon, Hoja client, Tern launcher, worker helpers),
`extensions/claw/` (orchestrator tools + `/claw`; worker gate + `claw_finish` when `PI_CLAW_RUN` is set).
Tests: `.pi/test/claw/claw.test.ts` (lifecycle, daemon, Hoja, Tern, worker) and
`.pi/test/claw/clarification.test.ts` (worker-local questions), `.pi/test/claw/keep-open-resume.test.ts` (keep-open and
resume, including the goal generation a resume restores).

## Commands and tools

- `/claw on` — start the singleton daemon if absent; register this session's own inbox cursor (see *Several Claw sessions on one workspace*); rename the tab that holds this pane (`TERN_PANE`) to `Claw`. Only that block's tab is renamed, only after Tern confirms the pane is live and the name sticks. Refusal, a missing pane, or an absent Tern is reported as a warning; Claw stays on. The pane is recorded so worker tabs open in its session. It also switches this session's routing (below).
- Routing while on (`.pi/lib/claw/mode.ts`): the single `Agent` tool routes to Claw spawn (`project` required). `Subagent`, `BackgroundTask`, `Delegate`, `DelegateOutput`, `SubagentOutput`, `TaskOutput`, `AgentControl`, `wait_for_agent`, `multi_agent_wait` are removed from the active set and refused at `tool_call`. Orchestrator tools (`claw_spawn|list|read|send|cancel|trigger`) are active only while on. Off restores the prior active set captured at `/claw on`; a session shutdown restores it too and does not change the store control (triggers keep firing).
- Worker launch is plain terminal pi: the command sets `PI_TERN_UI=0` (the documented bypass of the Tern shell dispatch, `docs/reference/tern-pi-shell-dispatch.md`). Normal tools stay enabled; `-nt` is not used.
- `/claw off` — suspend triggers and new runs. Running workers keep running and are still reconciled.
- Per-chat mode: `/claw on|off` persists `claw-mode` in the session transcript; `/reload`, resume and restart restore the chat's own mode (routing and inbox ownership only, no daemon start, tab rename or store change). A new chat starts off. See `docs/claw/reload-persistence-2026-10-21.md`.
- `/claw status` — control state, daemon pid, run counts, pending Hoja syncs, triggers.
- `claw_spawn`, `claw_list`, `claw_read`, `claw_send`, `claw_cancel`, `claw_trigger` (add|list|remove).
- `claw_set_keep {run_id, keep}`, `claw_close {run_id}`, `claw_resume {run_id}` — keep a finished run's tab open,
  release or close it, and relaunch a worker into the run's recorded session. See
  [Keep open and resume](#keep-open-and-resume-2026-10-22).
- Worker only: `claw_finish {outcome: completed|failed|needs_user, summary, evidence[]}` (clears the completion goal
  first); `claw_goal {action: status|widen, criteria?}` reads or widens the goal. `completed` needs evidence.

## Status model

| Status | Meaning |
| --- | --- |
| launching | run persisted; Hoja issue / tab in progress |
| running | worker reported `started` |
| idle | native turn settled with no `claw_finish`. Not a result; may be awaiting input or a permission |
| awaiting_decision | the worker opened its own `ask_user_question` modal in its tab and the turn is suspended until a human answers or cancels there. Active, not a result |
| awaiting_user | worker reported `needs_user` |
| completed | `claw_finish completed` with evidence; Hoja moves to In Review |
| failed | `claw_finish failed`, launch failure (gate refusal, tab-open failure, timeout), or completion refused for missing evidence |
| failed (startup) | worker died before `session_start`; the reason comes from the worker's captured stderr, plus the source checkout it ran from |
| lost | worker had reported `started` (or a settle) and its process/tab then vanished without `claw_finish` |
| cancelled | stopped by `claw_cancel` |

Hoja Done is never set automatically. `agent_settled` is never treated as success.
Every terminal run's tab is closed on the terminal tick **unless** the run was spawned with `keepOpen`
(see [Keep open and resume](#keep-open-and-resume-2026-10-22)); a run whose tab is gone can be brought back with
`claw_resume` on its recorded session.

## Extension loading for workers (duplicate registration)

Pi resolves package sources and the cwd-local project package by lexical path, so one repository
registered twice - as a configured package (`~/.pi/agent/settings.json`) and again by the checkout
the worker starts in (`.pi/settings.json` `packages: [".."]`) - loads every extension twice and pi
exits with `Tool "X" conflicts with <other copy>` for every tool. A linked worktree has its own
path, so the two registrations never match.

`.pi/lib/claw/launch-plan.ts` names a repository by real identity (the shared git common dir, or
the realpath outside git) and, when two sources name the same repository, launches the worker with
an explicit extension list (`pi -ne -e <file> ... -e builtin:<name>`) built from the kept sources.
The checkout the worker runs in wins, so a worker tests the branch it was started in; the other
copy is skipped and named in `launchNote` (`claw_list`, `claw_read`, `claw_status`). Distinct
repositories keep their own extensions, and nothing changes when there is no duplicate. If a
source cannot be enumerated as local extension files (npm/git sources, glob filters), the plan
falls back to `--no-approve`, which suppresses the project-local copy only.

A conflict between two *different* repositories is not deduplicated. Pi reports it, the worker
dies before `session_start`, and the run is recorded `failed` with that line instead of `lost`.
Worker stderr is captured to `.swarm/claw/runs/<run>.worker.log` for that reason.

## Completion goal (always on)

Every run is spawned under a completion goal. It is not opt-in and it has **no turn cap, no deadline and no expiry**
(`GOAL_LONG_MS` is a warning threshold, never a deadline). While the goal is active the worker's own judge loop keeps
continuing on NOT_MET; nothing in Claw limits the number of turns.

- **Derived and recorded.** `deriveGoal` (`.pi/lib/claw/goal.ts`) turns the task into a condition: the objective plus
  the acceptance criteria the task states (bullets and requirement sentences, at most 8, bounded well under the goal
  command's 4000-character limit). It is written to `run.goal` at spawn — before any side effect, so it is auditable even
  when the launch fails — and to `runs/<run>.goal.json` when the task file is written. A task with no objective derives
  nothing and the run is recorded `unavailable` instead of guessing.
- **Established after launch, never through the prompt.** The launch prompt stays
  `Read and execute your Claw task file in full: …`. A positional prompt beginning with `/` is dispatched by Pi as a
  command, not as a turn, so the goal never rides it. The worker extension reads the spec and establishes it on the goal
  host at `before_agent_start`, in the worker's own process. Pi gives every extension its own API object *and* its own
  module instance (measured), so the host is published on a process-global symbol keyed by session id
  (`Symbol.for("pi-swarm-goal-hosts")`), not in module state.
- **Idempotent, restart-safe.** Establishment is keyed by the run's generation source (`claw:<runId>`, then
  `claw:<runId>:g<n>` after a resume). A worker restart inside one generation restores the persisted goal from its own
  transcript and leaves it alone; a goal that already ended for that source is never re-armed by a restart, and a daemon
  restart reads `run.goal` back from the run record without duplicating anything. Ending a goal removes its spec file, so
  nothing can re-establish that generation after the fact. A **deliberate** `claw_resume` is the one way a goal is armed
  again: the daemon writes the spec for the next generation (`rearmGoal`, once per resume) before the tab opens — see
  [Keep open and resume](#keep-open-and-resume-2026-10-22).
- **Semantic brakes, each exactly once.** MET, IMPOSSIBLE, `claw_finish`, cancellation, the worker's own question
  (`awaiting_decision`) and any terminal run state. `claw_finish` clears the goal *before* recording the report, so the
  settle that follows that turn performs **zero** further judge calls (the measured zombie-loop defect). The daemon ends
  the goal once (`endGoal` is idempotent) and withdraws the spec; a late or duplicate goal event cannot reopen it.
- **Widening only.** `claw_goal {action: status|widen}` reads the condition and appends acceptance criteria. There is no
  worker-side way to shorten, clear or replace the goal; a human can still use `/goal` in the worker's tab.
- **Observability.** `run.goal` (and therefore `claw_read`), `claw_list`, `claw_spawn`/`claw_cancel` responses and
  `/claw status` (`goals[]`) expose the condition, turns used, judge calls, last verdict, elapsed seconds, end reason and
  whether the long-run warning fired. When a goal has run `GOAL_LONG_MS` (1 h) the daemon appends ONE `run_goal_long`
  inbox notice and never stops the run.
- **Judge bounds unchanged.** Per settlement the judge still has 8 tool turns and an 8 MiB transcript cap
  (`MAX_VERDICT_TOOL_TURNS`, `MAX_TRANSCRIPT_BYTES` in `.pi/lib/tools/swarm-goal.ts`); the *goal* has no bound.
- **Supervisor interaction.** The supervisor's bound-to-terminal SLOs (`superviseIdle`: nudge, then fail after
  `idleFailMs`) apply to `idle` runs. A worker inside an active goal loop does not settle — the settle is turned into
  the next turn — so the run stays `running` and that bound does not apply to it, which is what "no deadline" means here.
  When a goal ends (MET, IMPOSSIBLE, a report, a question or a terminal state) the run behaves normally again and the
  ordinary SLOs resume.

Tests: `.pi/test/claw/goal.test.ts` (derivation, recording, the loop, every brake, restart, near-misses),
`.pi/test/tools/swarm-goal.test.ts` (host API, session lookup, observer), mutation checks in
`tools/verify/claw-goal-mutations.mjs` (20 guards), live demonstration in `tools/e2e/claw-goal-always.mjs` (real `pi`,
real extensions, a harmless `/tmp` condition).

## Keep open and resume (2026-10-22)

Two per-run ways to keep working with an agent after its run ends. Both default to **off**: with no option, a terminal
run's tab is closed on the terminal tick exactly as before (SLO S2). Code: `.pi/lib/claw/resume.ts` (resume + the
read-only reachability answer), `.pi/lib/claw/supervisor.ts` (the single close point), `.pi/lib/claw/goal.ts`
(`rearmGoal`), `.pi/lib/claw/launcher.ts` (`--session`), `extensions/claw/extension.ts` (tools + `Agent` schema).

### API

| Surface | Shape |
| --- | --- |
| `claw_spawn` | `{task, project, assignee?, label?, cwd?, provider?, model?, keepOpen?: boolean}` |
| `Agent` (while Claw is on) | same fields, `keepOpen` included in the overlaid schema |
| `claw_set_keep` | `{run_id, keep: boolean}` — `keep=false` releases it so the next tick closes the tab |
| `claw_close` | `{run_id}` — close the tab now and release the keep |
| `claw_resume` | `{run_id}` — relaunch the worker into the run's recorded session |

Every one returns the run summary, which now carries `keepOpen`, `sessionFile`, `resumeCount`, `lastResumeAt` and
`resumeError`. New request kinds (`keep`, `close`, `resume`) go through the same durable request/response files as the
rest, so a client timeout cannot leave a resume half-applied.

### Keep open

- **Persisted, not remembered.** `keepOpen` is written on the run (`run.keepOpen`) at spawn, before any side effect. The
  supervisor is the only thing that closes a worker tab, and `superviseTabClose` returns immediately for a kept run, so
  neither a daemon restart nor any number of ticks can close it: the decision is read back from the store every tick.
- **Only the close is skipped.** Events, the goal, the outbox and the dead-worker checks keep being reconciled; a kept
  run is a normal run whose tab stays.
- **Not supervision work.** `supervisionPending` ignores a kept tab, so the daemon may idle-exit while a human keeps
  using it; the next Claw call starts a daemon that reads the same record.
- **Release.** `claw_close` closes now and releases; `claw_set_keep keep=false` releases so the next tick closes. Both
  clear an exhausted `tab-close` remedy, otherwise a budget spent by an earlier failed close would silently block it.
- **Visible.** `claw_list` rows gain `keepOpen`, `resumable` and `reachability` (why not); `/claw status` gains
  `keptOpen[]` and `resumable[]`; `claw_read` returns the raw run record.

### Resume

`claw_resume <run_id>` relaunches the run's worker tab on the session file the worker recorded in its `started` event.
Same run, same Hoja issue, same conversation: no second issue, no duplicate run, and the task prompt is **not** re-sent
(re-sending it would execute the task twice).

- **pi flags, read from the installed CLI, not guessed.** `pi --help` documents `--session <path|id>  Use specific
  session file or partial UUID`; the installed `dist/main.js` resolves an argument containing `/` to a path and calls
  `SessionManager.open(path)`, which appends to that file instead of starting a new session. `workerCommand` therefore
  renders `pi --name '<label>' --session '<absolute sessionFile>'` and omits the positional prompt for a resume.
  Everything else (`PI_TERN_UI=0`, `PI_CLAW_RUN`, `PI_CLAW_DIR`, the extension plan, the stderr capture) is unchanged.
- **Works for** a dead worker (`lost`), a tab already closed (`tabClosedAt`), a completed run, and after a daemon
  restart: the whole resume is derived from the persisted run record, and it clears the stale `pid` before the tab opens
  so the supervisor cannot read the fresh tab as a corpse.
- **Refused, with the next step in the message:** a run whose worker is alive (pid or live block — use `claw_send`),
  an active run whose worker cannot be *proven* gone (an unreadable Tern snapshot is not evidence of death), a resume
  already in flight (`resumingAt` within 120 s), a missing `sessionFile` or missing file on disk (relaunch with
  `claw_spawn` and the same task), a run whose Hoja issue no longer exists, and a run whose resume budget is spent.
- **Budgeted.** Every failed resume records one attempt in the same remedy ledger as every other bounded act
  (`resume`, 3 attempts, jittered backoff). The attempt that spends it marks it `exhausted`, records `resumeError`, and
  appends one `run_budget_spent` with the reason; a further `claw_resume` is refused without touching Tern.
- **Visible.** A successful resume appends a normal `resumed` run event (the same kind a worker appends when it
  continues after a report), so the daemon emits the usual `run_resumed` inbox item; the run's `resumeCount` and
  `lastResumeAt` are on the record, and a Hoja comment says the tab was resumed.
- **A failed resume changes nothing else.** The run goes back to its prior status with `resumeError` set; the close,
  the Hoja outbox and the goal are left exactly as they were.

### Interaction with the always-on goal

| Situation | What happens |
| --- | --- |
| A kept-open run reaches a terminal state | The goal ends exactly as it does for any run (`endGoal` + spec withdrawn), and no judge call is owed. Keeping the tab **never** re-arms, extends or pauses a goal: the tab is a conversation a human can still use, not a live loop. |
| A kept-open run's goal ended while the worker was still alive | Unchanged from v1: the worker keeps its own turn; use `claw_send` or `claw_cancel`. Keep-open only decides whether the tab survives the terminal tick. |
| `claw_resume` on a run with a goal | The persisted goal is armed again as the **next generation** of the *same* goal (`rearmGoal`): same condition and criteria, one run record, the ended generation appended to `goal.history`, `goal.generations` +1, and exactly one spec written (`runs/<run>.goal.json`) before the tab opens. The daemon marks it `pending`; the worker's own `established` event makes it `active` again in its new process. |
| Why a new source and not the same one | The goal extension refuses to re-arm a source that already ended (its tombstone). That rule is what stops a *restart* from resurrecting a finished loop; a deliberate resume must therefore be a new owner, `claw:<runId>:g<n>`, recorded on the run so nothing duplicates or forks it. |
| A resume that fails | The re-arm is rolled back (generation, history, status) and the spec is withdrawn, so a generation that never ran is never recorded as if it had. |
| A run whose task derived no goal (`unavailable`) | A resume never invents a condition; the run stays `unavailable` and relies on its own `claw_finish` report. |


## Worker-local clarification

A worker asks its own questions. The worker tab is plain terminal pi (`PI_TERN_UI=0`), so `ask_user_question` renders
its native modal in that block: the user answers in the worker's tab, the answer returns to the worker as the tool
result, and the same run continues. The orchestrator never relays an answer and no second run is created.

- The worker appends `ask` events (opened / answered / cancelled) taken from the pi-ask lifecycle events of its own
  process (`@eko24ive/pi-ask:started`, `@eko24ive/pi-ask:completed`). Only the flow id, the title and the question ids
  are recorded; answer content never reaches the run store.
- The daemon maps an open modal to `awaiting_decision` and back to `running` when it resolves. It is deliberately
  distinct from `awaiting_user`, which stays reserved for the reported `needs_user` outcome.
- `claw_send` is refused while a modal is open: typing text into a dialog would answer or corrupt it on the user's
  behalf. The refusal runs before the `awaiting_user` reactivation path, so input is never typed into a live dialog.
  A question that stays open is reminded once after 30 minutes (`ASK_STALE_MS`) and the run stays active; if the worker
  process disappears, the run becomes `lost` and its question is marked `unresolved`.
- `needs_user` fallback: if the modal is cancelled, unavailable (no native TUI, ask-user extension absent) or the
  worker cannot ask, the worker still calls `claw_finish needs_user` with a summary that states the exact question, the
  options and what each answer would change. If it instead ends the turn silently, the run goes to `idle` with a note
  that its question was cancelled and no completion is implied. The daemon never fabricates a question from a summary.
- Legacy `awaiting_user` runs (reported before this change) keep their report. The user answers in the worker's tab, or
  `claw_send` reactivates the run when its tab is still live; either way the same process starts a new turn (a
  `resumed` event) and a later `claw_finish` supersedes the earlier report.

Details and event shapes: `docs/claw/worker-clarification-2026-10-22.md`.

Cancel maps the Hoja issue to `Canceled` only when the worker pid is gone and its tab is not live (verified). Otherwise the Hoja state is left unchanged and the comment says so. See `docs/claw/acceptance-2026-10-21.md`.

## Launch gate

A worker is a plain `pi` process whose first act is loading the extension source under its `cwd`. Two source hazards
reach it before any run event can exist; `.pi/lib/claw/preflight.ts` decides both before a tab opens. (Extension
*duplication* is a different hazard, handled by the launch plan above; both can produce the same `pi` startup exit.)

- **Source load precheck.** The gate reads the `pi.extensions` entry points of the pi package at or above the worker's
  `cwd`, parses each of them with the TypeScript parser (syntax only, no type check) and follows local relative imports
  transitively (cap 2 000 files). A failure is reported the way pi reports it — `ParseError: <relative path>:<line>:<col>
  <diagnostic>` — so a failed run names the file a human has to fix. Cost on this repository: 59 entry points, 324 files,
  ~0.4 s cold and ~0.2 s warm (parse results are cached by path, mtime and size). A `cwd` with no pi package is **not** a
  failure: the gate records a warning that it cannot inspect the installed extensions, and launches.
- **Bounded retry with backoff and jitter.** Only transient failures are retried: parse/syntax errors, missing or
  renaming files (`ENOENT`, `EBUSY`), and tool/extension conflicts (`already registered`, `conflicts with`). Four
  attempts (one try plus three retries), delay `200 ms * 2^(n-1)` scaled by a random factor in [0.65, 1.35) and capped
  at 2 s — ~2.3 s in total on the real repository. The last real error is kept verbatim in `run.error` and the Hoja
  comment, with the attempt count; the Hoja issue stays `In Progress` and no tab is opened.
- **Deterministic configuration errors are not retried.** `unknown provider`, `provider is not configured`, invalid API
  key/credentials, invalid config or `settings.json`, project trust and `EACCES`/`EPERM` fail on the first attempt. An
  unrecognised message is retried inside the same bounded budget, so a slow write is still rescued and a
  misconfiguration still surfaces within ~2 s.
- **Checkout identity.** Run creation records the launch checkout's `HEAD`, branch and a SHA-256 fingerprint of
  `git diff HEAD` (tracked changes only) in `run.source`. At launch the same checkout is compared with that snapshot and
  the launch is **refused** — fail-fast, not a copy — when `HEAD` or the branch moved, or when the fingerprint changed
  (including a second edit of an already-dirty file). The error names the checkout, branch and commit, so the operator
  sees which tree is dirty or stranded. A checkout already dirty at creation is deliberate state: it is allowed and
  reported in `launchWarning`. Snapshotting the tree was rejected as the alternative: copying a pi package (node_modules
  included) is expensive and is not the tree the orchestrator verified.
- `claw_read` reports `source`, `launchAttempts` and `launchWarning`, so a gate refusal stays diagnosable afterwards.
- A run that dies **before writing any event** is `failed (startup)` by the daemon with the line from its captured
  stderr (`.swarm/claw/runs/<run>.worker.log`), and now also names the source checkout it was launched from, so a
  `ParseError` or a `Tool "X" conflicts with` line and the tree that produced it are in the same message.

The gate is a parse check, not a full load: `npm run check:install` (isolated `DefaultResourceLoader`, no session, no
model) remains the deeper manual check for registration-time failures such as a duplicate tool.

## Several Claw sessions on one workspace (2026-10-27)

Several orchestrator sessions may run Claw in the same workspace (for example two Tern windows on one machine). Each
session keeps its own runs:

| State | Scope | Where |
| --- | --- | --- |
| Run owner (`run.owner`) and Tern pane (`run.pane`) | per run | stamped by the calling session on `spawn` and on a trigger's spawn action (`stampOrigin` in `extensions/claw/extension.ts`) |
| Inbox cursor | per session | `.swarm/claw/sessions/<session>.json`; `registerSession` in `.pi/lib/claw/store.ts` |
| Inbox item address (`item.owner`) | per item | `appendInbox` copies the owner of the item's run or trigger |
| Digest | per session | `flushDigest` writes one `claw_digest` per owner |
| Daemon, lock, triggers, control (on/off) | per workspace | unchanged: one supervisor serves every session |

- A session receives the items addressed to it plus unaddressed ones (daemon errors, heartbeats, runs from before
  owners existed). Another session's items are skipped, so `/claw on` or any `claw_*` call in one session never takes
  another session's completions. Before this change the last session to act received everything.
- A run's worker tab opens in the Tern session that holds `run.pane`, not the pane recorded by the latest `/claw on`.
  `claw_resume` uses the same pane. A run without a pane (older runs) falls back to `control.json` as before.
- A new session starts reading at the current inbox end, so it never replays history. The same session reopened in a
  new process (`pi --session`, Tern pane reopen, `/reload`) keeps its cursor and resends an undelivered batch at once.
- Migration: the old single cursor (`orchestrator.json`) is handed over once, to the session it named, or to the first
  session that registers when its owner process is gone. `migratedTo` records the handover.
- Known limit: a run belongs to the session id that started it. If that chat is never reopened, its completions stay
  in `inbox.jsonl` and remain visible in `claw_list` (`owner` column) and `claw_read`, but no other session is woken.
- Evidence: `.pi/test/claw/multi-orchestrator.test.ts` (fails on 0.8.0 with the field symptom), `tools/e2e/claw-two-orchestrators.mjs`
  (two OS processes on one store), and 11 `session-*` mutations in `tools/claw/mutation-check.mjs`.

## Durability

- One daemon per workspace (`.swarm/claw/daemon.lock`, pid-checked; a dead owner is reclaimed). Started detached via
  `node --experimental-strip-types daemon-main.ts`; logs to `.swarm/claw/daemon.log`. Exits after 120 s with no active
  run, enabled trigger or pending request; the next client request restarts it.
- The daemon also refuses to outlive its own code: it stamps a code fingerprint (`git rev-parse HEAD` plus a sha256 of
  `.pi/lib/claw` sources) in `daemon.lock`, re-checks it every 10 s and exits when the code on disk changes; `/reload`
  stops a daemon whose stamp differs on the old extension instance, and `/claw on` / the next request replace it. Only
  the supervisor is signalled — workers keep running in their tabs and their runs reconcile from the store. See
  `docs/claw/daemon-reload-2026-10-22.md`.
- Single writer: only the daemon writes `runs/` and `triggers/`. Clients write `requests/`; the daemon writes `responses/`.
  A response file marks a request served, so replays are no-ops.
- Launch phases `intent -> issue_created -> tab_opening -> tab_open` are persisted before side effects.
  The launch gate runs in `issue_created`, before a tab exists, so a retry there can never create a second tab.
  Restart reconciles `intent` by Hoja marker (`<!-- claw-run:ID -->`) before creating an issue. `tab_opening` is ambiguous
  and is reported failed, never retried.
- Triggers fire with a key (`trg@scheduled-time` or `trg@run`); runs and inbox items dedupe on it.
- Hoja writes go through an outbox with read-back; each comment carries `<!-- claw-op:ID -->` and is skipped if already visible.
- Inbox (`inbox.jsonl`) is durable; each registered session delivers its own unread items on start and every 3 s.

## Self-supervision (2026-10-22)

The daemon enforces written SLOs and acts on them, so a human does not have to prompt check-ups. Full detail,
evidence and before/after numbers: `docs/claw/slo-2026-10-22.md`. Code: `.pi/lib/claw/supervisor.ts`,
`.pi/lib/claw/remedy.ts`.

| SLO | Enforced by |
| --- | --- |
| Every run reaches a terminal state within a bound, or fails with a real reason | launch bound 300 s; idle stall report at 600 s; supervisor fail at 3600 s (`claw_send` resets the clock) |
| Every terminal run's tab is closed | close on the terminal tick, 5 jittered retries, one `run_tab_orphan` naming `tern close <block>`; **not** gated on the Tern snapshot; `lost` included. A run spawned with `keepOpen` is the explicit exception (S7) |
| Each act happens at most once per run per state | `remedies["<action>:<state>"]` ledger with attempts, jittered `nextAt`, budget, `exhausted` |
| Silence means healthy | `run_started`/`run_idle` become notices folded into one `claw_digest` per 300 s; one `claw_heartbeat` per 1800 s while a worker runs |
| A pending decision is surfaced, not idled on | `awaitingSince`, tab renamed `! <id> decide`, bounded reminders (3 over 30 min each), answer with `claw_send` |
| Recoverable faults are recovered | one relaunch of a launch failure with no tab, **or of a `lost` worker that never settled a turn** (same run, same Hoja issue, no second create); a run past its own deadline is never restarted and records `run_budget_spent` with the reason; paced Hoja lookups |

Store additions: `notices.jsonl` (low-severity notices awaiting a digest), `supervisor.json` (digest cursor, digest and
heartbeat counters), and per-run `idleSince`, `stalledAt`, `awaitingSince`, `failureClass`, `remedies`,
`relaunchCount`, `tabMissingAt`. Bounds are overridable per workspace in `control.json` → `supervise` (validated; a bad
value falls back to the default).

New inbox kinds: `run_stalled`, `run_tab_orphan`, `run_recovered`, `run_budget_spent`, `claw_digest`, `claw_heartbeat`. A spent budget is a record, not a retry: `remedies[<act>]` keeps `{attempts, exhausted, note}` and one item names the act, the reason and the next human step.

Operator tooling: `tools/claw/metrics.mjs` (the five supervision metrics for any store),
`tools/claw/build-fixture-store.mjs` (a store rebuilt from the committed 2026-10-22 fixtures),
`tools/claw/replay-supervisor.mjs` (runs the real tick loop over it), `tools/claw/mutation-check.mjs` (proves each fix's
test fails when the fix is reverted).

## Live E2E (2026-10-21)

See `docs/claw/e2e-evidence-2026-10-21.md` for run, Hoja, trigger and session IDs. Covered live: Agent routing, named tab, Hoja readback, worker finish, In Review, inbox delivery, durable `at` trigger fired detached, reconnect with one delivery, and `/claw off`.

## Limitations (v1)

- Permission waits are not detectable from native signals; they appear as `idle`. Worker questions are the exception:
  they are reported by the worker itself and appear as `awaiting_decision`.
- Worker-local clarification depends on the worker running native Pi UI (`PI_TERN_UI=0`, which the launcher sets). If a
  worker runs under the Tern TSP frontend (unbound extension UI, no local ask bridge) or the ask-user extension is not
  installed, no modal opens; the worker falls back to `claw_finish needs_user` and the run reaches `awaiting_user` with
  no `ask` record. Nothing is invented in that case.
- An open question keeps the run active, so the daemon does not idle-exit while a human is deciding. Cancelling the run
  (`claw_cancel`) is the way to abandon an unanswered question.
- PID liveness is `kill(pid, 0)` without start-time checks; pid reuse is theoretically possible.
- Tab naming: `/claw on` renames the pane's tab; outside Tern (`TERN_PANE` unset) or when Tern refuses, the warning says to name it `Claw` manually. Worker tabs whose rename fails are reported with `tabWarning` in `claw_read`.
- Marker lookup uses the Hoja description filter (exact). A create that commits after the lookup can still produce a duplicate; not closed (see acceptance doc).
- Inbox delivery is at-least-once in the crash window after persistence, and can drop an item in the dispatch-to-persist window. Exactly-once is not claimed.
- A timed-out `claw_spawn` may still start a run; check `claw_list` before retrying.
- Worker depth 1 is enforced by a `tool_call` block list (`WORKER_BLOCKED_TOOLS`); normal approval gates are unchanged.
- The completion goal is judged by the worker's own provider. A judge provider error is a brake: the goal ends with
  status `error` (one notice), no further judge call is made, and the run keeps its own turn and still needs a truthful
  `claw_finish`. A goal that is never MET and is never reported keeps running by design: use `claw_cancel` to stop it.
- The launch gate parses syntax only: a source that parses but fails while registering (a duplicate tool, a throw inside
  an extension factory) is still discovered by the worker, not by the gate. `npm run check:install` covers that case
  manually. Parse results are cached per process by path, mtime and size; a file rewritten within the same mtime tick and
  with an unchanged size is not re-parsed, but its git fingerprint still changes, so the checkout check refuses it.
- Checkout drift is judged against `git diff HEAD` for **tracked** files; untracked files added between create and launch
  are not a refusal (a fresh file cannot be mid-write in a way the parse gate misses for an already-registered entry
  point, and workers create untracked files by design).

## Verification log (2026-10-21, isolated scratch store)

Verified live (real Tern, real pi worker, real Hoja; scratch store `/tmp/claw-live`, daemon started through `ensureDaemon`):
- Spawn: Hoja `TREBOL-266` created in team TREBOL, project Hoja, assignee Luis; read-back matched; worker tab `claw-smoke` opened and named.
- Worker completion: `claw_finish completed` with evidence (`date -u` output) -> run `completed`; Hoja comment and state `In Review` applied (never Done). A transient Hoja error was retried by the daemon and cleared.
- Cancel: `TREBOL-265` run cancelled, worker signalled, tab closed, cancel comment flushed. Its Hoja issue is still In Progress (needs a human decision).
- Durable `at` trigger (notify): fired with no orchestrator attached (`trigger_fired`, `notify` in `inbox.jsonl`).
- Tab rename: `nameClawTab` renamed a throwaway Tern tab to `Claw` and confirmed it; the tab was closed afterwards.

Found and fixed during the run:
- Worker and orchestrator claw tools were hidden by the model-surface gate (`swarmSurfaceFor`); the worker never saw `claw_finish`. Fixed with `CLAW_TOOLS` in `.pi/lib/runtime/swarm-tool-gating.ts`.
- A settled turn after `claw_finish` was reported as "without claw_finish"; fixed in `applyEvent`.

Not verified live (still open):
- Unknown project / unknown assignee refusal before any spawn (covered by unit tests only).
- Cancellation of a live worker (`claw_cancel`).
- Daemon restart mid-run (covered by unit tests only).
- on_exit spawn trigger.
- Hoja `findIssueByMarker` scans only the 250 most recent issues.
