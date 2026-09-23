# TaskManage (Pi-Swarm) vs tintinweb/pi-tasks — granular-call error analysis

External reference: `https://github.com/tintinweb/pi-tasks` @ `29180d72498bdd77d5601dc77a9093d25da42102`,
cloned to `/tmp/pi-tasks-ref`. Reference claims are read-only source observations, **not** executed.
All claims about our code cite `packages/tools/taskmanage/…#Lx-Ly`.

## 1. Granularity model — the core difference

| | Ours | Reference |
|---|---|---|
| Tool count | 1 multiplexed `TaskManage` (`src/task-manage.ts#L871`) | 7 flat tools: `TaskCreate`, `TaskList`, `TaskGet`, `TaskUpdate`, `TaskOutput`, `TaskStop`, `TaskExecute` (`src/index.ts#L624,699,765,836,965,1059,1110`) |
| Call shape | `{operations:[{key,op,…}], mode}` — batch envelope, 1..50 ops (`src/task-manage.ts#L98-L100`) | one flat object per call; parallelism via multiple tool calls in a turn (`src/index.ts#L670`) |
| Required per op | `key`, `op` (`src/task-manage.ts#L99`) | `subject`+`description` for create; `taskId` for update (`src/index.ts#L674-L680`, `#L917-L930`) |
| Validation layers | **two** — `swarmValidateTaskManageParams` pre-gate (`src/swarm-validate.ts#L157-L182`) then `TaskManager.validate` (`src/task-manage.ts#L454-L504`) | one, inside `execute`, mostly structural via TypeBox |
| Failure surface | pre-gate → thrown tool error; runtime → `{status:"failed",results:[…]}` (`src/task-manage.ts#L879-L889`) | text string, usually not flagged as an error (`src/index.ts#L938`) |
| Bad references | hard failure `not_found` (`src/task-manage.ts#L665`, `#L713`) | **warning attached to a successful result** (`src/task-store.ts#L285-L311`) |

The reference is *permissive and flat*; ours is *strict and batched*. Nearly every granular-call
error we see follows from that, amplified by the defects below.

## 2. Reproduced failures

Drivers: `/tmp/repro.mjs`, `/tmp/repro2.mjs`, `/tmp/repro3.mjs`, run against `dist/`. 11 distinct failures.

| # | Call | Error (verbatim) | Class |
|---|---|---|---|
| 1 | `create` with `subject` only | `operation a: new tasks require 1..12 task-specific acceptance questions` | semantic, runtime |
| 2 | `create` + `addNote` | `operation "c": field "addNote" is not valid for create; create the task first, then add the note with an update operation targeting taskId:{"ref":"c"}` | pre-gate, **legal per runtime allowlist** |
| 3 | `update` + `owner_id` | `operation "i": field "owner_id" is not valid for update` | pre-gate, schema advertises it |
| 4 | `list` + `include_audit` | `operation "x3": field "include_audit" is not valid for list` | pre-gate, schema advertises it |
| 5 | `update` unknown id | `task 999 not found` | referential |
| 6 | `update status:"completed"` without answers | `missing answers for question(s): q1 (done?)…` | semantic |
| 7 | duplicate `create` key | `duplicate operation key "dup": keys must be unique per operation` | pre-gate |
| 8 | atomic batch with one bad op | `operation was rolled back because the atomic batch failed` on the *good* op | atomic cascade |
| 9 | completed → `in_progress` | succeeds, **silently discards `answers`** (`src/task-manage.ts#L759`) | state loss, no error |
| 10 | two `update`s sharing a key | pre-gate OK, runtime OK — last write wins, no diagnostic | layer divergence |
| 11 | `create` without `questions` | pre-gate **OK**, runtime **fails** | layer divergence |

Atomicity held: after the failed atomic batch, `list` showed no orphan task (repro2, "after atomic - list").

## 3. Ranked defects

### D1 — Two validators with different allowlists (severity: blocks granular calls)

`src/swarm-validate.ts#L17-L22` and `src/task-manage.ts#L458-L462` each define per-op allowed
fields, and they disagree with each other and with the declared schema:

| field | pre-gate | runtime | declared JSON schema |
|---|---|---|---|
| `create.addNote` / `create.noteType` | rejected (`swarm-validate.ts#L18`) | **allowed** (`task-manage.ts#L459`) | allowed (`task-manage.ts#L107-L112`) |
| `update.owner_id` | rejected (`#L19`) | rejected (`#L460`) | allowed (`#L108`) |
| `list.include_audit` | rejected (`#L21`) | rejected (`#L462`) | allowed (`#L112`) |
| `create.questions` required | not enforced (`#L124-L140`) | **enforced** (`#L498`) | not required (`#L99`) |

The model reads only the declared schema. Every row above is a field the schema advertises and a
validator then refuses — failures 2, 3, 4 and 11 are exactly these rows. This one defect explains 4
of 11 reproduced failures and is the most likely source of the granular-call complaint, because the
refused fields are precisely the optional ones reached for during fine-grained updates.

**Minimal fix:** derive both allowlists from one exported constant, and make the declared schema
`op`-conditional (a `oneOf` discriminated on `op`) so an invalid field cannot be emitted at all.

### D2 — `create` requires acceptance questions but the schema does not say so (severity: blocks)

`src/task-manage.ts#L498` rejects any `create` without 1..12 questions. The JSON schema lists
`questions` as an ordinary optional property (`#L113`) with no `op`-conditional requirement, and the
tool description (`#L871`) calls them "Optional compact questions". Failure 1 is the single most
frequent granular-call error: the natural minimal create is rejected, and the message names a
constraint the model was explicitly told was optional.

**Minimal fix:** state the requirement in the schema and description, or demote it to enforcement at
`completed` only. The reference has no analogue (`src/index.ts#L674-L680`).

### D3 — Pre-gate throws, runtime returns a batch (severity: degrades)

`src/task-manage.ts#L881` throws `Error executing TaskManage: validation failed…`, while the runtime
path returns `{status:"failed",results:[…]}` (`#L595`, `#L608`). Two structurally different failure
shapes for the same class of problem: the thrown form loses `key`, `op` and the per-op `code`, so a
50-op batch can die on one bad field with no indication of which operation offended or which
survived. Failures 2, 3, 4 and 7 all take the lossy path.

**Minimal fix:** render pre-gate failures in the same batch envelope — offending op `failed`, the
rest `skipped`.

### D4 — `answers` silently dropped on reopen (severity: degrades, data loss)

`src/task-manage.ts#L759` sets `answers: … (op.status !== undefined && op.status !== "completed") ? undefined : …`.
Reopening a completed task to `in_progress` erases previously supplied answers with no diagnostic
(failure 9, confirmed by `get` before and after in repro3). The next completion then fails with
`missing answers for question(s)`, which reads to the model as a spurious error.

**Minimal fix:** retain `answers` across reopen; clear only when `questions` actually change.

### D5 — Duplicate-key rule differs between layers (severity: cosmetic → degrades)

Pre-gate `src/swarm-validate.ts#L170-L177` permits a repeated key when the follow-up is an `update`
carrying an explicit `taskId`; runtime `src/task-manage.ts#L614` uses a different predicate.
Failure 10 passes both and silently last-write-wins, so `key` is not a reliable correlation handle.

## 4. Reference behaviours we should NOT adopt

- **Warnings instead of errors for missing dependency targets** (`src/task-store.ts#L285-L311`):
  `addBlockedBy:["999"]` succeeds and only appends `(warning: #999 does not exist)`. Our `not_found`
  (`src/task-manage.ts#L682`) is correct; a graph with dangling edges is worse than a rejected call.
- **No cycle rejection** — the reference warns `cycle: #a and #b block each other` and stores the
  edge anyway (`#L289`). We reject with `code:"cycle"` (`src/task-manage.ts#L696`, `#L729`). Keep ours.
- **"Task not found" as a success-shaped text result** (`src/index.ts#L938`) — indistinguishable
  from a successful update without parsing prose.
- **`description` mandatory on create** (`src/index.ts#L676`) — forces filler text on trivial tasks.
- **No atomic mode.** Our `mode:"atomic"` rollback works (repro2) and is worth keeping.

## 5. What the reference genuinely does better

1. **One tool per verb.** `TaskUpdate{taskId,status}` cannot be malformed the way a nested
   `operations[].op` envelope can. Batching only pays for itself when a turn mutates several tasks.
2. **One validation layer.** No schema/pre-gate/runtime triangle to keep in sync.
3. **Field-level diff in the response** — `Updated task #1 status, owner` (`src/index.ts#L955`)
   states exactly what landed. Our `updateAck` (`src/task-manage.ts#L781-L791`) is close but does
   not signal unchanged fields.
4. **No hidden required fields.** Everything enforced is visible in the TypeBox schema.

## 6. Recommended follow-ups

1. Single shared allowlist constant; generate the per-`op` JSON schema from it. (D1, and D3's inputs)
2. Make the questions-on-create rule visible in the schema, or relax it. (D2)
3. Preserve `answers` across reopen. (D4)
4. Unify the pre-gate failure envelope with the runtime batch envelope. (D3)
5. Optionally register thin `TaskCreate`/`TaskUpdate`/`TaskList` aliases over the same manager for
   single-task turns, keeping `TaskManage` for real batches.
