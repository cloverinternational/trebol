# /claw v1

Orchestrator in one Pi session; each worker is a visible Tern tab running pi on one task, with one Hoja issue.
Code: `.pi/lib/claw/` (store, spawn lifecycle, daemon, Hoja client, Tern launcher, worker helpers),
`extensions/claw/` (orchestrator tools + `/claw`; worker gate + `claw_finish` when `PI_CLAW_RUN` is set).
Tests: `.pi/test/claw/claw.test.ts` (lifecycle, daemon, Hoja, Tern, worker) and
`.pi/test/claw/clarification.test.ts` (worker-local questions).

## Commands and tools

- `/claw on` — start the singleton daemon if absent; claim the inbox for this session; rename the tab that holds this pane (`TERN_PANE`) to `Claw`. Only that block's tab is renamed, only after Tern confirms the pane is live and the name sticks. Refusal, a missing pane, or an absent Tern is reported as a warning; Claw stays on. The pane is recorded so worker tabs open in its session. It also switches this session's routing (below).
- Routing while on (`.pi/lib/claw/mode.ts`): the single `Agent` tool routes to Claw spawn (`project` required). `Subagent`, `BackgroundTask`, `Delegate`, `DelegateOutput`, `SubagentOutput`, `TaskOutput`, `AgentControl`, `wait_for_agent`, `multi_agent_wait` are removed from the active set and refused at `tool_call`. Orchestrator tools (`claw_spawn|list|read|send|cancel|trigger`) are active only while on. Off restores the prior active set captured at `/claw on`; a session shutdown restores it too and does not change the store control (triggers keep firing).
- Worker launch is plain terminal pi: the command sets `PI_TERN_UI=0` (the documented bypass of the Tern shell dispatch, `docs/reference/tern-pi-shell-dispatch.md`). Normal tools stay enabled; `-nt` is not used.
- `/claw off` — suspend triggers and new runs. Running workers keep running and are still reconciled.
- Per-chat mode: `/claw on|off` persists `claw-mode` in the session transcript; `/reload`, resume and restart restore the chat's own mode (routing and inbox ownership only, no daemon start, tab rename or store change). A new chat starts off. See `docs/claw/reload-persistence-2026-10-21.md`.
- `/claw status` — control state, daemon pid, run counts, pending Hoja syncs, triggers.
- `claw_spawn`, `claw_list`, `claw_read`, `claw_send`, `claw_cancel`, `claw_trigger` (add|list|remove).
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
- **Idempotent, restart-safe.** Establishment is keyed by the run's source (`claw:<runId>`). A resumed session restores
  the persisted goal from its own transcript and the worker leaves it alone; a goal that already ended for that source is
  never re-armed, and a daemon restart reads `run.goal` back from the run record without duplicating anything. Ending a
  goal removes its spec file, so nothing can re-establish it after the fact.
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

Tests: `.pi/test/claw/goal.test.ts` (derivation, recording, the loop, every brake, restart, near-misses),
`.pi/test/tools/swarm-goal.test.ts` (host API, session lookup, observer), mutation checks in
`tools/verify/claw-goal-mutations.mjs` (20 guards), live demonstration in `tools/e2e/claw-goal-always.mjs` (real `pi`,
real extensions, a harmless `/tmp` condition).

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

## Durability

- One daemon per workspace (`.swarm/claw/daemon.lock`, pid-checked; a dead owner is reclaimed). Started detached via
  `node --experimental-strip-types daemon-main.ts`; logs to `.swarm/claw/daemon.log`. Exits after 120 s with no active
  run, enabled trigger or pending request; the next client request restarts it.
- Single writer: only the daemon writes `runs/` and `triggers/`. Clients write `requests/`; the daemon writes `responses/`.
  A response file marks a request served, so replays are no-ops.
- Launch phases `intent -> issue_created -> tab_opening -> tab_open` are persisted before side effects.
  The launch gate runs in `issue_created`, before a tab exists, so a retry there can never create a second tab.
  Restart reconciles `intent` by Hoja marker (`<!-- claw-run:ID -->`) before creating an issue. `tab_opening` is ambiguous
  and is reported failed, never retried.
- Triggers fire with a key (`trg@scheduled-time` or `trg@run`); runs and inbox items dedupe on it.
- Hoja writes go through an outbox with read-back; each comment carries `<!-- claw-op:ID -->` and is skipped if already visible.
- Inbox (`inbox.jsonl`) is durable; the owning session delivers unread items on start and every 3 s.

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
