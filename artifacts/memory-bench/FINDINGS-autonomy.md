# Autonomous retrieval (pair-01), sealed plan PREREG-autonomy.md

| run | arm | reps where a T1 record reached T2 (any memory tool) | via | mean T2 tool calls | answers stating exact-name cause |
| --- | --- | --- | --- | --- | --- |
| 218ba13 (all-terms search) | B | 2/3 | context_search candidate-leads | 4.33 | 3/3 |
| 218ba13 | A | 0/3 | - | 6.67 | 3/3 |
| e889b64 (ranked search) | B | 3/3 | memory_history search | 5.00 | 3/3 |
| e889b64 | A | 0/3 | - | 6.00 | 3/3 |

Source: runs/<run>/t2-reanalyzed.jsonl (tools/pilot/analyze.mjs --seed mem-t1).

**Correction.** FINDINGS-prompt-audit.md reported "verified records surfaced in T2: 0" and attributed it to
vocabulary mismatch. That number came from analyze.mjs counting only bootstrap memories parsed as JSON;
bootstrap now returns a text brief, so it was always 0, and memory_history/context_search results were never
counted. With the fixed metric the T1 record reached T2 in 2/3 B reps at 218ba13 as well.

**What this does and does not show.**
- Ranked search makes the agent's own memory_history query return the T1 record (3/3 vs 0 of the
  memory_history calls at 218ba13). Retrieval reaching the agent is established for this pair.
- Benefit is not established: T2 is solved correctly by every run in both arms from code (ceiling), and the
  call-count difference (n=3 per arm) carries no inferential weight.
- A paired pass-rate run on the 15 q tasks was not run: only 2/15 tasks have a leak-safe seeded fact citing
  their gold span (autonomy-seeds/manifest.json), so it could not detect an effect. A memory-benefit test
  needs tasks whose answer is in memory but expensive to rediscover from code.
