# Claw live E2E evidence (2026-10-21)

Real pi (`claude-haiku-5-5`, provider `clover-plexus-anthropic`), real Tern tabs, real Hoja (project `Hoja`, team TREBOL),
real daemon, store `trebol/.swarm/claw` (gitignored). Every issue is labeled `[claw]` and is an infrastructure smoke test.
Only scratch tabs opened by this run were closed. Parent panes and other daemons were not touched.

| Step | Evidence (IDs, timestamps) |
| --- | --- |
| Orchestrator, plain pi (`PI_TERN_UI=0 pi`) | tab 111780818845697, block 111780818845698 |
| `/claw on` | `Claw on. Daemon starting. Tab named "Claw".`; `control.json` `pane` = 111780818845698 |
| Model routes through `Agent` (not alternates) | Agent call with project Hoja, label `claw-e2e-smoke` (the prior attempt failed with `Tool Agent not found` before the fix, see below) |
| Run | `run-mvibp1s2-d18dc8`, Hoja **TREBOL-267**, team TREBOL, project Hoja, assignee Luis Alejandro RIncon (read back and verified by `verifyIssue` before the tab opened) |
| Named worker tab, pi worker | tab 7 `claw-e2e-smoke`, block 111905372897282, `π - claw-e2e-smoke` (plain TUI) |
| Worker finish | `claw_finish completed`, evidence `date -u` = `Wed Oct 21 16:25:06 UTC 2026`; run `completed` at 16:25:09.378Z |
| Hoja after daemon flush | `hoja_get TREBOL-267`: state **In Review** (not Done), project Hoja, assignee Luis; comment with `claw-op` marker applied |
| Live parent inbox | `run_completed` delivered to the orchestrator; the model acknowledged it |
| Durable `at` trigger | `trg-mvibq1o4-413c5b` created by the model via `claw_trigger` (`notify`, `at` 2026-10-21T16:27:34.826Z) |
| Orchestrator closed before fire | block 111780818845698 closed; no pi process for it left |
| Detached fire | daemon `trigger_fired` and `notify` at 2026-10-21T16:27:35.627Z; `fired: 1`, `enabled: false`; daemon pid 40533 |
| Reconnect to same store | new orchestrator tab 112622632435714 (new pi session); `/claw on` reported `Daemon already running (pid 40533)` and `Claw inbox (2)` containing `[notify] Claw E2E trigger probe fired`; `orchestrator.json` offset 850 |
| Delivered once | `grep -c "Claw E2E trigger probe fired" inbox.jsonl` = 1 |
| `/claw off` | `control.json` `enabled: false`; no new run record |
| Off surface | fresh orchestrator (block 113077898969090): `claw_list` -> `Tool claw_list not found`; `Agent` -> `Tool Agent not found` |
| On surface | same design, before off: `claw_list` returned `"enabled": true` |

## Defects found by the live run and fixed

1. `Agent` was not in the Swarm contract surface (`swarmSurfaceFor` has no `Agent`), so gating dropped it from the active set:
   `Tool Agent not found`. Fixed: while on, the registered Agent is kept active (`clawRoutedTools`).
2. Pi activates registered tools by default, so `claw_*` stayed visible after off, and the model fell back to `claw_spawn`
   (refused by the daemon with `claw is off`). Fixed: orchestrator tools are active only while on and are never part of the prior set.

## Not covered live (see README gaps)

Unknown project failure before spawn, cancellation, a restart of the daemon mid-run, and an on_exit spawn trigger.

## Resumed verification (2026-10-21, scratch store /tmp/claw-live-2026-10-21)

Reconciliation before retry (16:41 UTC): no claw daemon running for trebol; `.swarm/claw/control.json` enabled=false;
no run left in `launching`; Hoja open `[claw]` issues TREBOL-265 (In Progress, cancelled run; needs human decision),
TREBOL-266 and TREBOL-267 (In Review). No `/tmp/claw-live` leftovers. A `Claw` tab (block 113331302039554) exists that
this work did not create; it was not touched. The timed-out child (`Request timed out after ~482 s`) is not reproduced here.

Harness: `/tmp/claw-live-2026-10-21/probe.ts` calls the real `request()` client (`.pi/lib/claw/orchestrator.ts`) against
the scratch workspace store. Outside the repo.

| Test | Command | Result | Evidence |
| --- | --- | --- | --- |
| Invalid project refused before spawn | `request(spawn, project=ZZ-NoSuchProject-claw-probe)` at 2026-10-21T16:42:26Z | ok=false: `Hoja project "..." not found. Projects: ...` | `runs/` empty; no new tab |
| Invalid assignee refused before spawn | `request(spawn, project=Hoja, assignee=no.such.person.claw-probe@invalid.example)` at 16:42:27Z | ok=false: `not a member of team TREBOL. Members: Luis Alejandro RIncon, Robert Nadales` | `runs/` empty; no new tab |

Both are refused by `startRun` (`.pi/lib/claw/spawn.ts` before `saveRun`), so no run record or Hoja issue exists.

### Live cancellation (real worker)

| Step | Evidence |
| --- | --- |
| Spawn harmless probe | run `run-mvicc14x-122017`, Hoja **TREBOL-268** (project Hoja, assignee Luis Alejandro RIncon), block 118910464557058, tab `claw-probe-cancel`, worker pid 38026, status `running` at 2026-10-21T16:42:56Z |
| `claw_cancel` via real client | 2026-10-21T16:43:01Z: status `cancelled`, `run_cancelled` in inbox |
| Worker and tab | pid 38026 gone; no `claw` tab left in `tern inspect` |
| Hoja after flush | outbox comment done (16:43:07Z); `hoja_get TREBOL-268` state **In Progress** (not Done, not In Review) |

Known limit: `hoja_get` does not return comments, so the cancel comment is evidenced by the daemon's outbox `done` read-back flag only.

### Live on_exit spawn trigger (daemon-fired)

| Step | Evidence |
| --- | --- |
| Parent | run `run-mviccpxp-f80f7d`, Hoja **TREBOL-269** (Hoja, Luis), tab `claw-probe-onexit-parent`, started 16:43:25Z |
| Register on_exit | `trg-mviccuww-a80db2`: `when {kind:on_exit, runId, on:[completed]}`, action spawn `claw-probe-onexit-child`, once=true, created 16:43:29Z |
| Parent finished | `completed` (claw_finish completed, outbox state In Review flushed) |
| Trigger fired by the daemon | inbox `trigger_fired` at 2026-10-21T16:43:36.953Z -> child `run-mvicd0gr-1513af`; key `fired:trg-mviccuww-a80db2@run-mviccpxp-f80f7d` |
| Child | Hoja **TREBOL-270**, started 16:43:37.966Z, `completed` at ~16:43:51Z; `hoja_get` state **In Review** |
| Trigger after | `enabled: false`, `fired: 1`, `once: true` (no duplicate fire); one inbox `fired:` record |

Caveat: this run had no orchestrator session attached. The daemon performed the spawn; the orchestrator was not needed for the fire.

### Live daemon crash mid-run and restart (no duplicate issue or tab)

| Step | Evidence |
| --- | --- |
| Spawn | run `run-mvicdnur-2d4bef`, Hoja **TREBOL-271**, block 119241177038850, tab `claw-probe-restart`, started 16:44:07Z |
| Pre-crash | status `running`, worker pid 46102 alive, 1 tab named `claw-probe-restart`, daemon pid 35887 (scratch) |
| Crash | `SIGKILL` daemon 35887 at 2026-10-21T16:44:12.930Z (daemon not gracefully stopped; `daemon.lock` left behind) |
| Worker during outage | pid 46102 still alive; tab still present |
| Restart | a read-only request (`trigger_remove`, unknown id -> `removed: false`) at 16:44:18.789Z made the client call `ensureDaemon`; `daemon.log`: `claw daemon 47135 started` |
| Reconcile | after restart: status `running`, same worker pid 46102, same TREBOL-271, no new run record, 1 tab |
| Cancel after restart | `claw_cancel` served by daemon 47135 at 16:44:37Z: status `cancelled`, outbox done, worker pid 46102 gone |

Limits: the crash happened in phase `tab_open`, so the `intent` / `issue_created` marker-reconciliation path was not exercised live (only unit-tested). No duplicate was observed in runs or tabs; Hoja duplicate absence is verified by the single run record and issue identifier, not by a Hoja-side search.

### Live orchestrator session: tool surface, alternate-spawn refusal, reconnect transcript

Orchestrator: real pi in a scratch Tern tab, `PI_TERN_UI=0 pi -e trebol/extensions/claw/index.ts --name claw-probe-orch`, cwd `/tmp/claw-live-2026-10-21`.
Tab 119473105272833, block 119473105272834 (opened 2026-10-21T16:45:03Z via `tern new tab`). Transcript:
`/Users/swarm/.pi/agent/sessions/--private-tmp-claw-live-2026-10-21--/2026-10-21T16-45-03-908Z_01a15f5a-1e24-7604-928b-f80dd612ec05.jsonl`

| Step | Evidence |
| --- | --- |
| Reconnect, inbox delivered into this session | on `/claw on` (16:45:41Z, control pane 119473105272834) the transcript holds a `Claw inbox (9)` custom message listing the scratch store's runs and triggers. Count of that message in the transcript: 1 |
| `/claw on` tool surface | `claw_list` executed live and returned daemon 47135, `enabled: true`, run records (16:46:08Z) |
| Alternate spawn while on | the model did not call a Subagent-named tool; its own reply (16:46:19Z) said Subagent was not available, so the alternate was absent from the active set (not exercised through the `tool_call` refusal path) |
| Routed Agent while on | an `Agent` call with `prompt` instead of `task` failed schema validation (16:46:08Z). No spawn happened |
| `/claw off` | control `enabled: false` (16:49:01Z); reply at 16:49:14Z: Subagent present, claw_list absent |

Caveats: the surface results come from the model's own description of its tool list, not a direct `getActiveTools` dump. The "Agent routed to Claw spawn" success path was not re-run here (covered in the earlier run above).

### Cleanup (2026-10-21, 16:46-16:50 UTC)

- Scratch daemon for `/tmp/claw-live-2026-10-21` exited on its own at 2026-10-21T16:46:37Z (`idle; exiting`); `daemon.lock` released.
- Closed only this session's tabs: orchestrator block 119473105272834; completed probes block 119056493445122 (`claw-probe-onexit-parent`) and 119116622987266 (`claw-probe-onexit-child`).
- Pre-existing `Claw` tab (block 113331302039554) and other user tabs were not touched. `tern inspect` after cleanup shows the pre-session tab set.
- No `claw-probe` tabs remain. Worker pids for cancelled runs (38026, 46102) are gone.
- Store `/tmp/claw-live-2026-10-21` left on disk for inspection; the repo's `trebol/.swarm/claw` store was not modified by this session.

### Hoja issues created by this resumed session (not moved to Done; a human decides)

| Identifier | Probe | Final state (read back) |
| --- | --- | --- |
| TREBOL-268 | cancellation (run cancelled) | In Progress |
| TREBOL-269 | on_exit parent (completed) | In Review |
| TREBOL-270 | on_exit child (fired by daemon, completed) | In Review |
| TREBOL-271 | daemon crash/restart (cancelled) | In Progress |

Invalid project and invalid assignee attempts created no Hoja issue.

## Status against the prior missing list

| Item | Status | Basis |
| --- | --- | --- |
| Real on_exit spawn trigger | Verified live | trigger fired by daemon, child TREBOL-270 |
| Daemon restart mid-run, no duplicate issue or tab | Verified live, partial | SIGKILL mid-run; restart reconciled; one run, one tab; crash in `tab_open` phase only |
| Real worker cancellation | Verified live | TREBOL-268 and TREBOL-271 cancelled; workers gone |
| Invalid project and assignee rejected before spawn | Verified live | both refused, no run/issue/tab |
| Actual pre/on/off tool surface restoration | Verified, model-reported | claw_list present only while on; Subagent restored after off (via model's report of its own tool list) |
| Alternate spawn refusal | Partial | Subagent absent while on (not via `tool_call` refusal); refusal path only unit-tested |
| Reconnect delivery evidence in transcript | Verified live | `Claw inbox (9)` custom message in the new orchestrator transcript |

Known limits: the earlier attempt's ~482 s timeout was not reproduced and its child session was not inspected. The tern tool could not read the scratch orchestrator block (see the reported friction). The daemon-run on_exit path was verified without an attached orchestrator. `hoja_get` does not show comments, so cancel comments rest on the daemon's outbox read-back flag.
