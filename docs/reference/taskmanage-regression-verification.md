# TaskManage regression verification

## Scope and results

Branch: taskmanage-evidence-regressions. Baseline: 62a3fb2.
Implementation lives in the linked trebol-taskmanage-evidence checkout, not main.

- Initial direct diagnostic slice: 4 tests failed before production edits.
- Final 28 new regression/control tests against untouched baseline in detached
  /tmp/trebol-taskmanage-baseline: 14 failed, 14 passed. This is a retrospective
  sensitivity check, not a claim all 28 were originally captured before edits.
- Final focused suite: 134 passed across 9 files.
- Full workspace build passed; final TaskManage package build passed.
- Full suite comparison before the final two additional controls: branch 41
  failed/866 passed; baseline 41 failed/840 passed. Failing headings identical.
  Full suite is NOT green. Existing skips were not added by this work.
- The seven earlier hook failures came from inherited subagent environment;
  tests now explicitly isolate that environment and preserve bypass cases.

Logs are local ignored artifacts in docs/artifacts/taskmanage-evidence-regressions.

## Issue mapping

| Issues | Assertions / behavior |
|---|---|
| 176,184 | saved answer reuse, overrides, question change/reorder, replay, missing coverage |
| 173 | existing answers bounds/activation controls and evidence revalidation |
| 133,178,186,189 | exact and registered alias identity, branch/index controls, canonical persisted aliases, adapter roundtrip |
| 134,187,194 | explicit host roots, unauthorized roots, revoked access, symlink containment, heading/range/missing-file diagnostics |
| 169,193 | Unicode note validator acceptance, missing/non-array/empty operations diagnostics; original transport failure still unreproduced |
| 153,186 | real pending prerequisite, note-only updates, combined rejection, sequential prefix, atomic rollback, unchanged state |

## Implementation and limits

Host evidence configuration is injected via extension options; default wiring
intentionally grants neither extra roots nor guessed aliases. Actual external
transports must provide their verified aliases and access policy. No automatic
mcp-prefix mapping is claimed. Registered-adapter tests use structural fake Pi
session events, not a real provider/network transport session.

Canonical aliases are persisted when successfully resolvable at answer save or
completion. Historical unresolved aliases remain unresolved on replay rather
than being silently mapped under a changed configuration.

Evidence diagnostic reasons are internal strings appended to the existing error
message, not a new structured public error schema. Canonical suggestion lists,
complete permission/I/O classification, and all planned concurrency/cancellation
permutations remain follow-up coverage. File citations validate current existence,
not immutable content or semantic truth. Trusted host policy must supply any
additional sensitive-path restrictions through canReadEvidence.

Independent review could not be obtained: repeated delegated reviewers returned
unrelated Mermaid analyses. Parent directly inspected and ran tests. This is not
an independent PASS and changes are not merge-ready on that basis alone.

No push, merge, deployment, or GitHub issue closure was performed. Main remains
unchanged except the approved untracked plan; existing user files are preserved.

## Continuation: lifecycle and transport coverage

- New lifecycle slice first ran 2 failures / 2 passes: session switching retained
  stale tasks/results, and error messages lacked valid citation suggestions.
  Both are fixed. session_switch now rehydrates/rebinds like session_start.
- Another red regression demonstrated a deleted workspace root throwing instead
  of rejecting evidence; fixed with safe root discovery and IO reason handling.
- Added cancellation-before-create/completion, recovery, simultaneous tool-entry,
  same-turn result, current-branch and exact MCP-name controls.
- Exercised actual MCPManager discovery/registration/execution into TaskManage
  evidence with a deterministic mocked HTTP response. This tests repository
  transport code, not third-party adapters or a live remote service.
- Canonical suggestions are bounded to eight names (64 characters each), contain
  latest per-tool indices and never include tool output bodies.
- Full suite with repository-prescribed macOS TMPDIR=/private/tmp: 917 passed,
  9 existing skipped, zero failures before the final MCP integration test.
  An earlier run had one background-shell timing failure; its isolated rerun
  passed all 16 tests and the subsequent full run passed.
- Workspace build and diff whitespace checks passed.

The earlier 41-failure result used macOS's noncanonical /var temp path; use the
canonical-path result above for this host. Earlier limitations about missing
citation suggestions and absence of MCP registration coverage are superseded.
Independent review remains unavailable and has not been represented as a PASS.

## Final direct coverage audit

Final-commit full rerun initially passed 918 tests with 9 existing skips. Audit
then found a missing cancellation branch: an atomic batch cancelled after its
first successful operation kept that mutation in memory. Added a red regression
and fixed rollback in the atomic stopped path. Full rerun after that fix:
**919 passed, 9 skipped, zero failures**, 150 passing files / 7 skipped files.
TaskManage build and diff whitespace checks passed.

Remaining audit gaps (not claimed covered): live third-party adapter/provider
sessions, all host-policy integrations, canonical path identity under filesystem
TOCTOU changes, and exhaustive linked-worktree removal/recreation combinations.
No new aliases or extra roots are granted by default. Host configuration is an
explicit integration API, not a new user-facing permission workflow.

Independent review remains blocked by delegated agents returning unrelated work.
This report is direct implementation verification, not independent approval.

## Acceptance disposition

The user accepted direct verification with these documented limits and waived
independent review for task completion. This is not an independent review PASS.
The subsequent request authorizes pushing this branch and opening a new PR, not
merging or deploying it. Raw execution logs remain local ignored artifacts;
the verification counts, commands, baseline and limitations are recorded here.
