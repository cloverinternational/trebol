# Confirmatory prompt benchmark: findings

Sealed at cddbcbf (PREREG.md, SEAL.txt). 25 fresh tasks x {M, F, Fnb} x 3 reps = 225 runs, product b4dc9bc, haiku.

## Primary (pre-registered, analysis.txt)
| Comparison | Diff | 95% CI | |
|---|---|---|---|
| M-F | +0.227 | [+0.107, +0.360] | CLAIM |
| Fnb-F | +0.053 | [-0.080, +0.187] | n.s. |
| M-Fnb | +0.173 | [+0.053, +0.293] | CLAIM (secondary) |

Pass rates: M 0.800, F 0.573, Fnb 0.627. Under the sealed decision rule (M-F claim, Fnb-F n.s.),
Modes helps for reasons other than skipping bootstrap.

## Validity
- 18 runs (fix-d2f2acb, fix-2577572) had no run: the dist-symlink loop threw for packages absent at
  those parent commits. Fixed post-seal (post-seal.diff). Those rows went to main/invalid-1.jsonl
  and were retried once, as pre-registered. After the retry, 225/225 runs are valid.
- Harness confound found after the retry: the retried runs reused workspaces left half-initialized by
  the failed attempt, so `runtime-contracts/dist` was missing. The 4 fix-2577572 failures
  (Fnb x3, M x1) all ran in such a workspace, and every fix-2577572 pass had the dist present.
  Re-grading those 4 runs (agent edits unchanged, dists linked) gives 8/8 tests passing for all four
  (regrade-2577572.txt).
- Sensitivity checks (sensitivity.txt). Both leave the conclusion unchanged:
  - re-graded: M-F +0.240 [+0.120, +0.360]; Fnb-F +0.093 [-0.000, +0.213]; M-Fnb +0.147 [+0.040, +0.253];
  - fix-2577572 dropped: M-F +0.250 [+0.125, +0.375]; Fnb-F +0.097 [-0.014, +0.222]; M-Fnb +0.153 [+0.042, +0.264].

## Exploratory (exploratory.txt, descriptive only)
- Bootstrap calls: F 44/75, Fnb 0/75, M 0/75. Removing the one sentence removed bootstrap entirely,
  but recovered only part of the M-F gap.
- M vs F by task: 11 wins, 0 losses, 14 ties. Most of the gain is on q tasks (M 0.762, F 0.381, Fnb 0.524).
- Median seconds: M 16.7, Fnb 20.7, F 35.3. Median tool calls: M 4, F 6, Fnb 6.
- q runs with no citation at all: M 3, Fnb 6, F 9.
- Not tested: which part of the Modes prompt causes the gain. In the first run, FM (Forge plus the
  mode protocol) equalled F, so the mode-declaration rules alone are an unlikely cause.
