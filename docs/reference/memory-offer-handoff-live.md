# Explicit “remember that” handoff: observed behavior

## Interface and state

`memory_history(operation="offer", text, scope=repository|worktree, source, evidence, kind?, tags?)` now hands explicit information to a bounded, tool-less Pi model consultation. The model returns an accept/reject judgment; the **parent** alone writes through canonical `KnowledgeStore.put` with `status=candidate` (`.pi/extensions/40-state/memory-history.ts#L172-L190`, `.pi/lib/context/memory-handoff.ts#L14-L56`). The stable ID is derived from namespace, scope, kind, redacted text and source. A repeated identical offer returns the same stored ID and revision without calling the model or appending another event; changed evidence under that identity reports `conflict` rather than silently revising it.

After the durable write, a request-local PageIndex projection reads the candidate from the canonical store and acknowledges `stored-indexed` only when its exact ID/revision has an indexed Markdown section (`.pi/lib/context/memory-handoff.ts#L59-L69`). A failed projection reports `stored-index-pending` while leaving the durable candidate retryable. This is indexing for candidate discovery, **not verified-only bootstrap recall**.

## Actual calls and outputs

1. In an isolated workspace, the real `clover-plexus/luna` Pi consultation received the explicit claim “Project Lumen keeps pilot invoices in PostgreSQL for auditability” and returned `{"accept":true,"reason":"Durable project context: pilot invoices are stored in PostgreSQL for auditability."}`. The parent returned `stored-indexed`, a candidate record ID/revision, repository scope and PageIndex source/node citation. No live Pi-Swarm project memory was written.
2. An isolated replay returned the **same ID and revision** without consulting the model. A fresh Node process opened the same store and searched `Lumen pilot invoices PostgreSQL`: it returned `status=ok` and the exact candidate ID/revision and claim excerpt. This demonstrates durable read-after-write and new-process discovery, not merely an in-memory index.
3. A reviewer rejection returned `rejected` before writing; an empty offer returned `invalid`. A replay with changed evidence returned `conflict`, not a duplicate. The indexed candidate remained excluded from a verified-only projection (`not-indexed` in an isolated store containing only that candidate). Existing focused memory/context suites passed (22 checks).

## Limitation

This session loaded the agent-facing `memory_history` tool **before** `offer` was added. The observed acceptance and fresh-process lookup used the current library with an actual Luna consultation and isolated store; an end-to-end agent-facing `memory_history offer → recall` still needs a `/reload`. Evidence refs in this handoff identify provenance but do not alone prove the claim's truth. Model failure, abort and index-failure paths are defined but were not exercised with a live provider in this run.
