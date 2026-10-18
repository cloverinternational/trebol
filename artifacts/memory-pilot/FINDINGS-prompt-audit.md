# System-prompt audit vs Swarm SDK Forge, and pair-01 re-run (exploratory)

## Audit
- Swarm SDK Forge: `~/Work/mono/swarm-sdk/swarm-tui/internal/chat/settings/system_prompt.go`
  (`forgeSwarmSystemPrompt` ~8.3k chars + `swarmForgeDelegationAddendum` ~6.1k). Memory guidance: none in the
  base; one conditional, tool-agnostic line in the addendum's control loop ("Recall relevant prior evidence when
  the user references earlier work...").
- Trebol forge section (`prompts/swarm-system-prompt.md`) differs from the SDK in 4 deliberate rule edits
  (safe diagnostics, code examples, file/doc creation, result format) and the delegation text ("Delegate with
  context" instead of "Never delegate understanding"; background polling allowed for blockers). It adds
  testing/reporting/response-check sections, the bootstrap-first line, `<task_completion_contract>` and `<memory_workflow>`.
- **Defect found:** `registerHook` keeps hooks dormant for 5 turns (`HOOK_WARMUP_TURNS`, added 6dfff52).
  swarm-prompt uses it, and before_agent_start fires once per user prompt, so every headless run and the first
  prompt of every session got **Pi's base prompt** (79k chars incl. full AGENTS.md) and never saw Forge.
  Pair-01 at f35d6a0 ran entirely on Pi's base prompt.

## Changes (218ba13)
1. `registerHook(..., { warmup: false })` for swarm-prompt only; gates keep the warm-up.
2. `<memory_workflow>`: "task **or question about this project**", and "query with 2-3 distinctive keywords ...
   every query word must appear in a record" (matches the all-terms search).
3. Control-loop step 2: recall "before investigating a project task or question" as well.

## Pair-01, f35d6a0 (before) vs 218ba13 (after); same tasks, model, harness
| | before A (n=2) | before B (n=2) | after A (n=3) | after B (n=3) |
|---|---|---|---|---|
| first-request system prompt | Pi base 79k | Pi base 79k | Forge 37k | Forge 37k |
| runs with any recall tool (bootstrap/memory_history/context_search) | 0/2 | 0/2 | 3/3 | 3/3 |
| memory_history/bootstrap calls | 0,0 | 0,0 | 0,2,1 | 0,0,2 |
| verified records surfaced | 0 | 0 | 0 | 0 |
| tool calls | 2,2 | 3,2 | 5,10,5 | 4,4,5 |
| max context chars | 212k | 213-219k | 163-217k | 167-197k |

T1 (seed) after: bootstrap + `memory_history search "TaskManage evidence"` (a 2-keyword query; it hit).
B-3 searched "tool_result_unavailable evidence": 0 hits, because the seeded answers never contain that term.
Bootstrap in B-3 reported "No memories selected" with verified records present; cause not established.

Interpretation: the prompt changes increased recall attempts (0/4 -> 6/6 runs) and produced short keyword
queries, but no record reached the model in T2. The remaining blocker is retrieval (vocabulary mismatch, all-terms
search, bootstrap selection), not prompting. More tool calls after the change are not established as a cost of
memory: the arms differ by base prompt, n is tiny, and context_search plus re-reads account for most of the increase.

**Correction (see memory-bench/FINDINGS-autonomy.md):** the "verified records surfaced in T2: 0" figure above used a broken metric (analyze.mjs parsed only bootstrap JSON). With the fixed metric the T1 record reached T2 in 2/3 B reps via context_search; the vocabulary-mismatch explanation is withdrawn.
