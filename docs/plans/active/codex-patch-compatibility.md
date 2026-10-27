# Codex local patch compatibility

## Decisions

User selected exact Codex compatibility, including execution-time partial-write
semantics, rather than preserving ambiguity rejection or automatic rollback.
Baseline: openai/codex `430a16799d90e296fb27b1e94f206023902b7e56`.

Target the local agent-facing parse → verify → execute path. Do not confuse the
standalone writer with normal agent verification. Preserve Trebol's JSON tool
adapter, user-approved external-path behavior, snapshots and manual Undo as
explicit integration extensions. Remote environments, provider freeform grammar,
streaming UI and Codex sandbox infrastructure are outside this change. Therefore
completion means tested local patch compatibility, not whole-product identity.

## Sequence and dependencies

1. Recheck status and instruction files; preserve unrelated edits. Inventory all
   callers, parser consumers, tests and tool-contract captures before changing
   exported patch types. Inspect upstream parser, streaming parser, matcher,
   text-file model, verification and execution at the pinned revision.
2. Establish an executable upstream oracle. Check existing build/container/remote
   options before installing anything. If necessary, request approval for a local
   Rust toolchain installation. Build pinned upstream and a minimal harness that
   invokes its actual verification and execution APIs against temporary files.
   A different installed Codex release or hand-translated algorithm is not an
   oracle. If blocked, record the blocker and do not certify differential parity.
3. Build a reusable fixture runner in `tools/experiments/patch-parity/` and focused
   tests under `.pi/test/tools/`. Record upstream SHA and fixture provenance;
   preserve required upstream licensing notices for copied fixtures/code. Compare
   acceptance, final bytes, remaining paths, summaries and failure-time committed
   changes. Separate parser, verifier and writer expectations.
4. Implement parsing/matching compatibility: first-match tier ordering; exact
   upstream whitespace/Unicode semantics; anchor behavior; EOF bounds; insertion
   and trailing-empty handling; malformed/empty inputs. Remove Trebol-only blank
   repair, substring/multiline anchor extensions and conflict-marker restrictions
   where verified to diverge. Validate duplicate resolved source paths before
   writing. Test aliases and move collisions against upstream rather than assuming
   duplicate-source detection covers destination collisions.
5. Implement per-line ending preservation, including LF/CRLF mixtures, lone CR,
   empty files, terminal-newline behavior, BOM and inserted-line ending selection.
   Keep decoding behavior consistent with upstream; probe invalid UTF-8 rather
   than accepting Node's replacement decoding by accident.
6. Separate verification from sequential execution. Verification reads original
   filesystem state as upstream does, not a virtual chain of earlier operations.
   Execution follows upstream operation order and failure behavior. Remove
   automatic rollback; report successful prior changes on failure and never print
   unconditional success. Retain snapshots/manual Undo without reverting partial
   changes automatically; specify snapshot-failure behavior as an extension.
   Inspect upstream mode/symlink/write details before retaining temp-rename writes
   that could change observable filesystem semantics.
7. Update the extension's result/error handling and tool description: remove the
   all-or-nothing promise, preserve failed-tool signaling, expose accurate partial
   outcomes without breaking existing callers. Update affected contract tests,
   AGENTS.md and the audit with the new behavior and remaining exclusions.
8. Run focused tests, pinned upstream differential fixtures and fault injection;
   then relevant filesystem/runtime/contract suites and build/type checks.
   Review diff for unrelated modifications and report exact commands, results,
   upstream pin and remaining unverified platform cases.

Steps 4–6 depend on the upstream expectations established in steps 1–3. Step 7
depends on the failure-result shape from step 6. No parity claim precedes step 8.

## Risks and impact

- First-match behavior intentionally removes a safeguard: duplicated context can
  now edit the first location. Lock this user-selected change into regression tests.
- Removing rollback intentionally permits partial changes after execution errors.
  Distinguish validation failures (no writes) from write-time failures (prior writes
  remain). Test both and make the tool contract explicit.
- Parser exports may feed policy classification or tests. Find consumers before
  changing shapes; keep policy decisions outside matching code.
- Per-line ending records must survive chunk replacements without shifting offsets
  or rewriting unaffected context. Test multiple hunks and no-final-newline files.
- Move failures may leave a written destination and retained source. Report actual
  disk state; do not infer committed changes from the intended operation list.
- Snapshots, modes, symlinks, invalid UTF-8 and concurrent writes can expose hidden
  differences. Test representative cases and label unsupported equivalence; do not
  silently alter external-path authorization or claim crash consistency.
- Permissions-based failure tests may be unreliable under privileged users. Use
  deterministic filesystem fault injection and a real-filesystem scenario.
- The pinned Rust workspace has substantial dependencies and the clone is partial.
  Build/network failure blocks certification, not an excuse to substitute guesses.

## Acceptance

- The pinned oracle and Trebol agree across the supported local fixture corpus,
  with every integration-only exception enumerated and justified.
- Matching, duplicate verification, mixed endings and execution failures have
  regression tests, including first-match success and retained partial changes.
- Normal verification failures leave target files unchanged; execution-time
  failures preserve and accurately report earlier writes as upstream does.
- Snapshots/manual Undo remain tested, but automatic rollback and the atomicity
  promise are removed.
- No production claim of full Codex parity without actual upstream execution;
  remote/sandbox/provider/UI exclusions remain visible.

## Status (2026-10-21)

- Steps 1-2: done. Rust 1.99.1 installed task-local under `artifacts/patch-parity/toolchain`
  (not global). Upstream sparse `codex-rs` checked out at the pin; `cargo build --locked` of
  `codex-apply-patch` (writer `apply_patch` and `examples/trebol_oracle`) succeeded.
  Build script: `tools/experiments/patch-parity/oracle/build-oracle.sh`.
- Steps 3-7: done. Differential driver `tools/experiments/patch-parity/differential.ts`
  (51 cases x agent/writer = 102 comparisons): 102/102 match after the self-move, path-healing,
  BOM, delete-decoding and empty-patch fixes recorded in the audit.
- Step 8: differential and regression tests in `.pi/test/tools/swarm-apply-patch-oracle.test.ts`
  (179 apply_patch tests passing across three files). Audit updated.
- Remaining exclusions (not parity): conditional upstream `follow_symlinks=false` policy
  (probed via `TREBOL_ORACLE_NO_FOLLOW=1`, not mirrored), outside-workspace permissions,
  JSON adapter, `environment_id`, concurrency/crash, Windows, benchmarks.

> 2026-10-27: snapshots and the `Undo` tool were removed entirely (1 Undo call in
> 354 recorded sessions; `.swarm/snapshots` grew without bound). References above
> to retaining them are superseded.
