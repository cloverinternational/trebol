# Pi-Swarm offline policy improvement (adapted Dream-RSI B.2)

Status: experimental prompt; NOT installed into the working agent. This prompt
requires a prefix-only replay evaluator and trace format that are not yet built.
Do not pretend ordinary conversation logs implement the API below.
Source reference: dream-rsi-b2-source.txt.

Edit only {method_file}. Do not change the evaluator, models, task verifiers,
permission rules, memory store, task API, skill APIs or source history.

Optimize when to audit, request independent review, retrieve memory, retry a
repairable review, or leave the agent alone. Actions come only from the host's
legal action set. Host limits and mandatory instructions are immutable.

Read prefix observations: goal, task ledger, known worker/wait state, Jev outputs,
source/skill/memory revisions, prior review verdicts and measured outcomes. Never
read future outcomes, eventual completion, held-out labels, or hardcoded winning
source IDs during solve. No reward for an action without a recorded compatible
outcome: classify unsupported transitions as unknown and report coverage.

Reconstruct trajectories rather than reacting to the latest error. Preserve a
successful anchor, but distinguish historical success from current applicability.
Recoverable API/schema/wiring failures do not prove semantic review is useless.
Later evidence can reopen a branch. No indefinite retry of a demonstrated dead end.

For each decision, rank useful independent review/retrieval work and at most one
justified recovery. Do not parallelize conflicting mutations to the same task,
skill or memory revision. An empty batch is legal when waiting, evidence is
insufficient, or no useful legal action remains. Never manufacture work to fill
workers. Avoid duplicated reminders and redundant memory writes.

Evaluate fixed beta settings separately: beta controls review selectivity/patience,
not correctness thresholds or permissions. Keep beta fixed for each episode.
Choose next-cycle beta using prior online outcomes plus replay trade-offs; do not
claim replay improvement guarantees live improvement. Require meaningful tradeoff
changes rather than a cosmetic knob.

Keep the existing policy in the comparison. Report supported useful outcomes,
unsafe promotions, missed obligations, false interventions, worker/API/token costs,
latency, and unsupported-transition coverage separately. Any unsafe mutation is
an eligibility failure; do not offset it with more positive findings. This differs
from the paper's best-score/parallelism objective and must be documented.

Use temporally held-out whole sessions/projects. Validate selected policies in a
bounded live canary before deployment. Never reuse an old rollout as proof that
new skill text or a novel intervention would have produced the same outcome.

Deliver policy diff, exact version hashes, replay support/coverage, baseline
comparison, failures and bounded next live experiment. No fabricated simulator,
no automatic runtime policy self-modification.
