# A/B addendum (written after the sealed A/B ran, before any exploratory run)

Observed in the sealed runs: arm A called project_context 0 times in 15 runs (score_ab.py output, "project_context calls per question"). The sealed A-B therefore measures having the tool available, not using it.

1. Scorer bug fix: `m[1].lstrip("./")` stripped the leading "." of `.pi/...` citations, so they failed to resolve. It now removes only a literal "./" prefix. Diff in score_ab-post-seal.diff. The primary verdict is reported under the fixed scorer, and the buggy-scorer output is kept in ab-scores-sealed-scorer.txt.
2. EXPLORATORY arm F (not pre-registered, cannot change the primary verdict): the same tools as A, plus a prompt telling the model to call project_context first. One run per question. F-B is reported with the same bootstrap. Interpretation: whether forced retrieval changes outcomes.
3. EXPLORATORY format sensitivity: citations written as `path:a-b` instead of `path#La-Lb` score as zero under the sealed regex. Counts of such answers are reported, not re-scored.
