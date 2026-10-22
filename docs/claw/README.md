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
- Worker only: `claw_finish {outcome: completed|failed|needs_user, summary, evidence[]}`. `completed` needs evidence.

## Status model

| Status | Meaning |
| --- | --- |
| launching | run persisted; Hoja issue / tab in progress |
| running | worker reported `started` |
| idle | native turn settled with no `claw_finish`. Not a result; may be awaiting input or a permission |
| awaiting_decision | the worker opened its own `ask_user_question` modal in its tab and the turn is suspended until a human answers or cancels there. Active, not a result |
| awaiting_user | worker reported `needs_user` |
| completed | `claw_finish completed` with evidence; Hoja moves to In Review |
| failed | `claw_finish failed`, launch failure, or completion refused for missing evidence |
| lost | worker process gone without `claw_finish` |
| cancelled | stopped by `claw_cancel` |

Hoja Done is never set automatically. `agent_settled` is never treated as success.

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

## Durability

- One daemon per workspace (`.swarm/claw/daemon.lock`, pid-checked; a dead owner is reclaimed). Started detached via
  `node --experimental-strip-types daemon-main.ts`; logs to `.swarm/claw/daemon.log`. Exits after 120 s with no active
  run, enabled trigger or pending request; the next client request restarts it.
- Single writer: only the daemon writes `runs/` and `triggers/`. Clients write `requests/`; the daemon writes `responses/`.
  A response file marks a request served, so replays are no-ops.
- Launch phases `intent -> issue_created -> tab_opening -> tab_open` are persisted before side effects.
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
