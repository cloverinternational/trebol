# TaskManage reference contract

This package ports the upstream `internal/tools/ii` task contract into a Pi-safe,
standalone TypeScript adapter.

## Compatibility slice

- Task IDs are stable strings and are journaled through Pi session entries.
- Task status is `pending`, `in_progress`, `completed`, or `deleted`; at most one
  task is active/focused.
- Priorities match upstream `TodoPriority`: `low`, `medium`, and `high`; omitted
  priority defaults to `medium` and is included in task reads/lists.
- Categories, dependencies, parent links, typed notes, audit history, ordered
  batches, sequential/atomic rollback, and operation-key references are preserved.
- Hook enforcement defaults to advisory mode. Blocking is opt-in, and read-only
  exploration plus subagents remain exempt as in the upstream enforcement hook.

The implementation is intentionally offline: Pi's structural API is injected and
all state is rehydrated from journal entries. No provider credentials or network
services are required for tests.

## Deliberate boundaries

This slice does not implement upstream's Go hook registry priority ordering or
compaction-time Todo tool. Pi extensions are registered in load order, so
`TaskHooksCoordinator` is the deterministic lifecycle coordinator for this
adapter. Future work can add explicit hook priority metadata without changing the
TaskManage wire schema.

## Saved answers and evidence

Saved answers are reused for unchanged question IDs and text. Supplied answers
merge by ID; rewording/removing a question invalidates its answer, while reordering
and reopening do not. Completion revalidates every reference and still requires
all questions and children to be satisfied. An omitted answers field is valid;
an explicitly empty array is not. Unknown supplied question IDs are rejected.

References are existence/availability checks, not semantic proof of a claim.
Files must remain inside the workspace, linked worktrees or host-authorized
`evidenceRoots`, including after realpath resolution. Host integrations can pass
`canReadEvidence` to enforce additional restrictions; task arguments cannot grant
permissions. `registerTaskManageExtension(..., {evidence: {...}})` exposes these
host options, not a model-facing authorization mechanism. Default registration
does not grant extra roots.

Tool references use exact current-branch result names and per-tool indices.
Integrations may supply explicit `toolAliases`; ambiguous mappings fail closed.
The registered adapter persists successfully resolved aliases as canonical names,
so later alias configuration does not retarget saved answers. No global case-fold
or MCP-prefix stripping occurs. Default registration invents no aliases.

Rejected operations remain atomic. Save a note on a blocked pending task in its
own operation rather than coupling it to activation. Sequential batches retain
the successful prefix; atomic batches roll back all state changes.

The legacy `resolveEvidence` callback is an exclusive trusted resolver. Combining
it with `evidenceRoots` or `canReadEvidence` is rejected; hosts must use either
complete custom resolution or built-in containment plus policy. Worktree discovery
is cached only within one execution batch and refreshed on the next call.
Retained historical alias references are deliberately not migrated using a new
alias map: without their original mapping that could change what they cite.
Resubmit a verified canonical citation when a historical alias no longer resolves.
