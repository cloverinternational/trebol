# Memory retrieval benchmark pre-registration (sealed before first scored run)
- Corpus: frozen snapshot `records-snapshot.jsonl` (975 live records, repository+worktree stores of this repo, dumped before any curation). Per query, only records created before the query count (no future leakage).
- Queries and gold (retriever-independent, defined before scoring):
  - mined-user / mined-agent: tools/bench/mine-retrieval-qrels.py. Gold = fact records (1-6 named tracked files) from another, earlier session whose files the agent then edited (2) or read (1).
  - span: sealed test-split developer searches; gold = records whose cited evidence span overlaps that query's grade-2 qrels span.
- Methods: current (b4dc9bc conjunctive rule), bm25, dense (embeddinggemma-2 via spark), hybrid (RRF k=60, exact phrase first).
- Primary: nDCG@5, hybrid vs current, paired bootstrap over queries (10k, seed 20261018), all queries. Claim only if 95% CI excludes 0. Secondary: hit@5, zero-result count, hybrid vs bm25.
- Curated-fact corpus (after curation) is a separate, later comparison on the same queries, using gold mapped through curated facts' source IDs: exploratory unless pre-registered by addendum before it runs.
- Known limits recorded now: n is small (~25); mined gold is file-overlap (a usefulness proxy, not relevance judgment); half the mined user requests are context-free ("continue").
