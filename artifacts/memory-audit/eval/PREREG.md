# Pre-registration: project_context sealed eval (written before any judging or scoring)

Inputs: test-queries.jsonl (sealed a52ba866), runs.jsonl + passages.jsonl (arms.py on spark), memory-run.jsonl (live memory_history search, scope=all, limit=10).

Arms: rg, memory, dense_v1, rrf_v1, dense_v2, bm25_v2, rrf_v2. Top 10 each. No tuning on test.

Relevance scale (per query, per pooled doc), judged against the query, its `need`, and the files the developer opened next / edited / committed:
- 2 = passage contains the specific code/doc the search was looking for (the developer could act on it).
- 1 = related: right file or topic, but not the targeted region/fact.
- 0 = not useful.

Judges: two independent blind LLM subagents (arm labels hidden, doc order shuffled per query, seed 20261018). Agreement: Cohen's kappa (unweighted 3-class and binary rel>=1). Disagreements are adjudicated by the coordinator reading the source. Judges are agents, not humans; this is reported as a limitation.

Metrics (ranx): primary nDCG@10 (graded); secondary MRR@10, Recall@10 (rel>=1). Queries with no doc judged >=1 in the pool are excluded from metric means and counted separately.

Comparisons (paired bootstrap over queries, 10,000 resamples, seed 20261018, 95% percentile CI on mean delta nDCG@10):
1. rrf_v2 - dense_v2   (fusion question)
2. rrf_v2 - rrf_v1 and dense_v2 - dense_v1   (v1 vs v2)
3. best v2 arm - rg, best v2 arm - memory   (context)

Minimum meaningful difference: |delta nDCG@10| >= 0.05.
Decision rule: "A better than B" only if CI lower bound > 0 AND point estimate >= 0.05. CI includes 0 -> "not established". CI excludes 0 but |delta| < 0.05 -> "statistically detectable, below MMD".

Downstream A/B (15 queries, with vs without project_context) is scored on: answer correctness vs qrels, citation precision (cited path#Lx-Ly lines contain the fact, checked by script), tool calls, tokens. Same decision rule on correctness with paired bootstrap; n=15 is expected to be underpowered.
