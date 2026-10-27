# Codex apply_patch comparison

## Port status (2026-10-21, executable oracle)

Upstream oracle: **built and executed**. Pin: openai/codex
`430a16799d90e296fb27b1e94f206023902b7e56`, Rust `1.99.1` (task-local
toolchain under `artifacts/patch-parity/toolchain`, not global), `cargo build
--locked` of `codex-apply-patch`. Sparse `codex-rs` checkout at the pin, no
local edits to upstream sources. Two binaries:

- Writer: `codex-rs/target/debug/apply_patch` (upstream standalone executable).
- Agent path: `codex-rs/target/debug/examples/trebol_oracle`, a harness in
  `tools/experiments/patch-parity/oracle/trebol_oracle.rs` that runs upstream
  `maybe_parse_apply_patch_verified` (no writes), then `apply_patch_with_options`
  only on success. Exit 0 applied, 3 verification rejected, 1 execution failure.
  Build: `tools/experiments/patch-parity/oracle/build-oracle.sh`.

Differential suite `tools/experiments/patch-parity/differential.ts`: 51 cases,
each run in agent mode (oracle agent path vs `applyPatch`) and writer mode
(oracle writer vs `applyPatchStandalone`). Compared: outcome class and the full
final tree (bytes, mode bits, symlink targets). **Result: 102/102 match.**

Divergences found by the oracle and fixed in this port:

- Move onto its own source: upstream writes then removes the path, deleting the
  file. Trebol now matches (previously an in-place update).
- Workspace self-prefix path healing removed. Upstream rejects `ws/file.txt`
  when only `file.txt` exists. Healing was not an authorized difference.
- UTF-8 BOM: `TextDecoder` stripped it on update. Now kept (`ignoreBOM`).
- Delete: writer execution deletes a non-UTF-8 file; agent verification rejects
  it (upstream reads delete targets as text during verification). Trebol now
  matches both.
- Empty patch: upstream fails at execution after verification. Trebol now throws
  an `ApplyPatchExecutionError` with no writes instead of a pre-verification
  error.

Verified-as-matching by the oracle (no change needed): invalid UTF-8 updates
(rejected in both), lone CR, mixed LF/CRLF, no final newline, unicode punctuation
matching, EOF anchors, dangling symlink updates, symlink update/delete/move
through links and directory ancestors, mode preservation for update, move and
overwrite, failure after earlier writes (earlier writes kept, no rollback).

Known exclusions (not parity; each is a Trebol extension or host policy):

- Upstream runtime sets `follow_symlinks=false` when a sandbox is required or
  bypassed. The oracle with `TREBOL_ORACLE_NO_FOLLOW=1` rejects or fails all
  link-touching writes (agent: 12 probe cases failed). Trebol has no sandbox
  context and keeps following links, so it does not mirror this policy. Parity
  claims apply to the follow-symlinks default only.
- Outside-workspace paths are allowed (external path permissions unchanged).
- Snapshots and manual Undo were removed on 2026-10-27 (1 Undo call across 354
  recorded sessions; `.swarm/snapshots` grew without bound). Earlier writes in a
  failed patch are not reverted; revert with git or a follow-up patch.
- JSON `{input, cwd}` adapter and `environment_id` rejection are Trebol
  extensions and are not upstream freeform grammar.
- Concurrency, crash consistency, Windows, and non-root permission failures are
  not tested. No agent-quality benchmark was run.

Superseded below: the "Keep rollback", "Keep ambiguity rejection" and
"Keep safety advantages" recommendations, and the "Virtual-state preflight"
row. Rollback and ambiguity rejection were removed by the port.

## Scope and verdict

Audit on 2026-10-21. **Trebol is not 1:1 with Codex.** Basic operations overlap,
but matching, byte preservation, validation and tool integration differ. This
does not establish which agent edits more successfully on real coding tasks.

Upstream: https://github.com/openai/codex at
`430a16799d90e296fb27b1e94f206023902b7e56`. Fetched full commit history with
blob filtering under ignored `artifacts/patch-parity/codex`. Initial checkout
failed; patch library and core tools were subsequently materialized selectively.
Do not interpret this reference clone's incomplete index as upstream deletions.
Trebol patch implementation was clean during inspection; other ongoing worktree
changes were preserved. No production implementation was changed by this audit.

## Side-by-side

Trebol observations below come from actual library probes. Codex behavior is
source-derived, not executed: this host has no Cargo or Codex binary.

| Area | Trebol | Pinned Codex | Recommendation |
| --- | --- | --- | --- |
| Add/update/delete/move | Supported, including overwriting Add/Move destinations | Supported | Keep; test output bytes, not just success |
| Whitespace / typographic punctuation | Tiered forgiving matching | Tiered forgiving matching | Broad overlap, not identical Unicode semantics |
| Repeated context / anchors | Rejects ambiguity | Chooses first matching location | Keep safer rejection as documented divergence |
| EOF-marked hunk | Falls back to non-EOF match | Search constrained to EOF | Fix ours to honor EOF intent |
| Missing blank context line | Repairs and applies | No equivalent repair in replacement search | Document/test intentional leniency |
| Uniform CRLF | Preserves CRLF | Preserves CRLF | Already overlaps |
| Mixed LF/CRLF | Converts entire result to CRLF | Preserves individual unchanged line endings | High-priority byte-preservation fix |
| Lone CR endings | Does not split into lines | Recognizes CR terminators | Add explicit coverage and support |
| Repeated source path | Chains operations; repeated summary entries | Agent-facing verification rejects duplicate resolved source paths | Decide compatibility; test aliases and move collisions separately |
| Failure handling | Virtual-state preflight, temp-file rename and rollback stack | Agent verification precedes sequential writer; writer reports committed deltas on failure | Keep rollback; strengthen failure reporting/tests |
| Tool input | JSON `{input,cwd}` | Freeform grammar-constrained patch; optional environment ID in multi-environment mode | Provider-specific enhancement, not a parser fix |
| Progress/results | Final text; extension returns empty structured details | Streaming patch events and committed-change tracking | Useful second-stage integration work |
| Filesystem policy | Direct Node filesystem; outside-workspace paths deliberately allowed | Executor filesystem, sandbox/approval context, conditional no-follow policy | Explicit policy design; do not silently restore workspace restriction |

Important correction to a low-level-only comparison: Codex's normal handler
calls `verify_apply_patch_args` before execution. It catches missing update/delete
sources and invalid update context before the writer runs. The standalone writer's
partial-success fixture does **not** prove the normal agent tool partially writes
on those same validation errors. Execution-time failures can still leave committed
changes, which Codex tracks. Trebol's rollback is not crash-atomic, and rollback
can itself fail; its unconditional all-or-nothing tool wording overstates this.

## Source evidence

Trebol:
- `.pi/lib/tools/swarm-apply-patch.ts`: matching/anchors 146–180; blank repair
  182–210; line-ending normalization 212–245; path resolution 248–287;
  snapshots and preflight/commit/rollback 306–415.
- `extensions/swarm-fs-tools/extension.ts`: tool registration and execution
  28–36, with text output and empty details.
- `.pi/lib/tools/swarm-fs-tools.contract.ts`: input schema and atomicity claim.
- `.pi/test/tools/swarm-apply-patch.test.ts`: deliberately permits outside-workspace
  writes at 100–110. This is not an accidental regression inferred from our probe.

Codex paths below are relative to the pinned upstream tree:
- `codex-rs/apply-patch/src/seek_sequence.rs`: EOF bound 29–34 and matching passes.
  Its fallback doc comment disagrees with executable code; this audit follows code.
- `codex-rs/apply-patch/src/text_file.rs`: `SourceFile::parse` and
  `apply_replacements`, preserving per-line endings and choosing first-seen ending
  for inserted lines.
- `codex-rs/apply-patch/src/invocation.rs`: verification loop 197–251, including
  duplicate resolved source-path rejection at 200–206.
- `codex-rs/apply-patch/src/lib.rs`: `apply_hunks_to_files` and committed delta;
  `tests/fixtures/scenarios/015_failure_after_partial_success_leaves_changes`.
- `codex-rs/core/src/tools/handlers/apply_patch.rs`: normal verification 322–365;
  streaming argument consumer 77–145.
- `codex-rs/core/src/tools/handlers/apply_patch_spec.rs`: freeform grammar spec.
- `codex-rs/core/src/tools/runtimes/apply_patch.rs`: sandbox context, conditional
  `follow_symlinks` 183–193, committed deltas 204–230.

## History and blame

Commit links retain upstream provenance. Dates are commit-log dates.

| Date | Commit | Evolution and applicability |
| --- | --- | --- |
| 2026-06-12 | [e26f734f91](https://github.com/openai/codex/commit/e26f734f91) | Unified patch parsing. Log/stat inspected; streaming/parser consolidation is a design lead, not an independently executed regression result. |
| 2026-08-10 | [a1c88e865d](https://github.com/openai/codex/commit/a1c88e865d) | Reject duplicate resolved paths during verification. Diff and current verification code inspected. Trebol currently accepts chained updates. |
| 2026-08-10 | [21aa552e87](https://github.com/openai/codex/commit/21aa552e87) | Introduced line-ending preservation, including mixed-ending fixtures. Blame attributes `mod file_update` wiring to this commit; current `text_file.rs` establishes behavior. |
| 2026-08-20 | [e3e5ad2847](https://github.com/openai/codex/commit/e3e5ad2847) | Hardened unsandboxed filesystem access. Blame attributes the `ApplyPatchOptions` application parameter to this change. Current runtime confirms no-follow is conditional, not a blanket ban on links. |
| 2026-09-02 | [fe140d4c8e](https://github.com/openai/codex/commit/fe140d4c8e) | Authorization in executor path context. Log/stat and current integration inspected; full historical diff not reviewed. |
| 2026-09-24 | [6f51c65958](https://github.com/openai/codex/commit/6f51c65958) | macOS system-alias permission matching. Log/stat lead for `/var` versus `/private/var` regression cases; no historical execution reproduced. |
| 2026-10-05 | [685270a56a](https://github.com/openai/codex/commit/685270a56a) | Made line-ending preservation unconditional; diff inspected. Ours matches uniform CRLF, not mixed endings. |

Local history records deliberate removal of the workspace restriction in
`dfe992a` (2026-10-10). Workspace confinement and symlink safety are separate
decisions: allowing external paths does not require abandoning symlink-aware
authorization. Do not equate that local change with the inverse of Codex's
conditional no-follow design.

## Recommended sequence

1. **Preserve bytes:** port the per-line-ending model, test mixed LF/CRLF, CR,
   terminal newline and BOM handling. Unchanged lines must retain original bytes.
2. **Honor EOF and clarify duplicate semantics:** reject non-EOF matches when
   marked EOF; explicitly choose whether sequential same-file edits remain a
   supported extension. Test normalized aliases and source/destination collisions.
3. **Keep safety advantages:** retain ambiguity rejection, snapshots and rollback.
   Fault-inject write/rename/delete/rollback errors; report exact committed/restored
   paths and narrow the atomicity promise. Include concurrency/crash limitations.
4. **Policy integration:** test approved external paths, symlinked ancestors,
   dangling links, macOS aliases and linked worktrees through the actual host.
   Add explicit authorization at the owning policy seam rather than copying
   Codex's executor architecture wholesale.
5. **Prove compatibility continuously:** run pinned Codex and Trebol on identical
   isolated fixtures, comparing status, file bytes, modes and remaining paths.
   Maintain a small allowlist of deliberate divergences. Only then benchmark real
   agent edit success, retries and token cost. Freeform input/progress can follow.

## Validation and limits

- Independently reran `npx vitest run .pi/test/tools/swarm-apply-patch.test.ts`:
  **9/9 passed**; output `artifacts/patch-parity/local-tests.txt`.
- Worker ran **22 Trebol behavior probes** using the real module:
  `node --experimental-strip-types artifacts/patch-parity/behavior-probe.mjs`;
  raw results in `behavior-probe.out.json` in that directory.
- Direct-library outside-workspace probe passed in a disposable temporary root:
  `npx vite-node artifacts/patch-parity/integration-probe.ts`; result in
  `integration-results.txt`. This is not proof of actual-host authorization.
- Codex was **executed** at the pin (see Port status). Differential parity: 102/102
  comparisons over 51 cases, run by `npx vitest run .pi/test/tools/swarm-apply-patch-oracle.test.ts`
  with `CODEX_TREBOL_ORACLE_BIN` and `CODEX_APPLY_PATCH_BIN` set (otherwise skipped).
  The older 25-scenario fixture runner (`tools/experiments/patch-parity/runner.ts`)
  checks upstream fixture expectations, not a live oracle.
  Not run: forced rollback, concurrency, cancellation, cross-platform or
  agent-quality benchmarks. No agent-quality claim is made.
- Worker notes `artifacts/patch-parity/{history,behavior}.md` are supplementary
  research. This report supersedes their early checkout-state descriptions,
  duplicate-path uncertainty and overly broad low-level atomicity comparison.
