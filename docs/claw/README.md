# /claw v1

Orchestrator in one Pi session; each worker is a visible Tern tab running pi on one task, with one Hoja issue.
Code: `.pi/lib/claw/` (store, spawn lifecycle, daemon, Hoja client, Tern launcher, worker helpers),
`extensions/claw/` (orchestrator tools + `/claw`; worker gate + `claw_finish` when `PI_CLAW_RUN` is set).
Tests: `.pi/test/claw/claw.test.ts`.

## Commands and tools

- `/claw on` — start the singleton daemon if absent; claim the inbox for this session; rename the tab that holds this pane (`TERN_PANE`) to `Claw`. Only that block's tab is renamed, only after Tern confirms the pane is live and the name sticks. Refusal, a missing pane, or an absent Tern is reported as a warning; Claw stays on. The pane is recorded so worker tabs open in its session. It also switches this session's routing (below).
- Routing while on (`.pi/lib/claw/mode.ts`): the single `Agent` tool routes to Claw spawn (`project` required). `Subagent`, `BackgroundTask`, `Delegate`, `DelegateOutput`, `SubagentOutput`, `TaskOutput`, `AgentControl`, `wait_for_agent`, `multi_agent_wait` are removed from the active set and refused at `tool_call`. Orchestrator tools (`claw_spawn|list|read|send|cancel|trigger`) are active only while on. Off restores the prior active set captured at `/claw on`; a session shutdown restores it too and does not change the store control (triggers keep firing).
- Worker launch is plain terminal pi: the command sets `PI_TERN_UI=0` (the documented bypass of the Tern shell dispatch, `docs/reference/tern-pi-shell-dispatch.md`). Normal tools stay enabled; `-nt` is not used.
- `/claw off` — suspend triggers and new runs. Running workers keep running and are still reconciled.
- Per-chat mode: `/claw on|off` persists `claw-mode` in the session transcript; `/reload`, resume and restart restore the chat's own mode (routing and inbox ownership only, no daemon start, tab rename or store change). A new chat starts off. See `docs/claw/reload-persistence-2026-10-21.md`.
- `/claw status` — control state, daemon pid, run counts, pending Hoja syncs, triggers.
- `claw_spawn`, `claw_list`, `claw_read`, `claw_send`, `claw_cancel`, `claw_trigger` (add|list|remove).
- Worker only: `claw_finish {outcome: completed|failed|needs_user, summary, evidence[]}`. `completed` needs evidence.

## Status model

| Status | Meaning |
| --- | --- |
| launching | run persisted; Hoja issue / tab in progress |
| running | worker reported `started` |
| idle | native turn settled with no `claw_finish`. Not a result; may be awaiting input or a permission |
| awaiting_user | worker reported `needs_user` |
| completed | `claw_finish completed` with evidence; Hoja moves to In Review |
| failed | `claw_finish failed`, launch failure (gate refusal, tab-open failure, timeout), worker death before any event, or completion refused for missing evidence |
| lost | worker had reported `started` (or a settle) and its process/tab then vanished without `claw_finish` |
| cancelled | stopped by `claw_cancel` |

Hoja Done is never set automatically. `agent_settled` is never treated as success.

Cancel maps the Hoja issue to `Canceled` only when the worker pid is gone and its tab is not live (verified). Otherwise the Hoja state is left unchanged and the comment says so. See `docs/claw/acceptance-2026-10-21.md`.

## Launch gate

A worker is a plain `pi` process whose first act is loading the extension source under its `cwd`, so a broken source used
to kill the tab before any run event existed (the run then surfaced as a silent `lost`). `.pi/lib/claw/preflight.ts`
decides both hazards before a tab opens.

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
- A run that dies **before writing any event** (no `started`, no settle) is reported `failed`, saying the extension
  source probably failed to load, naming its source checkout and the next step — never the silent `lost` state.

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

- Permission waits are not detectable from native signals; they appear as `idle`.
- PID liveness is `kill(pid, 0)` without start-time checks; pid reuse is theoretically possible.
- Tab naming: `/claw on` renames the pane's tab; outside Tern (`TERN_PANE` unset) or when Tern refuses, the warning says to name it `Claw` manually. Worker tabs whose rename fails are reported with `tabWarning` in `claw_read`.
- Marker lookup uses the Hoja description filter (exact). A create that commits after the lookup can still produce a duplicate; not closed (see acceptance doc).
- Inbox delivery is at-least-once in the crash window after persistence, and can drop an item in the dispatch-to-persist window. Exactly-once is not claimed.
- A timed-out `claw_spawn` may still start a run; check `claw_list` before retrying.
- Worker depth 1 is enforced by a `tool_call` block list (`WORKER_BLOCKED_TOOLS`); normal approval gates are unchanged.
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
