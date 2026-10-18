# Memory pilot, pair-01 (exploratory; not pre-registered)

Harness: `tools/pilot/{trace-proxy,run-session,run-pair,analyze}.mjs` at f35d6a0.
Model: clover-plexus-anthropic/claude-haiku-5-5 (settings default), real provider via recording proxy.
Runs: `runs/pair-01-f35d6a0/` (t1, A-1, A-2, B-1, B-2, summary.json; `agent/` dirs omitted, they hold credentials).

| run | tool calls | memory lookups | records surfaced | model calls | max context chars |
|---|---|---|---|---|---|
| T1 (seed) | 6 | 1 search, 0 hits (empty store) | 0 | 6 | ~219k |
| A-1 / A-2 | 2 / 2 | 0 / 0 | 0 | 5 / 5 | 212k / 212k |
| B-1 / B-2 | 3 / 2 | 0 / 0 | 0 | 5 / 5 | 219k / 213k |

T1 wrote 3 `verified` taskmanage-answer records + 2 candidates into the arm-B store.

Why B cannot differ from A today:
1. No lookup: in T2 (a question, not a "task") neither arm called memory_history or bootstrap. The only
   recall instruction is `<memory_workflow>` at char ~78.8k of a ~78.9k-char system prompt (trace 001.req.json);
   bootstrap guidance is off per session by default (extensions/bootstrap/extension.ts:29-32).
2. Lookup would miss: memory_history search requires every >=3-char query term to appear in the record
   (extensions/memory-history/extension.ts:216-222). Replaying T1's own query and "tool_result_unavailable"
   against the seeded records: 0/5 hits; "evidence reference": 3/5.

Side finding fixed during the pilot: the Mermaid follow-up hijacked answers (#299), fixed in f35d6a0.
Context cost per model call: ~79k system + ~110k tool schemas (78 tools) before any message.
