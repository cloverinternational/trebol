# Hoja task publication

Date: 2026-11-02. Scope: `extensions/hoja-mode/extension.ts`,
`extensions/hoja-mode/publish.ts`, `extensions/hoja-mode/lifecycle.ts`,
`.pi/lib/claw/hoja.ts`.

## Behavior

### Missing-project recovery (automatic, non-blocking)

A normal Pi launched in Tern completed Git status summary work after publication
failed `project_unresolved` for `trebol`. The live catalog had no Trebol/Tern
project. Issue listing was not sufficient project discovery. The corrected
workflow uses `hoja_project action=list` (includes empty projects and teams),
then asks the user where to file the work, offering a new project. `select`
remembers the exact destination for this chat. `create` requires native user
confirmation of the project name and team, journals intent before dispatch,
and reads back the created project. An uncertain attempt is never blindly
recreated. Selection invalidates the issue client's cached project catalog, and queued
tasks are retried automatically from their authoritative snapshots.

A later reproduction showed the gate was the problem: a bank-extraction task
was created `no_project`, and a *read-only* report inspection (`cat … | grep`)
was then blocked, with the agent telling the user to pick a project or run
`/hoja off`. Filing is now lifecycle-owned recovery, never a blocker:

- no tool is blocked — not edits, not Bash, not task completion;
- on `no_project`/`project_unresolved` the extension runs **one bounded
  catalogue discovery per task** (`MAX_RECOVERY_ATTEMPTS = 2` per chat,
  journaled as `hoja-recovery` and replayed on resume, so a reload neither
  rediscovers forever nor repeats the same note);
- if a *declared* mapping (chat selection, repository config, `HOJA_PROJECT`)
  failed to resolve, the same task is retried **once** after discovery, which
  heals a transient catalogue failure without a second TaskManage call;
- discovery reports up to 12 candidates **with their descriptions and team
  keys**, so ownership can be resolved from evidence. It never chooses one:
  picking by position or name similarity is forbidden. Good evidence is a
  project description, this repository's docs/remote, and a mapping already
  confirmed in the chat; the agent asks the user only when that evidence is
  genuinely ambiguous or a new project is needed;
- after a successful `select`, **queued tasks are retried immediately** from
  their authoritative snapshots (`hoja-recovery.pending`), and a later plain
  TaskManage update retries them too. The retry is chained into the same
  serialized queue as publication, so two selects or a select racing a batch
  cannot create the same issue twice;
- snapshots come from `taskFacts`, so canonical `task.answers` (answer and
  evidence) survive even when the questions array carries no answer; only
  succeeded `create`/`update` results are accepted. Before any retry, every
  successful mutation of a queued task refreshes its snapshot — a plain update
  produces no publication record, so a completed task cannot be retried with a
  stale status — and a task that was deleted or marked `hoja:"local"` is
  dropped from the queue. A queued child keeps its parent id and is retried
  with explicit `hoja:"publish"`, so the parent/child intent is preserved and
  the child is deferred until its parent is linked;
- the queue is bounded (10), journaled and replayed on resume. Overflow is
  **reported**, not hidden: the dropped oldest tasks are not treated as filed,
  and each is queued again from its authoritative task on its next successful
  update;
- repository persistence reports the writer's real result: `remembered` is
  `false` with the reason when the file could not be written, even though the
  chat selection still applied;
- discovery invalidates the issue client's cached catalogue before any retry,
  so the real client cannot keep resolving against a stale project list;
- the note says the work is not blocked and never offers `/hoja off` as the
  remedy; an unfiled completion reports `nothing was created` and never claims
  a remote sync.

Repository-wide persistence is **opt-in**: an ordinary `select` is session-only.
`select` with `remember: true` (or `create`) asks the host to confirm, and only
then does `writeHojaProjectMapping` merge `project` into the checkout's
`.pi/config/hoja.json`. The writer resolves the repository root from `.git`
(so a subdirectory chat updates the same file), preserves every existing key,
refuses a malformed document instead of replacing it, and refuses symlinked
paths or a resolved directory outside the checkout. A fresh chat in the same
checkout then files there automatically.

The real reloaded Tern session successfully discovered the catalog and opened
the filing questionnaire. Project creation and issue read-back are still
pending the user's destination choice; this is not a live-write success claim.

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
| Any task naming an existing issue | links, then files its own work as a sub-issue | `metadata: {"hojaIssue":"TREBOL-123"}` |
| A read (`op: "get"`/`"list"`) result | never | — |

Metadata is read from the operation that produced the result, so it is
evaluated per operation, not accumulated from earlier batches. `"local"` wins
over every other Hoja key on the same operation: a task the agent kept out of
Hoja is never published, even if it also names an issue. An `update` publishes
only when it carries Hoja metadata (typically a corrected `hojaProject` after a
skip, or an explicit `hoja:"publish"`); a plain update never publishes, but it
**does** keep an already-linked task's issue current (see lifecycle below).

## Where work is filed

A delegated agent starts its task tree in a fresh process and cannot know the
board's exact project name, so the destination is resolved from declarations,
in this order:

1. `metadata.hojaProject` on the operation — an explicit per-task override.
2. The target resolved for this chat: a `hoja_project` `select` choice, else
   the host's option, else the repository's project.
3. The repository's `.pi/config/hoja.json` (`{"project":"Hoja"}`), tried again
   after the chat target so an unresolvable chat target cannot dead-end.
4. `HOJA_PROJECT` from the environment.

`.pi/config/hoja.json` is what makes the default path work: the checkout states
which project its work belongs to once, and every chat — including a headless
delegated one that never mentions Hoja — files there. Writing that file is not
required for the read tools, only for automatic creation.

Project *names* are never derived from the workspace path. A directory called
`trebol` is not a project, and publishing into a guess is worse than not
publishing: names come from `.pi/config/hoja.json`, an explicit selection, or
`hoja_project action=list`, which reads the real catalogue (including empty
projects — `hoja_list` only lists issues, so it cannot prove a project exists).

If an agent still names a project that does not exist and a later declaration
resolves, the issue is created in the resolved project and the outcome says so
(`substitutedFrom`, plus a line in the model-facing note), so a wrong name never
passes silently. Only an unresolvable *project* falls through to the next
candidate: an assignee who is not a team member is a real configuration error
and is not hidden by filing somewhere else.

When nothing declares a project, the task is recorded `skipped` with
`reason: "no_project"` and **no** Hoja call is attempted; the note tells the
model to add `.pi/config/hoja.json`. Assignee resolution:
`metadata.hojaAssignee`, else `.pi/config/hoja.json` `assignee`, else `"me"`;
the assignee must already be a member of the project's team (existing client
contract).

`hoja_project` (registered with the read tools) is the discovery and recovery
surface: `action=list` reads projects and teams, `action=select` remembers an
existing exact project for the chat, and `action=create` creates one in an
exact team **after** a host confirmation that shows the name and team. An
uncertain create is journaled before the request and reconciled by exact name
and team, never repeated blindly.

While filing is unresolved (`no_project` or `project_unresolved`), the
extension recovers automatically as described above and the chat keeps working;
nothing is gated.

A promoted child is created as a sub-issue of its parent's issue and the
hierarchy is read back (`parent { id identifier }`) before it is recorded. If
the parent has no issue in this chat, the child is **deferred**
(`skipped`/`parent_unpublished`) and retried on a later batch — it is never
silently filed as a root issue.

Publication itself creates or links. Lifecycle sync (below) writes only to an
issue this session provably owns. A reused issue — including one the session
did not create, and including a closed one — is never moved, closed or
commented on: the session's work is filed as a sub-issue beneath it.

## Lifecycle sync: questions, progress, completion

Publication alone is not enough: an issue that is created and never updated
lies about the work (reported case: `TREBOL-577` stayed `Todo`, with no
questions, answers or comments, after its TaskManage task completed). Every
successful `create`/`update` result is therefore read as authoritative task
facts (`task.questions`, `task.answers`, `task.status`) and applied to the
linked issue by `extensions/hoja-mode/lifecycle.ts`.

| Task event | Hoja write |
| --- | --- |
| Issue created | description includes the managed block with the acceptance questions and `Status:` |
| Any update while linked | managed block rewritten **only** when its content differs (status, questions, answers) |
| Task `pending` / `in_progress` | issue state set to `Todo` / `In Progress` (read back), including reopening a `Done` issue |
| Completion accepted locally | one evidence-bearing comment, then state `Done` |
| Completion with an unanswered question | block updated, no comment, no close (`completion_unaccepted`) |
| Plain update, no Hoja metadata | syncs the linked issue; never creates or adopts |

**Questions are not issues.** They live inside the managed block:

```text
<!-- hoja-managed:start -->
Status: completed

Acceptance questions (tracked here, not as separate issues):
- [x] `change-scope` What changed, and where?
  - Answer: Summary totals in the overlay.
  - Evidence: .pi/lib/tern/startup-card.ts#L304
<!-- hoja-managed:end -->
```

Only that block is rewritten. Everything before and after the markers — the
human-written description, including its trailing whitespace — is preserved
byte-for-byte, and an issue written before the block existed simply gains one.
The write is not trusted: the issue is read back and must equal exactly the
merged text (block present, outside text untouched) before anything else
happens. A server that ignores the write or normalizes the description records
`description_unverified` and the pass stops.

**Ownership is proved, not assumed.** A write is allowed only when the issue
description has a line exactly equal to
`Link marker: hoja-task:<session>:<task>`. Substring matching is never used:
task #1's marker is a prefix of task #10's, and a description that merely
quotes a marker in prose is not ownership. Exact line matching is also how a
legacy link is proven: `TREBOL-577` carries `Link marker:
hoja-task:<session>:1`, so its task #1 owns it even though its journal record
predates this feature. A reused issue carries no such line, so:

- the shared issue is **never** written to — not its state, description or
  comments;
- the session's work becomes **one** sub-issue beneath it, carrying the marker,
  the managed block and the completion comment;
- the record is repointed to that sub-issue, and the shared issue's identifier
  is kept as `parentIdentifier`/`umbrellaIdentifier`.

**Completion is two verified writes.** The comment body carries
`Answer marker: hoja-answer:<session>:<task>:<revision>`, where `<revision>` is
a hash of the accepted question/answer/evidence set. Before writing, existing
comments are searched for that exact marker line; after writing, the issue is
read back and the marker must be present. Only then is the state moved to
`Done`, and the transition itself is read back. A repeated completion, a resume
or a replayed journal therefore posts nothing and moves nothing. Changed
answers produce a different revision and therefore exactly one new comment,
even after the issue was reopened — a stale comment from the earlier revision
is never mistaken for the new one.

**Ambiguity never repeats.** Before the comment leaves the process the record
is journaled `comment: "pending"`; an ambiguous response journals
`comment: "unconfirmed"` and the pass stops. Both states are ambiguous after a
crash (the write may have committed), so a later pass **reconciles by marker
first**: found means "posted" and the pass continues; not found means the pass
fails closed (`comment_pending`/`comment_unconfirmed`) and posts nothing,
including for a newer answer revision. An unresolved earlier intent must be
reconciled before any new revision is written. The same rule covers the
sub-issue creation intent: both `subissue: "pending"` and
`subissue: "unconfirmed"` are never retried, and the shared issue stays
untouched.

**State writes are targeted, not hoped for.** Progress is not write-only: a
`pending` task returns its issue to `Todo`, an `in_progress` task moves it to
`In Progress`, and a reopened task moves a `Done` issue back. Before writing a
state id, the resolved project/team must equal the issue's actual team and
project, or the pass records `state_target_mismatch` and writes nothing; every
transition is read back. Completion still requires the accepted-completion
check first: a completed task with an unanswered question never closes its
issue.

**Classification stays minimal.** Only a task with no parent, or one explicitly
marked `metadata: {"hoja": "publish"}`, is a unit of filed work; every other
child task is a granular step and stays local. A promoted child becomes a
sub-issue of its parent's issue, and its questions live in its own block — the
parent's block is never reused for the child's content.

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

- `linked` — the issue exists and was read back. `lifecycle.scope` says whether
  this session may write to it (`owned`) or only beneath it (`adopted`), and
  the optional `lifecycle.{comment,closed,subissue,error}` fields record the
  last sync pass.
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
issue with `hoja_list`/`hoja_get` and links it with `metadata.hojaIssue`. The
adopted issue itself is never written to; lifecycle sync goes to a session
sub-issue beneath it. Publication never creates a second issue on its own.

## What the model is told

Publication runs inside the `tool_result` handler, which returns a Pi content
patch: one extra text block listing the linked identifiers and, for every task
that was not published, the reason plus the concrete next step (for example
"confirm the exact name with `hoja_list` and set `metadata: {"hojaProject": …}`
on a later TaskManage update"). `details` is deliberately left untouched, so
the structured batch the host stored is unchanged. A notification alone would
be invisible to the model, and a silent skip is how an agent keeps believing
work was filed when it was not.

A missing project adds one bounded `Hoja recovery` block to the same result: up to 12 discovered projects with descriptions and team keys, evidence-first resolution guidance, an explicit ban on position/name-similarity guessing, and a statement that work is not blocked. It is emitted at most once per task per chat (`hoja-recovery` journal entry) and once per chat for discovery attempts.

Reason guidance covers `no_project`, `project_unresolved`, `state_unavailable`,
`invalid_hoja_metadata`, `invalid_hoja_issue`, `issue_not_found`,
`lookup_failed`, `create_failed`, `parent_unpublished`, and the unconfirmed
case. Lifecycle outcomes are appended separately (`Hoja lifecycle: …`): one
line for every recorded lifecycle error and one for each issue that reached
`Done`, so "linked" never stands in for "kept current".

## Session safety

- **Serialized.** Batches are chained, one at a time, so a second TaskManage
  result always observes the first batch's associations instead of racing it
  into a duplicate issue.
- **Generation guard.** `/hoja off`, `/hoja on`, `session_start` and
  `session_shutdown` bump a generation counter. A batch captures it and stops
  before its next writer call and before its next journal write, so an
  in-flight batch from a chat that went away can neither start new writes nor
  journal into the new chat. An intent already journaled stays `reconciling`
  and is reconciled by the next attempt. The same guard is checked before every
  lifecycle write (description, comment, state) and before the pre-write
  journal of a comment or sub-issue.
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

- **Live verification achieved (2026-11-02).** The full path was exercised
  through normal TaskManage calls on team `TREBOL`, project `Trebol`, with no
  hand-written API write: `TREBOL-577` was backfilled from `Todo` to `Done`
  with its three questions and one answer comment; `TREBOL-581` synced
  progress and its four questions (`In Progress`); a promoted child
  (`TREBOL-582`) was created under `TREBOL-581`, completed to `Done` with one
  comment per answer revision, and the parent stayed `Todo` and untouched
  throughout. Independent read-only checks (a HojaClient read and the parent's
  own inspection) confirmed `Issue.parent = TREBOL-581`. Remaining unverified
  paths are the negative ones: an ambiguous comment or sub-issue write, a
  parent in a different team/project, and a server that normalizes the
  description (which fails closed as `description_unverified`).
- **"Accepted completion" is local.** A task closes its issue only when the
  TaskManage result succeeded, `status` is `completed`, and every acceptance
  question has an answer. A completed task with an unanswered question records
  `completion_unaccepted` and stays open.
- **Comments are for completion only.** Progress is the managed `Status:` line,
  not a comment stream, so issue comments stay a record of accepted outcomes.
- **A crash mid-comment or mid-sub-issue is never auto-retried.** The journaled
  `pending` state is ambiguous by design: the next pass reconciles by marker
  and otherwise fails closed, so a human must check the issue (`hoja_get`) or
  link the found issue explicitly.
- **Ownership is a line, not a mention.** Editing the `Link marker:` line in an
  issue takes ownership away from the task; lifecycle then records
  `shared_unowned` instead of writing.
- **State ids are only written to the issue's own team/project.** A chat
  selection pointing at another project cannot move a linked issue's state
  (`state_target_mismatch`); the description is still synchronized.
- **Comment dedupe reads the most recent 100 comments** (`readIssue`), so the
  answer marker could in principle fall outside that window on a very busy
  issue. One comment per task keeps this far from the limit in practice.
- **No optimistic concurrency (no CAS).** Writes are serialized per chat, but
  there is no revision precondition on `issueUpdate`/`commentCreate`: two
  sessions writing the same issue can interleave. Marker dedupe protects
  against a session's own retries, not against a concurrent writer.
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
  .pi/test/tools/hoja-lifecycle.test.ts .pi/test/tools/hoja-mode-restore.test.ts \
  .pi/test/claw/session-mode-restore.test.ts
npx vitest run .pi/test/claw
npx tsc --noEmit --strict --target ES2022 --module NodeNext --moduleResolution NodeNext \
  --skipLibCheck --allowImportingTsExtensions --types node \
  .pi/lib/claw/hoja.ts extensions/hoja-mode/lifecycle.ts \
  extensions/hoja-mode/publish.ts extensions/hoja-mode/extension.ts
```
