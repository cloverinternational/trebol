# Error taxonomy: rrf_v2 failures (no grade-2 passage in top 10), primary qrels

Source: failures-dump.txt (generated from sealed runs.jsonl / qrels.jsonl / test-queries.jsonl). Denominator: 42 test queries; 20 fail. Classified by the coordinator (one rater). "Under-specified query" was added because six failures fit none of the five pre-specified classes.

| class | n | queries | evidence pattern |
|---|---|---|---|
| not in corpus | 6 | T04, T22, T23, T27, T36, T37 | rg 0 matches on current tree (T04 STARTUP_CSS, T23 hook message, T27 Plexus, T36 PID log) or target is not an indexed file type (T22 LICENSE file) or a filesystem listing (T37). No arm except memory (T23) found a grade-2 passage. |
| under-specified query | 6 | T01, T06, T08, T11, T12, T39 | 1-word generic token (`block` 2917 rg matches, `prompt` 3612, `value:` 755, `PATTERN` 589); need is unrelated to the token (T06: @-mentions). Not a retriever defect. |
| vocabulary mismatch (code literal / regex lost in tokenisation) | 4 | T24, T29, T32, T38 | `k: "table"`, `status: "pending"`, `margin: 0 12px 4px`, `preview.*children`: punctuation stripped by `norm`, so tokens match generic docs. bm25_v2 or dense_v2 alone found the grade-2 file for T29, T32, T38, T24; fusion buried it. |
| vendor noise | 2 | T02, T10 | rrf top 3 all `vendor/pi-mono/...` (overflow.ts, test harness); grade-2 file was found by bm25_v2/rg (T02). |
| chunk split | 2 | T13, T42 | right file returned at grade 1 (swarm-toolclass.ts, system-prompts) but a different chunk of the target was the grade-2 one (dense_v2 had it for T13). |
| stale copy | 0 | - | corpus synced the same day as the queries were scored. Note: for T42 the judges graded memory note b54924a0 as 2, but it is stale: it places the prompt in `packages/context/prompt/assets`, which no longer exists (`ls` fails); the prompt now lives in `prompts/swarm-system-prompt.md`; this is a judge error in the memory arm's favour, not an index staleness. |

Dominant fixable class: vocabulary mismatch on code-literal/regex queries (4/20), then vendor noise (2/20). Implied fix (not implemented): when the query contains code punctuation or regex metacharacters, add an exact-substring/rg channel to the fusion instead of tokenised BM25 only; and exclude or down-weight `vendor/` unless the query names it. 12/20 failures (not in corpus + under-specified) are not fixable by the retriever.
