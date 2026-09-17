# Memory harness behavior: source review

This is a source-level comparison, not evidence that upstream behavior works in
Pi. Pinned revisions and files are listed in
`docs/plans/active/memory-lifecycle-and-agent-guidance.md`. Public Claude Code
documentation is not a substitute for inaccessible implementation prompts.

## Trigger, prompt, and consequence

| System | Mechanism inspected | Behavioral effect | Pi adaptation |
| --- | --- | --- | --- |
| OpenClaw | Active-memory retrieval prompt and compaction-cycle flush guard | Latest request guides recall; unavailable is not empty; mutable facts carry timestamps; repeated flushes in a cycle are suppressed | Bounded query, distinct retrieval outcomes, persisted deduplication cursor |
| Letta Code | Memory-initialization skill | Compact core index points into topic files; descriptions guide discovery | Topic/section cards and selective cited reads |
| Claude-Mem | SessionStart/UserPromptSubmit/PostToolUse/Stop hooks, observation prompt builder, code-mode prompt fragments, memory-search skill | Work produces observations; startup consumes prior context; retrieval expands from index to timeline to details | A real producer/consumer loop with evidence refs; histories remain separate from verified knowledge |
| Compound Engineering | Compound skill and assembly reference | Qualifying reasoning is grounded against current source, existing docs are updated, no-write is valid | Preserve decision rationale; deduplicate before writing; verify claims before promotion |

## Prompt details worth preserving

OpenClaw's active-memory prompt explicitly says unavailable recall does not mean
no relevant memory exists. It distinguishes current operational health from old
observations, instructing the answering agent to verify live facts. A compact
summary without freshness metadata would lose this distinction.

Claude-Mem's observation builder supplies tool parameters and outcomes, marks
elided text, and forbids inference about omitted ranges. Prior context says not
to re-record already captured work. Its mode fragments focus on discoveries
rather than narration about the observer. These details explain how a hook's
payload and prompt jointly shape capture behavior.

Compound's assembly reference reconciles overlap before writing and marks
session-sourced information. It explicitly requires reading defining source
before asserting behavior in a glossary. This matters for historical backfill:
a past assistant summary is evidence of a claim, not proof of current behavior.

## Do not copy these restrictions or assumptions

- Letta's initialization skill mixes identity construction, personality inference,
  behavioral rules, and knowledge. Pi's memory must preserve the agreed knowledge
  versus skill boundary; do not infer personal traits or impose file-count quotas.
- Claude-Mem's code-mode observer asks for facts about what is now fixed or
  deployed. Tool evidence may prove only a local edit. Preserve epistemic status
  rather than adopting those verbs uncritically.
- Claude-Mem's code-mode skip fragment says to return an empty response, while
  its observation builder permits a skip XML tag. Pi needs one explicit skip
  schema, not competing instructions.
- Its search skill mandates filtering before every detail read. Prefer bounded
  discovery, but allow direct reads of known cited IDs; do not add ceremony.
- Compound's one-learning-per-run rule and mode-specific mandatory reference
  reads are implementation choices, not universal memory requirements.
- A stop-hook summary is working context, not automatically durable project
  knowledge. Assistant completion prose alone must not authorize promotion.

## Pi acceptance boundary

Capture uses visible evidence, scoped ownership and freshness. Storage preserves
corrections and tombstones. Retrieval offers source cards then bounded reads.
Bootstrap returns cited knowledge and already-loaded skill instructions once.
Core context advertises the index without importing the entire archive.
Automatic project/worktree saves apply only to verified knowledge; uncertainty
or conflict remains a candidate. Global promotion requires explicit approval.

Proof requires a real installed-extension capture, restart, retrieval,
correction and deletion round trip, plus foreign-project isolation. Unit tests
with invented agent APIs do not establish this.
