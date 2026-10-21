# Claw acceptance evidence (2026-10-21, continuation)

Scope: the five open acceptance items after `e2e-evidence-2026-10-21.md`. Scratch stores and workspaces were under
`/tmp/claw-acceptance/`; the repo store `trebol/.swarm/claw` was not modified. Hoja issues below are labelled
`[claw]` / `[claw-acceptance]` test artifacts. Nothing was moved to Done.

## 1. Active tool registry in a real Pi runtime (verified)

Runtime: `pi 1.3.0 --mode rpc --no-session --no-extensions -e trebol/extensions/claw/index.ts -e <probe>`, cwd a scratch
workspace, `TERN_PANE` unset. The probe is outside the repo. It snapshots `pi.getActiveTools()` / `pi.getAllTools()` and
registers stub alternate spawners (`Subagent`, `BackgroundTask`, `Delegate`, ...) whose `execute` appends to a side-effect
log. It also wraps the real `registerAgents` with a manager whose `spawn` is the legacy side effect. The stubs are labelled
harness stubs.

| Snapshot | Active tools |
| --- | --- |
| baseline | read, bash, edit, write, Agent, AgentControl, Subagent, BackgroundTask, Delegate, DelegateOutput, SubagentOutput, TaskOutput, wait_for_agent, multi_agent_wait |
| `/claw on` | read, bash, edit, write, Agent, claw_spawn, claw_list, claw_read, claw_send, claw_cancel, claw_trigger |
| `/claw off` | identical to baseline |
| `/claw on` then `new_session` | identical to baseline (claw mode is not carried across the session transition; the store control is) |

Deliberate differences while on: alternates removed from the active set; `AgentControl` removed too; `claw_*` active. The
`Agent` schema is overlaid only in the provider payload. Provider-side Agent declaration (logged by the probe):
`input_schema.required = ["task","project"]`. Pi still validates tool arguments against the registered schema (`task` only).

Guard (real model calls; the harness re-activated the alternates through `pi.setActiveTools`, which is an injection at the
registry boundary, labelled as such):

| Call | Result |
| --- | --- |
| model calls `Subagent` | `tool_call` block: "Subagent is disabled while Claw is on..." (isError) |
| model calls `BackgroundTask` | same block |
| model calls `Delegate` | same block |
| model calls `Agent` with `{task}` only | route rejects: `project is required`; legacy `manager.spawn` not reached |

`effects.log` in the side-effect directory was empty after all runs. Model-side note: in an earlier run the model sent the key
`prompt` seven times and the runtime rejected each one by schema, with no side effect.

Not verified live: codemode / deferred exposure. Source read (`dist/core/agent-session.js:388-417`): nested
`ctx.executeTool` calls go through `_beforeToolCall` with the parent id, so the `tool_call` guard also applies. Live
codemode was not exercised.

## 2. Launch recovery around intent / issue_created / tab_opening (verified with real Hoja; faults labelled)

Faults are injected only at the adapter boundary: `fetch` (Hoja) and `tern` exec. The real request always reaches Hoja.
Counts are read independently with a server-side `description.contains` filter.

| Scenario | Fault | Result | Hoja issue | Independent count |
| --- | --- | --- | --- | --- |
| drop-create | response dropped after `issueCreate` was accepted | retry reconciled by marker, issue_created, no second create | TREBOL-272 | 1 |
| slow-create | client timeout 1.5 s, server completes create after 3 s | timeout reported as outcome unknown, marker lookup found it | TREBOL-273 | 1 |
| crash-after-create | own process SIGKILL right after create was accepted | restart from persisted intent reconciled to issue_created | TREBOL-276 | 1 |
| tab-drop | real `tern new tab` (stand-in `sleep 60` command) then response lost | failed, not retried, one `new tab` call over three ticks | TREBOL-275 | 1 |

Defect found and fixed: the tab created in tab-drop was never named (rename happens after creation), so the old message
"check Tern for a tab named <label>" pointed at nothing. `findRunBlock` now locates the block by `PI_CLAW_RUN=<run id>` in
its command. Tern stores that command shell-escaped (`PI_CLAW_RUN='\''id'\''`), so the first literal match missed the real
block. The regex fix was then confirmed on a real tab (found, then closed; absent id returns nothing).

Defect fixed: `findIssueByMarker` read `issues(first:250)` and matched in memory. It now uses
`filter: { description: { contains } }`, which is exact and not bounded by a page. The live check showed the filter works.

Known gaps (not fixed):
- After a create that committed late (after the marker lookup returned nothing), a second create can still occur.
  Hoja client-supplied ids were not tested, so this is not closed.
- `intent` gives up after five attempts. An issue that was created but never verified can then remain without a
  run link.
- Harness-caused orphan: TREBOL-274 (marker present, In Progress, no run record). Its first crash attempt ran before
  my harness wiped the store. It needs a human close.
- The 90 s client timeout on `claw_spawn` leaves the request queued. The daemon may still serve it, and the model can
  re-issue it, which creates a second run. Message changed to "outcome unknown; run claw_list before retrying". No
  automatic withdrawal.

## 3. Comments and cancellation mapping (verified)

Comments are readable through GraphQL `issue(id:"TREBOL-268") { comments(first:50) { nodes { body } } }`. Both cancel comments
(TREBOL-268, TREBOL-271) carry `<!-- claw-op:... -->`.

Policy change: a verified cancel of a Claw-owned issue maps to Hoja `Canceled`. Verification requires the worker pid to be
gone (after SIGTERM, within 5 s) and the worker's tab to be not live. Otherwise the state is unchanged and the comment says
"not confirmed gone". Never Done. The earlier test asserted that cancel never changes state; that was the old policy and
the test now asserts the new one.

Live (real daemon `handleRequest` + `flushOutbox`, real Hoja, read back over GraphQL):
- TREBOL-272, 273, 276 (own recovery tests): cancelled, Canceled.
- TREBOL-268, 271 (earlier live cancels, workers verified gone): Canceled.
- TREBOL-265 (user store, `trebol/.swarm/claw`): left In Progress for a human decision. Not touched.
- TREBOL-275 (failed run): left In Progress. Failed runs do not map to a Hoja state.

## 4. Inbox delivery counted from transcripts (measured, not exactly-once)

Three real pi processes with persisted session files: connect A, reconnect 1 (B), reconnect 2 (C). Each appended one item
through the daemon's `appendInbox`. Delivered text was counted in the session JSONL.

| Item | `custom_message` (`customType: claw-inbox`) records | Files |
| --- | --- | --- |
| X (session A) | 1 | 1 |
| Y (after reconnect 1) | 1 | 1 |
| Z (after reconnect 2) | 1 | 1 |

The second textual hit per file is the assistant quoting the item, not a redelivery. The offset advanced 119, 246, 373.

Semantics, from reading `pump`: the offset is written after `wake.send` returns true, which means dispatch. Persistence is
asynchronous and not awaited. Consequences: a crash between persistence and the offset write redelivers (at-least-once).
A crash in the dispatch-to-persistence window can drop the item (at-most-once there). Exactly-once is not claimed. Not
tested: daemon failure during delivery. Delivery runs in the orchestrator process, not in the daemon.

## 5. Focused test run

Command: `npx vitest run .pi/test/claw packages/tools/agents` (portable 200 s bound).
Result: 6 files, 76 tests, all passing (`/tmp/claw-acceptance/vitest-after-fix4.log`).

Previous exclusion: no `.skip`, `.only`, or exclude entry for claw tests exists in `vitest.config.ts` or the claw test files.
The earlier excluded run cannot be reconstructed from repo state; this run covers all six claw and agents test files.

Tests added or changed for the fixes: cancel verified vs. unverified; tab-open locator (no block; lost response → block
located; escaped Tern command); `findIssueByMarker` filter query.
