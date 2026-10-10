# TaskManage test-first redesign

## Approved scope

Cover all 13 reports: #133, #134, #153, #169, #173, #176, #178,
#184, #186, #187, #189, #193, #194. Demonstrate failing tests for
new behavior, retain passing safety tests, then implement fixes. Do not force
correct behavior to fail or close GitHub issues as part of this work.

User-approved decisions:
- Reuse saved answers for unchanged questions and merge supplied overrides by
  question ID. Revalidate every evidence reference before completion.
- Changed questions invalidate their own answers; unchanged/reordered questions
  retain answers. Removed questions contribute no answers. Reject unknown and
  duplicate supplied IDs; missing coverage still blocks completion.
- Allow workspace, linked worktrees, and explicitly authorized extra evidence
  roots. Authorization belongs to trusted host configuration, not task input.
- Keep each operation atomic. Separate note-only updates on blocked tasks work;
  combined blocked activation plus note changes neither state nor notes.
- Match exact tool names first, then explicitly registered transport aliases.
  Never blindly lowercase or strip MCP prefixes. Reject ambiguous aliases.

## Sequence and dependencies

1. Read full applicable AGENTS instructions and test contracts; record revision
   and dirty state. Preserve existing .local/ and .pi/mcp.json. Use an isolated
   implementation branch/worktree and verify command cwd throughout.
2. Re-run bounded existing suites and record the seven reported hook failures.
   Trace implementation before deciding if fixtures or behavior are wrong.
3. Trace actual exposure -> alias registration -> result persistence -> branch
   selection -> evidence validation -> completion -> hooks. Locate trusted root
   configuration. If absent, add a narrow host-owned seam, never a task field
   that can grant itself file access. Do not guess transport behavior.
4. Add issue-linked tests importing source, isolated temp fixtures, and actual
   assertions. Capture red baseline BEFORE changing production behavior.
   Separate new-contract failures, baseline failures, and setup errors.
5. Implement in slices: answer lifecycle; evidence diagnostics/root and alias
   integration; input diagnostics; hook recovery. Run each slice after changes.
6. Align schemas, prompts, documentation, and recovery messages. Check bootstrap
   consumers for contract compatibility, without unrelated bootstrap work.
7. Run focused suites, transport/persistence/hooks integration, typecheck/build,
   required repository checks, and independent review. Report limitations.

## Test matrix

### Completion, answers and persistence: #176, #184, #173
- Save then complete without resubmission; partial overrides; missing answers;
  duplicate/unknown IDs; malformed answers; added/changed/reordered questions.
- Reopen and persistence replay retain correct answers. Deleted files, changed
  headings/ranges, branch changes and revoked root access invalidate evidence.
- Omitted answers permits activation; explicit empty answers remains invalid
  with a useful correction. Legacy questionless tasks and unfinished children
  remain blocked. Rejected completion must not mutate task or audit state.

### Tool evidence: #133, #178, #186, #189
- Real adapter integration: exposed name -> stored result -> citation -> success.
- Exact names, registered aliases, unknown names, collisions, unrelated tools
  sharing suffixes, per-tool chronological indices, latest-result references.
- Zero/negative/out-of-range indices; calls without results; same-turn results;
  branch/session isolation, reload, cancellation before results, parallel calls.
- Recorded failure results may evidence failure: resolvability is not proof of
  success. Never treat a citation as semantic verification of an answer.
- Bounded canonical citation hints and distinct reasons; no raw tool contents
  or secrets in diagnostics. Alias changes cannot silently retarget evidence.

### File evidence: #134, #187, #194
- Relative/absolute/bare paths; headings/slugs and line ranges; actual temporary
  linked git worktrees; authorized vs unauthorized sibling repositories.
- Missing files/roots, directories, oversized files, symlink escapes, ../
  traversal, invalid/reversed/out-of-range lines, missing headings, mixed lists.
- Distinct reasons and permitted-root context without leaking file contents or
  probing unauthorized paths. Extra roots obey existing access restrictions.
- Permission revocation and worktree changes cannot pass through stale caches.
- Existence validates a reference, not its truth or historical content identity.

### Parsing and notes: #169, #193
- Real validation/execution roundtrip with accents, guillemets, quotes, HTML-like
  text, newlines, hash characters and realistic note length.
- Distinct missing/non-array/string/object/null/empty operations diagnostics;
  malformed operations and unknown fields remain rejected.
- Do not silently coerce arbitrary JSON strings. If valid shapes pass, preserve
  that result and label original report unreproduced; diagnostics tests may
  still be red. Do not fabricate original transport payloads.

### Dependencies and batches: #153, #186
- Note-only update on blocked pending task succeeds. Combined activation/note
  fails with no changes. Separate sequential note then activation persists only
  the note and reports skipped later operations; atomic mode rolls back all.
- Assert resulting state, notes, audit and persisted/replayed state, not only
  status strings. Completed dependencies permit activation; cycles remain denied.

### Hook integration and recovery
- Successful completion releases enforcement; rejection preserves pending work
  and produces actionable guidance. Read/list/repair operations remain usable.
- Session startup, focus change, replay, cancellation, subagent isolation, and
  serial/parallel result delivery do not create loops or lose tasks.
- Investigate all seven baseline failures separately. Never delete an assertion
  merely to make the suite green; justify obsolete expectations against contract.

## Breaking points and impact

Stale dist, empty fixtures, unconditional assertions and broad test discovery
can manufacture confidence: use source and assert fixture setup first.
Mock names alone miss transport bugs: include real adapter roundtrips.
Answer merging affects replay, question edits and prompts: test these together.
Aliases can collide and roots can widen access: preserve identity/authorization
boundaries, including realpath containment. Diagnostics must be bounded and
non-secret. Hook changes affect every task workflow and require integration
coverage. Concurrent worktree edits must not be overwritten.

## Acceptance and delivery

- Issue-to-test matrix identifies each reproduction, negative case, expected
  baseline outcome, final outcome and unresolved historical limitations.
- New-contract regressions demonstrably fail for intended assertions before
  fixes and pass afterward; safety/compatibility controls remain green.
- No skip, todo, expected-failure marker or unconditional assertion disguises
  a regression. Targeted hook failures resolved or explicitly reported blocked.
- Focused command starts with `npx vitest run packages/tools/taskmanage
  extensions/taskmanage tests/task-manage.test.ts`; verify actual discovery and
  add only inspected integration paths. Do not use a filesystem-root test scan.
- Verify schema/prompt/runtime consistency, typecheck/build and repository
  required checks. Independent reviewer checks the entire diff and test quality.
- No claim that finite coverage prevents all future bugs; document remaining
  unknown historical inputs and limits. No push, merge or issue closure implied.
