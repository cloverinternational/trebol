# Addendum (sealed before curated scoring): curated-fact corpus vs raw corpus
Written while tools/memory/curate-facts.mjs runs over records-snapshot.jsonl (kind=fact only); no curated result inspected.
- Curated corpus = curated facts (artifacts/memory-bench/curated/facts.jsonl, any status) + every non-fact snapshot record unchanged (task snapshots stay as distractors). Raw corpus = the full snapshot.
- A curated fact's createdAt = latest createdAt of its sources (no leakage). Its gold grade for a query = max gold grade of its source records. Gold sources the curator dropped are lost (counts against curation).
- Same 25 queries, method hybrid (and bm25 secondary). Primary: hit@5, curated vs raw, paired bootstrap over queries (10k, seed 20261018); claim only if 95% CI excludes 0. nDCG@5 secondary (its ideal differs by corpus, so it is not primary).
- Also reported: fraction of curated facts verified by the mechanical check; a blind manual audit of 20 random verified facts (claim supported by cited span: yes/partly/no) by the main agent, recorded before computing retrieval numbers.
