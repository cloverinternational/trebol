# JEV autogen compaction smoke

Run `node tools/experiments/jev-audit/compaction-smoke.mjs` from Pi-Swarm.

This starts installed `pi --mode rpc` in temporary HOME, workspace, session,
and autogen directories. A scripted OpenAI-compatible provider binds only to
`127.0.0.1` (no paid calls). It drives real `TaskManage` and `bash` calls,
then sends the documented RPC `compact` command. The script reads the actual
persisted session JSONL, requires a real `compaction` entry, compares baseline
and post-compaction autogen `toolCalls`/`budgetCalls`, and starts a second Pi
process on the exact session file to prove reload. It rejects a mere
`session_compact` event. Temporary state is removed in `finally`; watchdogs
bound RPC waits and the overall CLI operation to 90 seconds.

A passing result requires `realCompaction: true`, non-null count objects, and
`countsPreserved: true`.

Parent rerun corrected the initial fixture: TaskManage was absent, the session was
not compactable, and reload previously created a different session. Current smoke
uses actual RPC compact with nonzero budget: toolCalls4/budgetCalls3 before and
after, a real compaction entry, and exactSessionReload:true. It does not yet query
the reloaded in-memory manager's budget; that stronger metrics probe timed out.
Count persistence and session identity are verified, reload enforcement itself is
still covered by unit tests rather than this wire probe. Child cleanup is awaited.
