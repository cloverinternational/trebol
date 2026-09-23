# Task-guided mechanism retrieval: primary evidence

## Reproduced failure

Live `memory_history(recall, mode=task, scope=worktree, status=candidate, query="memory_history recall limits", limit=3)` returned `invalid-selection` (no valid `memory_select` receipt). Directly browsing the same PageIndex projection produced twelve TaskManage cards, all summaries of previous retrieval evaluations. The top card `4eebcab45b6b147d0af91299a1d6bdbc` said recall validates scope and limit and cited `.pi/extensions/40-state/memory-history.ts#L174-L188`, but the agent was given only the *summary and citation*, not the file lines. Several other cards described test matrices and prior tool outputs. The actual cited code existed on disk; primary evidence was inaccessible to the worker, not absent from the workspace. See `.pi/lib/context/knowledge-pageindex.ts#L101-L118` and `.pi/lib/context/memory-agent.ts#L51-L65`.

## Change and observed results

- `.pi/lib/context/knowledge-source-evidence.ts` resolves **only preexisting cited workspace-relative file#Lx-Ly ranges**, bounded by file size, line count, excerpt size and count. It rejects paths outside the workspace, non-source file extensions, runtime stores and missing/out-of-range files. The operation is read-only and does not elevate a candidate to verified status.
- For a task-guided mechanism query, `.pi/lib/context/memory-agent.ts` attaches those bounded primary excerpts to source cards. It requires a selected implementation card to have a readable cited excerpt, rather than accepting a summary with a bare path. The isolated worker still only has `memory_browse`, `memory_read`, `memory_select`; the parent still validates keys/limit/status and returns original record citations.
- Actual isolated Luna query `memory_history recall limits` selected cards with direct excerpts of `.pi/extensions/40-state/memory-history.ts#L174-L188` (scope and limit validation) and a worker implementation excerpt. Raw result: `.swarmpi/task-memory-import/mechanism-primary-live-1790182000.jsonl#L1`. The selected cards remain worktree candidates; the inspected source code supports the stated limit handling, but a citation alone would not.
- A query explicitly about `memory_history recall limits evaluation` still returned a TaskManage card with a readable primary excerpt (`...jsonl#L2`), so evaluation history is not blanket-hidden. A nonexistent topic returned `no-result` with no selected IDs (`...jsonl#L3`). Worktree event-file count was identical before/after (`...jsonl#L4`).
- At the parent selection boundary, injected selection of a card with no readable implementation was rejected as `invalid-selection`, an over-limit selection was rejected, and provider failure returned `model-failure`; all returned empty knowledge. The focused context/memory integration suites passed. These injected failures do not prove live provider failure behavior.

## Remaining caveat

This active session loaded the `memory_history` extension before these edits. The outputs above used the updated library and a real isolated Luna worker, **not** the already-loaded agent-facing tool. After `/reload`, the exact mechanism query must be rechecked through `memory_history` itself. The worker still sees only the first twelve pre-ranked cards; the quality of its shortlist for other mechanism topics is unmeasured.
