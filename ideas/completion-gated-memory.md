# Completion-gated memory: audit and design

Status: research note, not implemented. Observed facts cite file:line. Items marked **[inferred]** are reasoning, not observed. Spark evidence was read over ssh against Agent-MCP commit `13d98b2`.

## Summary

- **Agent-MCP's memory gate is not enforced in code.** "Write context before finishing" is a prompt suggestion only. No completion path checks for project-context writes.
- **Agent-MCP's corpus DBs contain no agent-written memory.** Both spark corpus DBs hold 0 agents, 0 tasks, 0 agent actions and one seed `project_context` row. Their RAG index is code and markdown. The hypothesis that agent-written context entries made memory work is not supported by these artifacts.
- **Trebol already has the raw parts**: a TaskManage completion gate with evidence resolution, answer anchoring, and per-answer fact records. Missing: a learned-knowledge requirement, subagent ingestion, dedupe on write, and a measurement arm.

## Agent-MCP findings

Source: `ssh spark`, `~/Agent-MCP` (commit `13d98b2`), and corpus DBs `~/trebol-corpus/.agent/mcp_state.db` and `~/trebol-corpus-v2/.agent/mcp_state.db`. Token files and token columns were not read.

### Agent creation and prompts

- Agents are created by `create_agent_tool_impl` (`agent_mcp/tools/admin_tools.py:69`). `prompt_template` defaults to `worker_with_rag` (`admin_tools.py:78-79`), rendered via `build_agent_prompt` (`admin_tools.py:486`, `:1258`).
- Templates in `agent_mcp/utils/prompt_templates.py`. `worker_with_rag` says: "Ask the project RAG agent at least 5-7 questions ... Add all these context entries to the agent mcp." `testing_agent` tells a reviewer to set a failed task back to `pending` and add notes.
- Base system prompt: `agent_mcp/utils/project_utils.py:150-180`. Lists `view_project_context` and `update_project_context` as tools, marks the latter "(Admin)" (`:173`), describes RAG as auto-indexed (`:177`).

### Completion and termination

- `update_task_status_tool_impl` (`agent_mcp/tools/task_tools.py:1956`) validates token, status enum and task IDs. It makes no check for project-context, notes or memory writes.
- `_update_single_task` (`task_tools.py`, approx. 370-415) appends optional `notes`. Unchecked.
- Only structural rule found: agents must create child tasks with a parent (`task_tools.py:1741`). This is task-tree structure, not memory.

**Enforced vs suggested (Agent-MCP):**

| Item | Status |
| --- | --- |
| Tool calls require a valid token | Enforced (per-tool token checks) |
| `update_project_context` is admin-only | Stated in tool description (`project_utils.py:173`); the code path was not read line by line **[inferred]** |
| Completing a task requires context/memory writes | **Not enforced.** Prompt suggestion only (`worker_with_rag`, system prompt) |
| Completing a task requires notes | Not enforced (`notes` optional) |
| Agent-created tasks need a parent | Enforced (`task_tools.py:1741`) |
| Reviewer agent checks completed work | Prompt-only (`testing_agent`) |

### Project-context tables and tools

- Table `project_context` (`agent_mcp/db/schema.py:227`), columns include `context_key`, `value`, `description`, `updated_by`, `last_updated`.
- Tools in `agent_mcp/tools/project_context_tools.py`: `view_project_context` (`:154`), `update_project_context` (`:663`), `bulk_update_project_context` (`:712`), `backup_project_context` (`:861`), `delete_project_context` (`:1330`). Registration `:1128-1326`.
- `ask_project_rag`: `agent_mcp/tools/rag_tools.py:17`. Synthesis in `agent_mcp/features/rag/query.py:61`; live `project_context` rows fetched at `query.py:111` and `:427`.

### RAG ingestion

- `run_rag_indexing_periodically` (`agent_mcp/features/rag/indexing.py:145`) scans markdown (around `:300-330`), code, then `project_context` rows with `last_updated > cursor` (`indexing.py:357`).
- Tasks are indexed only in advanced mode (`index_task_data`, `indexing.py:873`).
- Ingestion is periodic and timestamp-based, not triggered by completion.

### Actual DB contents (spark)

Read-only `sqlite3` counts. Only key names and metadata were sampled.

| DB | project_context | agents | tasks | agent_actions | rag_chunks |
| --- | --- | --- | --- | --- | --- |
| `trebol-corpus/.agent/mcp_state.db` | 1 (seed key `config_admin_token`, `updated_by`=`server_startup`) | 0 | 0 | 0 | 6,904 |
| `trebol-corpus-v2/.agent/mcp_state.db` | 1 (same seed) | 0 | 0 | 0 | 14,572 (code 7,660; markdown 6,911; context 1) |

- No agent-written or human-written context entries exist in either corpus.
- Caveat: these are corpus copies. A broad `find ~` for other `mcp_state.db` files timed out, so the live server DB was not located. **[inferred]** the live DB may differ.

### Implication for the hypothesis

- The observed retrieval benefit is over indexed docs and code. AGENTS.md's `project_context` row records a sealed eval where hybrid beat dense-only (nDCG@10 +0.144), but the downstream agent benefit over ripgrep was not established (A-B pass rate -0.067, CI [-0.333, +0.200]).
- The evidence supports "good retrieval over docs" more than "forced agent memory writes." The user's mechanism is untested.

## Trebol completion paths

### Subagents (`packages/tools/agents`)

- `AgentManager.spawn` (`packages/tools/agents/src/index.ts:115-122`) creates an entry and runs `execute` in the background. On settle it calls `onComplete` and, for background agents, emits `agent.completed` (`:122`).
- `execute` (`:127-132`) calls the runner and maps output to `AgentResult` with status `completed`, `failed` or `cancelled`. Default runner spawns `pi` with `PI_SWARM_SUBAGENT=1` (`:64-65`), takes stdout as `output` (`:68-70`), counts turns from the session file (`:70-82`).
- Return path: a `followUp` user message `[agent completed] id=... status=... output=...` (`index.ts:147-151`). **No memory write occurs on return.**
- `output` is raw final text, not structured.

### Subagent exclusion from memory

- `task-candidate-capture` returns early when `PI_SWARM_SUBAGENT=1` (`extensions/task-candidate-capture/extension.ts:10`).
- `knowledge-enrichment` returns early in the same case (`extensions/knowledge-enrichment/extension.ts:42`).
- `jev-knowledge-audit` disables itself for children (`extensions/jev-knowledge-audit/extension.ts:64`).
- **Consequence (observed):** a subagent's TaskManage answers and learned facts never reach the worktree store. **[inferred]** children do load TaskManage; not confirmed by running one.

### Completion gates

| Gate | Location | Enforces |
| --- | --- | --- |
| Missing answers reject completion | `packages/tools/taskmanage/src/task-manage.ts:664-677` | Every question needs an answer, only when the task has questions |
| Answer evidence resolution | `task-manage.ts:~678-745` (`splitEvidence` `:115-122`) | File spans/headings and tool refs must resolve |
| Malformed/duplicate question guard | `task-manage.ts:668-669` | Repair before completion |
| Child tasks complete first | `task-manage.ts:948-951` | No parent completion with open child |
| Create-as-completed rejected | `task-manage.ts:576` | Completion needs evidence-backed work |
| Acting-tool block without focused task | `packages/tools/taskmanage/src/task-hooks.ts:8`, `:289-290` | Blocks tools unless an in-progress active task exists; no memory check |
| Turn reminders | `task-hooks.ts:395`, `:336-363` | Advisory only |
| Bootstrap task-first + recall | `extensions/bootstrap/extension.ts:~170-177` | Establishes task, then `recallKnowledge` |

Questionless tasks: the answer check only runs when `task.questions` exists (guard at `task-manage.ts:664-677`). **[inferred from the guard]**; not executed.

### Memory capture and review

- `captureTaskCandidates` (`.pi/lib/state/task-candidate-capture.ts:21-66`) writes one `context` candidate per task, source `taskmanage:<session>:<task>` (`:63`).
- Each answer of a completed task becomes its own `fact` record, source `ANSWER_SOURCE:<session>:<task>:<question>` (`:84-90`), with evidence anchored at capture (`.pi/lib/state/answer-evidence.ts`). Auto-verified iff anchored refs exist and resolve.
- Capture triggers: `session_start` and every `TaskManage` `tool_result` (`extensions/task-candidate-capture/extension.ts:19-22`).
- Knowledge enrichment (LLM extraction, candidates) triggers on `session_before_compact` (`extensions/knowledge-enrichment/extension.ts:77`) and on settled turns.
- `reviewOneCandidate` (`.pi/lib/state/candidate-memory-review.ts:80-92`) takes a pending candidate with **exactly one** evidence ref that loads. A model must return a verbatim quote (`:107`) before it becomes `verified` (`:117-119`).
- Recall: `recallKnowledge` (`.pi/lib/context/knowledge-recall.ts:17-46`) excludes non-verified records (`:27`), re-checks answer evidence and drops stale spans (`:33-34`), then `index.retrieve(query, scope, 8)`. The user's measurements say this is lexical; the scoring function was not opened **[inferred lexical]**.
- Memory maintenance (`extensions/memory-maintenance/extension.ts:19`) is child-only queue logic gated by `PI_SWARM_SUBAGENT`.

### Attachment points for a "learned before finishing" gate

1. **TaskManage completion** (answer check `task-manage.ts:664-677`; completion branch near `:948`). Strongest: already the authoritative completion path, and rejections are model-visible.
2. **Subagent return** (`packages/tools/agents/src/index.ts:122`, `:147-151`). Currently an unstructured string.
3. **`session_before_compact`** (`knowledge-enrichment/extension.ts:77`). Too late to block; useful only for capture.
4. **`agent_before_settle`**: can add a draft; cannot easily prove an answer exists.

## Design

### Gate point

Gate at **TaskManage completion** for tasks that opt in to a durable-knowledge requirement, plus a **subagent return contract**. Do not gate session end: it cannot force useful writes and invites loops.

### What is required

Add an explicit answer role, not overload `context`:

- `learned` answers: `{question, answer, evidence, reusable: true}`. The answer states a fact a future agent would need that is not obvious from the code. Evidence must resolve (existing anchoring).
- Default answers stay session-local receipts, never recalled.
- A task whose question list includes a `learned` question must supply a non-empty answer; otherwise the gate is unchanged.

### Anti-gaming

- Resolvable evidence (already built) plus a verbatim quote check against the cited span (reuse `candidate-memory-review`'s quote rule).
- Dedupe before write: match existing records by evidence ref and token overlap; a near-duplicate must be superseded via `expectedRevision`, not added.
- Caps: e.g. 2 `learned` answers per task, per-session limit.
- Judge usefulness by behaviour, not count: a record is useful if a later session's recall cites it and the task completes without repeating its evidence reads. Records never cited after N sessions are quarantined.
- Permit an explicit "nothing reusable" answer with a reason; track its rate. A 100% "nothing" rate is a failure signal.
- Keep the one-candidate LLM reviewer as an independent check on `learned` answers. **[inferred]** LLM reviewers can be fooled by plausible prose; the quote check and resolvable evidence are the hard gates.

### Dedupe and supersede

- Key `learned` records by worktree plus normalized evidence set. A second answer citing the same spans supersedes via `expectedRevision`.
- Changed evidence marks the old record stale (existing re-check in `recallKnowledge`); the new answer must cite the new span.

### Subagent results

- Subagents return a structured block alongside `output`: `{learned: [...], answers: [...]}`, validated with the same answer schema.
- The parent writes records: its completion of the delegating task must accept or reject each child `learned` entry. One writer, parent-side evidence check.
- Child capture stays disabled (`PI_SWARM_SUBAGENT`); child answers are carried through the parent's completion.

### Backfill

- **684 task-snapshot candidates**: `context` records, no fact status. Keep as candidates; do not bulk-promote.
- **1,341 historical answers**: a file-span anchor (`path#Lx-Ly`, `path#Heading`) can be re-verified only if `git log --since=<session time> -- <path>` shows no change; otherwise re-anchor or drop. Tool refs (`tool:Name#n`) are session-scoped and cannot be re-verified once the session JSONL is gone, so most tool-anchored answers will stay unverifiable.
- Dry-run first: report counts per outcome, then measure recall impact on a held-out set before promotion.

### Retrieval

- Start with BM25 plus task-token overlap over verified records only: cheap and local. `recallShared` already does task-token ranking.
- Dense hybrid (BM25 + embeddings, RRF k=60, as in the sealed eval) needs spark or a local embedding model. Spark availability is a dependency risk **[inferred]**. Add only after the BM25 change is measured.

### Worktree and pwd scoping

- Keep the Git-toplevel key; records do not cross worktrees (`answer-evidence.ts` path bounds). Promote shared facts to `repository` scope explicitly, not automatically.

## Measurement plan

Question: does gated memory reduce repeated work across sessions?

Arms (paired, same repo state):
- **A**: no memory (empty memory dir, no recall).
- **B**: current memory (verified recall, as today).
- **C**: gated memory (learned answers, subagent ingestion, dedupe, new scorer).

Task set: 30-40 pairs in the same worktree where task 2 depends on facts from task 1, drawn from history where possible. Fresh sessions, same model and budget per arm.

Metrics:
- Primary: tool calls from session start to first correct edit or answer on task 2 (lower is better). Sub-metric: repeat reads of the same file spans.
- Secondary: `ask_user_question` count on task 2.
- Guardrail: task 2 acceptance pass rate (blind grading against the question list plus a hidden check); must stay within 5 points of A.
- Utilization: fraction of recalled records cited or used by task 2; "nothing reusable" rate in C.

Sample size **[inferred]**: paired design, SD of per-pair difference about 40% of mean, 40 pairs gives ~80% power at alpha 0.05 for a 20% reduction in tool calls. Run a 10-pair pilot first to measure the actual SD.

Success: C reduces the primary metric by at least 15% vs A with a 95% CI excluding zero; C is not worse than B; guardrail holds.

Failure modes to report: B may show no gain over A (the current state); C may gain only from writing more, not from records being used. Separate "records read" from "records used."

What this does not prove: no Agent-MCP A/B evidence was found in any artifact. The sealed retrieval eval showed no downstream gain over ripgrep. The 1.3% surfacing rate is a usage metric, not a benefit metric.

## Ranked rollout (value / cost)

1. **Measurement harness and utilization logging** (low cost, prerequisite): log recalled IDs vs cited IDs per session.
2. **BM25 recall over verified records with task-token overlap** (low cost): test precision on the 12 real past queries.
3. **Dedupe/supersede on write** (low-medium): stops the candidate pile growing.
4. **`learned` answer role gated at TaskManage completion** (medium): opt-in per task; compatibility preserved.
5. **Subagent structured return + parent-side ingestion** (medium-high): needed if subagents do substantive work.
6. **Quality-based quarantine** (medium): needs two or more sessions of data from step 1.
7. **Historical answer backfill** (medium, uncertain value): dry-run counts only until the harness shows benefit.
8. **Dense/hybrid retrieval** (higher cost, external dependency): only after step 2 is measured.

Session-end or compaction gates: rejected.

## Open questions

- Does a subagent load TaskManage and hooks at all? Run one child and inspect its session file.
- Does questionless-task completion skip evidence entirely? Read, not executed.
- Which live Agent-MCP DB runs in production? Not located on spark; only corpus copies were seen.
- Should `learned` be an explicit TaskManage question or a separate field? Reusing questions is cheaper.
- How often do LLM reviewers over-verify `learned` answers? Measure on a labelled set first.
