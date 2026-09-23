# Live memory_history recall after reload

## Agent-facing calls and source comparison

1. `memory_history(recall, scope=worktree, status=candidate, mode=topical, query="CapabilityManifestState.apply", limit=1)` returned `status=ok` with **only** `48b544e64653fb3827c566999a17400e`. Its excerpt answers where request-scoped capabilities are injected and cites `.pi/lib/runtime/swarm-transport-parity.ts#L283-L335`. Direct `memory_history(get)` returned the same worktree candidate ID/revision `d54c2d6ecb5fb594fc4d263b74272fcd` and answer. The citation matches the inspected implementation; it remains a candidate, not independently verified.
2. The same topical query with `limit=2` returned only that one directly supporting Q&A—no retrieval-evaluation meta records. This is better than the pre-fix `limit=1` call that returned four records. The model's note explicitly calls it a candidate lead.
3. `memory_history(recall, scope=repository, status=verified, mode=topical, query="PageIndex", limit=1)` returned the verified architecture decision `a7592845-442f-45a4-aca8-7c4c04ba530f` despite the focused task being this recall recheck. Direct stored revision remained `35b8e829bde4cbb7cbc817a44e712066`. Explicit topical intent now works in this case.
4. `memory_history(recall, scope=worktree, status=candidate, mode=task, query="memory_history recall limits", limit=2)` returned two **meta TaskManage records**, but these describe a test matrix and an observation that noise was filtered—not the current limit implementation. The read-only agent labeled them unverified leads. This is still a relevance-quality weakness for genuine mechanism queries; the meta-filter deliberately exempts those queries.
5. `memory_history(recall, scope=worktree, status=candidate, query="Where does a hypothetical non-existent quasar spool 934582 live?", limit=2)` returned `no-result`, `knowledge=[]`. A verified-only worktree query for `CapabilityManifestState.apply` also returned `no-result`. Both are honest absences, not observed model errors. Invalid `limit=0` and `limit=13` were rejected with `recall limit must be 1–12`.

## Contract and safety

The live results match `.pi/extensions/40-state/memory-history.ts#L177-L188` and `.pi/lib/context/memory-agent.ts#L47-L84`: validated limit, topical default or explicit task mode, bounded read-only selection, and distinct `ok`/`no-result` outputs. The worker only exposes snapshot-backed browse/read/select (`.pi/lib/state/memory-retrieval-worker.ts#L12-L34`). After the calls, direct store inspection showed the target Q&A still candidate at the same revision and the PageIndex decision still verified at its same revision. This is evidence for those two records, not a universal no-mutation proof.

I did not trigger a live model timeout, unavailable provider, abort, malformed selection, or cross-project scope attempt. Their code paths exist but their live behavior is untested in this recheck. The tool returns no child-call transcript, so I can judge selected content and status, not every internal browse/read action.

**Verdict:** the reload applied the limit and topical fixes end-to-end. Ordinary direct lookup is concise and useful; task-guided mechanism lookup can still favor self-referential progress records over primary implementation evidence.
