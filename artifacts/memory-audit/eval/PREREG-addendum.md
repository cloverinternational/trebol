# Addendum (written after judging, before any scoring)

Adjudication deviation: the two adjudicator subagents (adjudicated-0/1.json) report they did NOT open the source for every disagreement; most were graded from the passage, need and query. This is weaker than the planned "settle against source".

Sensitivity analysis added before scoring: every comparison is scored under three qrel sets:
- qrels.jsonl: agreed grade, else adjudicated grade (primary)
- qrels-strict.jsonl: min(A, B)
- qrels-lenient.jsonl: max(A, B)
A comparison is reported as decided only if the decision-rule verdict is the same under all three; otherwise "not established (sensitive to adjudication)".

Agreement before adjudication: 1485 items, Cohen kappa 3-class 0.679 (po 0.845), binary rel>=1 0.766 (po 0.897); 230 disagreements, 5 of them 2-vs-0 (agree.py).
