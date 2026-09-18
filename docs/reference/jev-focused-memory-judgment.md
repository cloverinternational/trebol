# Focused Pi-Swarm backfill: actual quality judgment

12 additional Jev calls on six-or-fewer late-session passages from each of12
Pi-Swarm sessions surfaced16 memory/mixed passages. Three real restricted reviewers
ran37.6s,27.1s,44.6s; all completed within90seconds, staging only. Cumulative pilot
budget:32 Jev calls and7 reviewer jobs (including original exploratory reviewer).

## Verdict: finder useful, automatic reviewer not good enough alone

The initial reviewer saved a 'verified historical outcome report' recounting old
assistant test/build claims. That preserves attribution but adds low-value report
clutter. Parent review downgraded it to candidate with expectedRevision; no deletion.
Other results included a dated user integration preference and unverified external
MCP claims. Credential inventory is not appropriate default project memory.

## Three useful memories actually saved and recalled

1. Question-bearing tasks require complete question-ID answers and resolvable
   evidence before completion. Source passage457f8262; verified against
   packages/tools/taskmanage/src/task-manage.ts::completionError/resolveEvidence.
   Reference availability is not semantic verification.
2. Pi-Swarm's local MCP owner is swarm-runtime.ts using packages/tools/mcp
   MCPManager. Source99c14910; verified exact constructor/import. Do NOT extend
   this to a claim about every upstream Pi build.
3. /btw supplies appendSystemPrompt as an array of existing prompt+SIDE_PROMPT,
   filtering absent entries. Source3c2b2569; verified against
   .pi/extensions/50-ui/swarm-btw.ts:45.

All three were written to isolated staging by the parent after reading code,
then retrieved with actual recallKnowledge project queries. Exact record IDs,
code hashes, questions and outcomes: ignored pilot/focused-code-judgment.json.
These are real current-code-supported memories, not the original broad prose.

## Reject or retain only as history

- Branch divergence/head hashes: transient; do not recall as current state.
- Old test totals/release narration: historical assertions, not current proof.
- External OAuth/MCP feature claims: need external source verification.
- Account/vault inventory: sensitive, unnecessary for generic project recall.
- Subagent injected briefs: not human preferences. Scanner still needs better
  role/origin exclusion for these before full-run expansion.

The independent critic mistakenly inspected the TypeSafeAI workspace instead of
Pi-Swarm and claimed implementation files were absent. Its report was not used as
truth; parent verified the files in the actual target checkout. This reinforces
why correct project identity and evidence reads are required.

## Reproduce

`PI_SWARM_FOCUSED_MEMORY_JUDGE=1 npx vitest run .pi/test/state/focused-memory-judgment.local.test.ts`
This opt-in test writes staging only, never live memory. No full corpus completion
or autonomous memory-quality claim. Useful result:3 specific facts save rediscovery,
while the raw reviewer output needed narrowing and rejection.
