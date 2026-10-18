# Confirmatory prompt benchmark: pre-registration (sealed before the main run)

Question: is Modes (M) better than Forge (F), and is Forge's bootstrap instruction the cause?
Motivated by the first run (../analysis.txt): M-F +0.130 [-0.029,+0.290] n.s.; M called bootstrap 0/69, F 36/69.

- Arms: F = ../arms/F.md (unchanged); M = ../arms/M.md (unchanged); Fnb = ../arms/Fnb.md =
  the F body with exactly one sentence replaced, "When starting a conversation, call bootstrap first,
  then use TaskManage." -> "When starting a conversation, use TaskManage." (tools/pilot/run-session.mjs
  {{forge-body-no-bootstrap}}; throws if the sentence is absent). The bootstrap tool stays registered in
  every arm. Smoke check: Fnb model requests contain the instruction 0/15, F 9/13.
- Tasks: tasks.json (25 fresh, none in ../tasks.json), built by tools/bench/build-confirm-tasks.py:
  11 fix tasks (validated, hidden shipped vitest overlaid after the run; pass = exit 0),
  14 q tasks (next eligible qids in the sealed A/B order; pass = a cited range overlaps a grade-2 span).
- Product b4dc9bc; default model clover-plexus-anthropic/claude-haiku-5-5; fresh memory store per run;
  3 reps; arm order per (task, rep) = seeded shuffle, seed 2 (first run used 1); jobs 4.
  225 runs, out dir main/.
- Harness changes since the first run: worktree creation serialized by a lock (concurrent
  `git worktree add` exit 128 reproduced 3/3; the likely cause of the first run's 98 no-runs);
  runner-error.txt import fixed; analyze-bench.py takes ARMS/PAIRS args (default output byte-identical).
- Primary (2 pre-registered comparisons): Fnb-F and M-F; secondary M-Fnb. Per-task mean pass,
  paired bootstrap over tasks (10k, seed 20261018, 95% percentile). A claim needs the CI to exclude 0.
  Decision rule: if Fnb-F > 0 is a claim and M-Fnb is n.s., then the bootstrap instruction explains
  the gap. If M-F is a claim and Fnb-F is n.s., then Modes helps for other reasons. Otherwise
  "not established".
- Secondary, descriptive only: bootstrap calls per arm, tool calls, seconds, errors.
- Invalid run (no meta, exit != 0, grade error): one retry, rows moved to main/invalid-1.jsonl, reported.
- Pooled analysis with the first run (48 tasks, M-F) is exploratory.
- Smoke runs (smoke/: fix-d2f2acb and q-T18, 1 rep, all three arms) are not scored.
