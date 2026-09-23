# Memory recall: limit, meta-noise and explicit topic

## Live pre-change evidence

On the reloaded `memory_history` interface, `recall(scope=worktree,status=candidate,query="CapabilityManifestState.apply",limit=1)` returned **four** records, including three TaskManage questions about our own retrieval evaluation. The actual implementation Q&A is `48b544e64653fb3827c566999a17400e`, worktree candidate revision `d54c2d6ecb5fb594fc4d263b74272fcd`, with `.pi/lib/runtime/swarm-transport-parity.ts#L283-L335` evidence. `recall(scope=repository,status=verified,query="PageIndex",limit=1)` returned `no-result`: the model preferred its focused task over the explicit topic despite a verified architecture decision existing (`a7592845-442f-45a4-aca8-7c4c04ba530f`).

## Updated code and observed calls

1. `.pi/lib/context/memory-agent.ts` computes `maxReturn=min(requestedLimit ?? 5,5)` after validating 1–12. It passes that cap to the isolated worker snapshot, tool schema and prompt, then checks the model response against it. The twelve-card search shortlist remains independent of the returned-record cap. Direct Luna call with `limit=1` returned only the original implementation Q&A; `limit=2` returned only that card because the second was tangential. Zero, 13 and fractional limits returned `invalid-limit`; a forged two-card selection under limit one returned `invalid-selection` with no evidence.
2. `.pi/lib/context/knowledge-pageindex.ts` now filters narrowly identified TaskManage retrieval-evaluation subjects/questions for ordinary topical recall. On the real store, `CapabilityManifestState.apply` produced only the original substantive Q&A with `excludeMeta=true`, versus five cards without it. A query explicitly about `memory_history recall limits` still exposed mechanism records. This avoids wholesale exclusion of records just because they contain “memory.”
3. `.pi/lib/context/memory-agent.ts` now defaults explicit queries to `mode=topical`: the query takes precedence over unrelated focused-task context. `mode=task` remains available for task-guided ranking among query-responsive evidence. The real isolated Luna agent returned the verified PageIndex decision under `mode=topical,limit=1` despite a focused memory-retrieval task. Task mode with a mechanism query returned two candidate task records relevant to limits.

The post-change live isolated agent outputs are recorded at `.swarmpi/task-memory-import/repaired-recall-live-1790179500.jsonl` lines 1–6. Line 1 is the original Q&A under limit one; line 2 repeats the topical query under limit two without meta noise; line 3 is the verified PageIndex decision; line 4 exercises task mode; line 5 is an honest no-result for the absent quasar question; line 6 records identical worktree event-file counts before/after. A direct store read after those calls still showed the Q&A as worktree candidate and the PageIndex decision as repository verified at their original revisions.

## Failure distinction and remaining work

At the parent selector boundary, injected responses yielded `no-result` for supported=false/empty, `invalid-selection` for a forged key and for over-limit output, and `model-failure` for an unavailable provider; all returned empty knowledge. The focused extension suites passed (22 checks). These injected failure responses do not prove the live provider will produce each case.

The current session’s agent-facing `memory_history` tool was loaded before these edits; the observed post-change Luna calls used the updated library and isolated worker directly. Another `/reload` is required to verify the new limit/mode/schema through the actual `memory_history` tool. The agent still cannot browse beyond twelve pre-ranked cards, and ranking quality beyond the inspected queries remains unmeasured.
