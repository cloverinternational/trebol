# Step 2: does the regex-gold verdict match "this chunk answers the query"?

Sample: `metric_sample.py` (seed 20261018) -> `metric-sample.json`. Pool = rrf_v2 top-5 (non-summary) for every dev+heldout question with a gold regex: 135 chunks, 30 regex hits, 105 misses. Drew 10 hits + 10 misses. Judge: coordinator (one person, not blind to the regex verdict, so this is a weaker check than a blind one).

| # | set q | regex | answers? | agree | note |
|---|---|---|---|---|---|
| 0 | heldout 29 | miss | no | yes | UI source map, not the kanban model |
| 1 | heldout 30 | miss | no | yes | api-window agent list |
| 2 | heldout 40 | miss | partial | yes | startup-card imports; not the git.open action asked for (borderline) |
| 3 | dev 47 | hit | yes | yes | AGENTS.md `~/.swarm/memory` |
| 4 | dev 48 | miss | no | yes | e2e header mentions the fact without stating it |
| 5 | heldout 39 | hit | yes | yes | startup-card git state nodes |
| 6 | dev 33 | hit | yes | yes | repo identity |
| 7 | heldout 26 | miss | no | yes | right file, header chunk; gold is in another chunk |
| 8 | dev 32 | miss | no | yes | degenerate chunk: text is `}` |
| 9 | dev 48 | hit | yes | yes | AGENTS.md exemption sentence |
| 10 | dev 49 | miss | no | yes | renderer display caps, not selection caps (borderline) |
| 11 | dev 49 | miss | no | yes | bootstrap extension body |
| 12 | dev 45 | miss | **yes** | **no** | `bootstrapBrief` is the orchestration handoff asked about; gold regex too narrow |
| 13 | heldout 37 | miss | **yes** | **no** | regression doc explains /model rows hidden by virtual-row threshold, the actual answer |
| 14 | dev 33 | hit | yes | yes | |
| 15 | dev 33 | hit | weak | yes | annoyed publish path; mentions repo (borderline) |
| 16 | dev 43 | hit | yes | yes | DraftEditor paste markers |
| 17 | heldout 29 | hit | yes | yes | task-board.ts |
| 18 | dev 47 | hit | **no** | **no** | experiment README uses a temp `PI_SWARM_MEMORY_DIR`; does not say where the store lives |
| 19 | heldout 30 | hit | yes | yes | tern-resume picker |

Agreement 17/20 = 85%. Hits: 9/10 truly answer (1 false positive). Misses: 8/10 truly don't (2 false negatives, both "answer phrased differently from the gold"). Three more are borderline.

Interpretation: the regex golds are usable but biased against arms that return correct-but-differently-worded passages (dense). That is why the sealed eval uses graded human-style judgments, not regex golds. 20 samples gives a wide interval (Wilson 95% CI for 17/20 is about 0.64-0.95).
