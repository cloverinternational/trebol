# Skill-budget gate restored

Counterexample: registerAutoSkillsExtension sets modelContext:false to avoid
repeated prompt text; AutoSkillManager.gateTool returned early for that flag.
The durable count and UI could advance while its actual execution gate was off.
The builtin hook's separate counter did not supply equivalent behavior (read-only
Bash exemption, broad SkillManage resets, no durable manager-state relationship).

Fix: gateTool auto-mode enforcement is independent of modelContext. Existing
mode/permission/exemption semantics remain. Regression test fails before fix,
passes after;65 autogen/skill tests and build pass.

Real installed Pi smoke (temporary workspace/provider/skills, Supervisor unused):
active task -> five Bash attempts -> sixth blocked -> SkillManage list -> still
blocked -> Skill invocation -> Bash recovered. Eleven tool results; no paid calls.
Command: node tools/experiments/jev-audit/skill-budget-smoke.mjs.

Limits:90-call working-tier tested through manager adapter; real smoke exercises
5-call onboarding. Earlier real compaction test verifies persisted nonzero counters
and same-session reload, not post-reload90-call enforcement. Separate lifecycle
nudge counters still need consolidation; do not claim a single budget owner yet.
Existing running sessions must reload to use the fix.

## Subsequent user-handoff change

Human question expiry was removed from all ask-user UI branches; a legacy timeout
parameter is ignored. Source regression checks no timer remains; layout tests pass.
Real long-duration TUI wait/shutdown behavior has not been separately dogfooded.
Canonical stop reconciliation now requests ask_user_question for unfinished
pending/in-progress work, including dependency-blocked work, once per external
request after observed work. User/background waits and interrupted runs suppress
it. This instructs the model through the existing hook; it cannot guarantee the
model complies. Pending-task/question-prose and duplicate-stop cases are tested.
