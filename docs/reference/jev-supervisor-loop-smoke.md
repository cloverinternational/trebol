# Jev supervisor loop smoke

Run `node tools/experiments/jev-audit/supervisor-loop-smoke.mjs` from the
Pi-Swarm checkout. The smoke has a strict 90-second watchdog and cleans up all
temporary state.

It uses a temporary foreign workspace, HOME/agent directory, session directory,
and isolated memory store. The parent loads the package extensions, enables Jev
supervisor reconciliation and `PI_SWARM_SUPERVISOR_TASK_APPLY=on`, and talks
only to a localhost scripted Pi provider; no live key or production endpoint is
used.

The Jev `systemone` request is intercepted by a dedicated preload fixture. This
is the **first-finder stub**, not a test of Jev classification quality. The rest
is real: Pi forks the restricted memory worker, which searches and reads the
snapshot, then records `supervisor_review` followed by
`supervisor_task_proposal`. The parent performs real snapshot validation and
TaskManage handoff, and the parent journal is checked for a pending task.

The assertion rejects completed or deleted outcomes. It prints bounded child
output, provider request count, journal size, and receipt assertions. No direct
TaskManager mutation is used to fake success.

Parent rerun corrected fixture/session IDs, tool exposure and journal matching.
First-finder is now explicitly injected through the production audit adapter, NOT
an intercepted HTTP response. Actual fork worker records confirmation and proposal;
parent TaskManage creates the pending task through guarded dispatch. No direct
manager mutation is used. Scripted parent is held alive at agent_end for completion;
this is not an unscripted productivity test or proof headless shutdown drains work.
A production runner defect was fixed: --no-tools alone hid registered worker tools;
runner now explicitly selects its four restricted tools. Parent TaskManage must also
be active, otherwise the dispatcher correctly refuses the change.
