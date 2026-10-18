# Downstream A/B pre-registration (sealed before any scored run)

- Questions: 15 test qids, chosen mechanically by ab/select_ab.py. Eligible qids have at least one grade-2 qrels passage that has a line span (passages.jsonl `lines` set and `summary` false; excludes memory notes and file summaries). They are sorted by sha256("20261018"+qid) and the first 15 are taken.
- Model: clover-plexus-anthropic/claude-haiku-5-5, default thinking. One run per question per arm (30 runs). Runs alternate per question: A then B for even indices, B then A for odd.
- Pi flags (both arms): --no-extensions --no-skills --no-context-files --no-session --no-prompt-templates --no-mcp --mode json -p. cwd is the repo. 300 s wall limit.
  - Arm B (rg only): --tools read,grep,find,ls. Pi's grep is ripgrep.
  - Arm A: the same tools plus project_context (--extension extensions/project-context/extension.ts).
- Prompt (identical in both arms, template in ab/run_ab.mjs): the developer's search text and need, plus an instruction to reply with up to 3 `path#Lx-Ly` citations.
- Scoring (script ab/score_ab.py, no human or LLM grading, so no blinding is needed):
  - pass: any citation's line range overlaps a grade-2 qrels passage span in the same file. This is the primary metric.
  - pass1: the same check at grade >= 1.
  - citation precision: cited lines exist, and the range overlaps a grade >= 1 span. The denominator is all citations.
  - unjudged share: citations overlapping no pooled passage. Reported because qrels were pooled from retrievers and can under-credit rg-found answers.
  - tool calls: count of tool_execution_end events. Tokens: the sum of usage.totalTokens over assistant message_end events.
- Analysis: paired difference A−B in pass rate. Paired bootstrap over questions, 10k resamples, seed 20261018, 95% percentile CI. Exact two-sided sign test on discordant pairs.
- Decision: "project_context helps" only if the pass-rate CI lower bound is > 0. If the CI includes 0, the result is "not established". The MMD is 1 question (0.067). n=15 is expected to be underpowered.
- Invalid run: pi exits non-zero, the run times out, or project_context returns an error from spark being unreachable. An invalid run is retried once; if it fails again it is reported, excluded, and scored with its pair dropped.
