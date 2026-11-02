# Hoja task publication

Date: 2026-11-02. Scope: `extensions/hoja-mode/extension.ts`,
`extensions/hoja-mode/publish.ts`, `.pi/lib/claw/hoja.ts`.

## Behavior

Hoja mode is on by default in every chat. While it is on, a successful
TaskManage batch is published to Hoja as **coarse** work: one issue per
top-level task, never one per implementation step. `/hoja off` disables both
publication and the Hoja-first guidance for that chat; `hoja_list`/`hoja_get`
stay available and read-only.

Publication is driven by the TaskManage result the host already emits:
`event.input.operations` (metadata, description) and `event.details.batch`
(which tasks actually succeeded, and with what `op`). No other tool can create
a Hoja issue.

| Task | Published | How to change it |
| --- | --- | --- |
| Top-level task (`parent_id` absent) | yes | `metadata: {"hoja":"local"}` |
| Child task (a step) | no | `metadata: {"hoja":"publish"}` |
| Any task naming an existing issue | links, never creates | `metadata: {"hojaIssue":"TREBOL-123"}` |
| A read (`op: "get"`/`"list"`) result | never | — |

Metadata is read from the operation that produced the result, so it is
evaluated per operation, not accumulated from earlier batches. `"local"` wins
over every other Hoja key on the same operation: a task the agent kept out of
Hoja is never published, even if it also names an issue. An `update` publishes
only when it carries Hoja metadata (typically a corrected `hojaProject` after a
skip, or an explicit `hoja:"publish"`); a plain update never publishes.

Project resolution: `metadata.hojaProject`, else the `HOJA_PROJECT`
environment variable. Without either, the task is recorded `skipped` with
`reason: "no_project"` and **no** Hoja call is attempted. There is deliberately
no workspace-name fallback: guessing a name would publish work into the wrong
project. Assignee resolution: `metadata.hojaAssignee`, else `"me"`; the
assignee must already be a member of the project's team (existing client
contract).

A promoted child is created as a sub-issue of its parent's issue and the
hierarchy is read back (`parent { id identifier }`) before it is recorded. If
the parent has no issue in this chat, the child is **deferred**
(`skipped`/`parent_unpublished`) and retried on a later batch — it is never
silently filed as a root issue.

Nothing in this path moves, closes, assigns or comments on an issue. A reused
issue — including one the session did not create, and including a closed one —
is only linked. That is what keeps shared issues safe from an automatic writer.

## Durable intent, reconciliation and retry

Two mechanisms, both required:

1. **Intent before the write.** Immediately before `createIssue`, the record
   `{state:"reconciling", reason:"write_in_flight", marker, project, projectId,
   expectedParentIssueId?}` is journaled as a `hoja-task-link` session entry.
   The extension's `journal` callback appends it synchronously, so a crash,
   kill or reload after the server committed but before any outcome was
   recorded still leaves a durable trail.
2. **Never re-create an unconfirmed write.** At the start of every later
   attempt, each `reconciling` record is searched by its marker
   (`findIssueByMarker`, server-side description filter) and the hit is read
   back. It is adopted only when the read-back proves the marker is present,
   the project id matches the expected one (when known), and the parent id
   matches the expected one (including "no parent"). A search miss, a search
   error, an unreadable read-back or any mismatch leaves the record
   `reconciling`: absence in a filtered search is not proof that nothing was
   created. The task is then reported as unresolved and **no create is
   attempted for it**.

States:

- `linked` — the issue exists and was read back; nothing else happens.
- `reconciling` — a write may have committed but is not confirmed (also used
  for the pre-write intent, and after an ambiguous error, an unreadable
  read-back or a read-back mismatch). Blocks automatic creation for that task.
- `skipped` — deliberate or environmental: local step, no project, unavailable
  workflow state, parent not published, invalid metadata. Re-evaluated when the
  task appears in a later batch, so a `no_project` task publishes once
  `metadata.hojaProject` names a real project.
- `failed` — a definitive rejection (`issue_not_found`, `project_unresolved`,
  `create_failed`, `lookup_failed`). Retried when the task appears in a later
  batch.

Every created issue carries `Link marker: hoja-task:<session>:<task>` in its
description. The marker alphabet is restricted to `[A-Za-z0-9_-]`, so no caller
text reaches a query.

The only way out of an unconfirmed record is explicit: the agent finds the
issue with `hoja_list`/`hoja_get` and links it with `metadata.hojaIssue`. That
adoption is read-only and is the deliberate human resolution of an ambiguity;
publication never creates a second issue on its own.

## What the model is told

Publication runs inside the `tool_result` handler, which returns a Pi content
patch: one extra text block listing the linked identifiers and, for every task
that was not published, the reason plus the concrete next step (for example
"confirm the exact name with `hoja_list` and set `metadata: {"hojaProject": …}`
on a later TaskManage update"). `details` is deliberately left untouched, so
the structured batch the host stored is unchanged. A notification alone would
be invisible to the model, and a silent skip is how an agent keeps believing
work was filed when it was not.

Reason guidance covers `no_project`, `project_unresolved`, `state_unavailable`,
`invalid_hoja_metadata`, `invalid_hoja_issue`, `issue_not_found`,
`lookup_failed`, `create_failed`, `parent_unpublished`, and the unconfirmed
case.

## Session safety

- **Serialized.** Batches are chained, one at a time, so a second TaskManage
  result always observes the first batch's associations instead of racing it
  into a duplicate issue.
- **Generation guard.** `/hoja off`, `/hoja on`, `session_start` and
  `session_shutdown` bump a generation counter. A batch captures it and stops
  before its next writer call and before its next journal write, so an
  in-flight batch from a chat that went away can neither start new writes nor
  journal into the new chat. An intent already journaled stays `reconciling`
  and is reconciled by the next attempt.
- **Journal replay.** `session_start` replays the newest record per task, so a
  reload, resume or fork cannot publish the same task twice.

## Hoja schema evidence (read-only)

Recorded by an earlier read-only introspection of the live schema
(`LINEAR_API_URL`/`LINEAR_TOKEN` from the environment; only type and field
names were read, no values and no writes). It was **not** re-run for this
change:

```text
IssueCreateInput: title, teamId, description, priority, stateId, assigneeId, projectId,
                  cycleId, parentId, estimate, dueDate, labelIds
IssueUpdateInput: same shape, all optional
Issue.parent: Issue        IssueFilter: identifier/title/description/parent/...
IssueFilter.identifier: StringComparator
Query.issues(filter: IssueFilter, first: Int, after: String, orderBy: PaginationOrderBy)
Query.issue(id: String!)
```

`parentId` on `IssueCreateInput` and `Issue.parent` on `Issue` are therefore
supported, and the hierarchy is read back and compared before a child is
recorded as linked. No `children` field exists on `Issue`, so nothing depends
on one. A second read-only check reports team `TREBOL` states as
`Backlog, Todo, In Progress, In Review, Done, Canceled`, so `Todo` (pending) and
`In Progress` (in-progress) resolve.

## Known limits

- **No live write was performed**, in this change or the earlier one: there is
  no identified disposable project/team to write to safely. Creation, reuse,
  hierarchy, deferral, skipping/retry, reconciliation, serialization and the
  session guard are covered by `.pi/test/tools/hoja-publish.test.ts` against
  the real client surface; the live write path itself is **unverified**.
- Local/project metadata is evaluated per operation (see above); a task created
  with `hoja:"local"` and later updated without metadata stays out of Hoja.
- A promoted child whose parent task never appears in a batch in the current
  chat stays deferred: linking the parent (any operation carrying
  `hojaIssue`) or naming an issue on the child is the way forward.
- A task whose ambiguous write never appears (even later) remains
  `reconciling` and needs the explicit `hojaIssue` resolution; it never
  re-creates automatically.
- Publication is awaited inside the `tool_result` handler; a slow Hoja response
  delays that turn by at most the client's 15 s timeout times the number of
  issues in the batch.
- State names are the team's own (`Todo`, `In Progress`). A team without either
  records `skipped`/`state_unavailable` instead of picking an unrelated state.

## Checks

```sh
npx vitest run .pi/test/tools/hoja-publish.test.ts .pi/test/tools/hoja-mode.test.ts \
  .pi/test/tools/hoja-mode-restore.test.ts .pi/test/claw/session-mode-restore.test.ts
npx vitest run .pi/test/claw
npx tsc --noEmit --strict --target ES2022 --module NodeNext --moduleResolution NodeNext \
  --skipLibCheck --allowImportingTsExtensions --types node \
  .pi/lib/claw/hoja.ts extensions/hoja-mode/publish.ts extensions/hoja-mode/extension.ts
```
