# Prompt benchmark pre-registration (sealed before the main run)

- Arms (artifacts/prompt-bench/arms, built by tools/bench/build-arms.py from GENERIC.MD sha256 c6a768c1…): F Forge, M Modes adapted (M.diff), FM Forge + 842-char mode protocol, FL Forge + 843-char inert filler (length control).
- Product (extension pack) pinned: b4dc9bc. Model: default clover-plexus-anthropic/claude-haiku-5-5. Each run: fresh empty memory store, own worktree, project-local resources ignored (--no-approve), arm prompt as active custom prompt.
- Tasks (tasks.json, 23): 8 fix tasks (hidden shipped vitest files overlaid after the run; pass = vitest exit 0) and 15 question tasks (sealed A/B test split, pass = cited range overlaps grade-2 qrels span).
- Reps: 3 per task x arm (276 runs). Arm order per (task, rep) = seeded shuffle (seed 1). Jobs 4.
- Variance pilot (pilot/, F only, 2 tasks x 3): fix 3/3, q 2/3; mean 30 s/run. Not scored.
- Primary: per-task mean pass rate; paired difference vs F for each of M, FM, FL. Paired bootstrap over tasks (10k, seed 20261018, 95% percentile CI). Claim "better/worse than F" only if CI excludes 0.
- Secondary (descriptive, no claims): tool calls, errors, blocked calls, memory/recall tool calls, model calls, seconds, mode-declaration lines. FM vs FL isolates content from length.
- Invalid run: no meta/exit non-zero/timeout: retried once by rerunning the runner (it skips recorded runs only); reported.
- Exploratory (not claims): per-kind splits, failure taxonomy from traces.
