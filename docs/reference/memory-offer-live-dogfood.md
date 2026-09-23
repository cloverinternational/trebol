# Live `memory_history offer` dogfood

## Offer and source

The main agent chose a non-sensitive implementation fact from `.pi/lib/state/memory-retrieval-worker.ts#L13-L33`: the read-only worker exposes `memory_browse`, `memory_read`, and `memory_select`; `memory_read` marks a card as read; `memory_select` rejects unread keys; a run has an eight-tool-call budget. It checked `memory_history search` for an existing candidate matching the distinctive “read-before-select” description; the response contained no knowledge or legacy entry.

An initial **agent-facing** `memory_history offer` with that text, repository scope, source path and tags but **without `evidence`** returned `{status:"invalid",reason:"Provide bounded text, project scope, source and 1–8 evidence references"}`. This was a correct actionable rejection, not a model failure or a write.

The next live call supplied three cited code lines and their quotes:

- `.pi/lib/state/memory-retrieval-worker.ts#L15` — eight-call gate;
- `.pi/lib/state/memory-retrieval-worker.ts#L24` — `read.add(card.key)`;
- `.pi/lib/state/memory-retrieval-worker.ts#L31` — `!read.has(one.key)` rejection.

The live tool returned `stored-indexed`, ID `673925df7098e7bf2ba0c82fb0c728aa`, revision `78f4b7a47b3d7dc72fc47bee12dcecd4`, `scope=repository`, `memoryStatus=candidate`, and PageIndex source `19d068c19220fbf249e12897#0001`. Direct `memory_history get` returned the exact claim, source, status, scope and evidence quotes. A direct canonical event-file read showed one event for that ID with the same revision. This confirms persistence and traceability; candidate status is not independent fact verification.

## Discovery and replay

The agent-facing `context_search("read-before-select memory_browse memory_read memory_select eight tool calls")` returned `candidate-leads` with exactly that ID, excerpt, original evidence, revision and PageIndex citation. `memory_history recall` with the same query, repository scope, candidate status and limit one also selected that candidate (and labelled it unverified). These results match the stored record and the inspected code lines.

Repeating the **same live offer** returned `stored-indexed` with the **same ID and revision**. A subsequent event-file inspection still showed one event for that ID; no duplicate was appended.

## Assessment

For this explicit, well-cited project fact the flow works end to end: main agent → memory reviewer → durable candidate → PageIndex discovery/recall. The failed first attempt revealed friction: the main agent must supply evidence refs explicitly; `source` alone is not enough. The handoff does not verify the candidate or make it eligible for verified-only bootstrap recall. This dogfood did not exercise a live reviewer rejection, timeout, cancelled request, failed write, or unavailable index.
