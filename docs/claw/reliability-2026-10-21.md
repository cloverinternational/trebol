# Claw reliability fixes (2026-10-21)

Scope: the three verified gaps in `docs/claw/acceptance-2026-10-21.md`: ambiguous Hoja creates, spawn timeouts that
could launch later, and inbox loss/replay. Evidence is per gap below. Raw evidence is in
`docs/claw/reliability-evidence/`. Nothing was committed or pushed. Unrelated concurrent edits were preserved.

## 1. Ambiguous Hoja create (duplicate risk)

Hoja schema (read-only introspection, `IssueCreateInput`): `title, teamId, description, priority, stateId, assigneeId,
projectId, cycleId, parentId, estimate, dueDate, labelIds`. There is no client-supplied `id` and no idempotency key.
So server-side idempotency is treated as unsupported. Nothing here assumes it.

Design (`.pi/lib/claw/spawn.ts`, `hoja.ts`):
- Phases: `intent -> create_dispatched -> issue_created -> tab_opening -> tab_open`.
- Before any create: a read-only marker lookup. If the marker is found, adopt that issue. A lookup failure keeps the run
  in `intent` and sends nothing.
- `create_dispatched` is persisted before the create request leaves.
- `HojaRequestError.ambiguous` marks timeouts, dropped connections, non-200s and unreadable bodies. Only a GraphQL error
  with no data, or a local check, is definitive.
- Definitive rejection: the run fails. No retry.
- Ambiguous: the run stays in `create_dispatched`. It is reconciled only by the run marker (or the stored issue id) with
  a 15 s backoff. Absence of the marker never triggers a create.
- Verification requires team, project, assignee, marker and state `In Progress`. A mismatch fails the run.

Liveness tradeoff (documented, not solved): if a create never commits, the run stays unresolved (`unresolvedCreates` in
`claw_list`). A human must resolve it. Cancelling it changes no Hoja state and records the marker that needs a manual
check. Exactly-once is not claimed.

Tests: `.pi/test/claw/reliability.test.ts`, "claw Hoja create" block (7 tests). Covers committed-but-lost answer,
delayed commit (late issue adopted, one create), never-committed (no re-create), definitive rejection, failed lookup
before dispatch, adoption of a marker-bearing run, and cancel of an unresolved create.

Real E2E (`docs/claw/reliability-evidence/hoja-create-smoke.json`, `.log`): real Hoja, labelled smoke issue. A local
boundary adapter forwarded the first `issueCreate`, dropped the client's answer at 18:38:07.7Z, and delayed the commit.
- Forwarded creates: 1.
- First lookup missed, so the run stayed `create_dispatched` with no re-create.
- Real Hoja committed late (18:38:14.8Z).
- Reconcile found `TREBOL-277` by marker. Phase moved to `issue_created`, then `tab_open` (fake Tern block, no real tab).
- Server issues with the marker: 1.
- Cleanup: the daemon's verified cancel path moved `TREBOL-277` to `Canceled`. Only this smoke's own issue was touched.

## 2. Spawn timeout and later surprise launch

Design (`orchestrator.ts`, `daemon.ts`, `spawn.ts`, `store.ts`):
- Each spawn request carries `expiresAt`. Its run id is `runIdFor(requestId)`, deterministic, so the caller has a stable
  handle before the daemon acts.
- Daemon: a spawn past `expiresAt` with no run yet is refused `code: "not_started"`. It is never dispatched.
- Deadline re-check: `dispatchCreate` refuses an expired intent with no Hoja write. Before the tab, an expired deadline
  fails the run with no worker launched; the Hoja issue remains `In Progress` for a human.
- Withdraw handshake: on client timeout, the client writes `withdraw` for the request id. The daemon answers:
  - not dispatched: tombstone `not_started`, so the request can never start later;
  - dispatched: `accepted` with the real result or run id;
  - still unanswered (daemon down): the client returns `pending` with the run id, and the request will be refused at
    expiry.
- `request()` returns `done | not_started | pending`, not a generic error. Only daemon validation errors still throw.
- `claw_spawn` description updated to describe these states.

Tests: `reliability.test.ts`, "claw spawn deadline and withdrawal" (4 tests) and "claw client" (3 tests). Covers:
- expired before dispatch;
- withdraw before dispatch (order reversed on purpose);
- withdraw after dispatch;
- deadline passed between Hoja create and tab (no worker);
- pending with no daemon, then a later daemon pass refuses it (no run, no create, no tab);
- done after the daemon answers.

Real E2E (`expiry` probe): a real `daemon-main.ts` process in a scratch workspace, given an expired spawn request.
Output: `{"ok":false,"code":"not_started","error":"expired before dispatch; not started"}`. Runs: 0. No Hoja or Tern call.

Defect found by this real run and fixed: `HojaRequestError` used a TypeScript parameter property. The daemon runs under
`--experimental-strip-types`, which rejects that syntax. Vitest transpiles, so unit tests missed it. It is now an explicit
field. A regression test for strip-only loading is not yet in the suite (see limitations).

## 3. Inbox loss and replay

Pi facts used (`@earendil-works/pi-coding-agent` 1.3.0, `dist/core/agent-session.js`): `sendMessage` with steer can queue
the message in memory. Persistence happens later, through `sessionManager.appendCustomMessageEntry`. So a dispatched
wake is not persistence. The receiver can see persistence in `sessionManager.getBranch()`.

Design (`.pi/lib/claw/inbox.ts`, `extensions/claw/extension.ts`, `store.ts`):
- Each inbox item has a stable id (`key`, or a generated `evt-` id). Legacy items fall back to a content hash.
- A batch is sent with `details.eventIds`. Its ids and end offset are recorded as `inflight` in `orchestrator.json`.
- The offset advances only after every id appears in this session's branch as a `custom_message` of type `claw-inbox`.
  The model's own text never counts.
- Items already persisted are not sent again. An in-flight batch from an earlier session, or an overdue one
  (30 s, same session), is re-sent with the same ids.
- Owner: takeover on session start only when the recorded owner pid is dead or from this process, and claw is enabled.
  Writes re-check ownership. A per-store single-flight guard prevents overlapping pumps.

Tests: `.pi/test/claw/inbox.test.ts` (10 tests): dispatch is not acknowledgement; no re-send of persisted items; restart
re-sends an in-flight batch; overdue resend keeps the same id; non-owner writes nothing; overlapping pumps send once; a
refused wake stays pending; stable ids and key dedup; legacy hash ids; only inbox custom messages count as delivered.

Real E2E (`docs/claw/reliability-evidence/inbox-real-pi-e2e.json`): real `pi --mode rpc` with the claw extension, scratch
workspace and session dir.
1. Session A (pid 71665) claimed the inbox. `k1` persisted once; offset advanced to 93 after persistence.
2. SIGKILL of session A. `k2` was appended while no session ran.
3. Reconnect 1 (session B, same session file): `k2` persisted once; offset 225; in-flight cleared.
4. Reconnect 2 (session C): no new items. Counts stayed `k1=1, k2=1`. Owner pid now C.
Transcript check: exactly two `custom_message` entries with `eventIds`, one per item. Pi logs contained no errors.

## Test runs

- `npx vitest run .pi/test/claw packages/tools/agents`: 8 files, 101 tests, all passing (76 existing + 25 new).
- `npx vitest run .pi/test/runtime .pi/test/tools`: 328 pass, 6 fail in 4 files: `session-hook-dispatch`, `paseo-service`,
  `task-browser` (3), `taskmanage-enforcement`. None imports `lib/claw` or `extensions/claw`. I did not run a clean
  baseline, so they are reported as unrelated, not proven pre-existing.
- Typecheck: `tsc --noEmit --allowImportingTsExtensions --strict` over `.pi/lib/claw/*.ts` and `extensions/claw/extension.ts`: clean.

## Live refs and cleanup

- Hoja: `TREBOL-277` (smoke), created once, cancelled to `Canceled`. Orphan `TREBOL-274` was not touched.
- Scratch only: `/tmp/claw-rel/ws-expiry`, `ws-inbox`, `sess-inbox`. The repo store `trebol/.swarm/claw` was not modified.
- Daemons started by the probes were stopped with `pkill`. Pi children were SIGKILLed.
- The user's Claw tab and daemons were not touched.

## Known limitations

- Create liveness: an unresolved create needs a human. There is no automatic resolution. Exactly-once is not claimed.
- Withdraw race: if the daemon is down for the whole timeout, the caller gets `pending`. The request is refused at expiry
  once the daemon runs, but this relies on the daemon's clock and on it running later.
- Pid-based cancel: `verifyCancelled` signals `run.pid` only when `pidAlive`. Pid reuse is not checked.
- Inbox: at-least-once. A resend after 30 s can schedule a second turn if the first steer was still queued in memory.
  External side effects of a turn are not deduplicated.
- Not exercised live: a kill inside the dispatch-to-persist window (the SIGKILLs happened after persistence). The
  process-kill window for create and tab is covered by unit tests only. Live daemon-level withdraw races are unit-tested,
  not live-tested. Codemode paths were not exercised.
- No regression test yet guards against strip-only syntax regressions in `.pi/lib/claw`.
- Real pi turns were triggered by the wakes. Whether the provider answered each turn was not verified; the logs show no
  errors but the answers were not inspected.
