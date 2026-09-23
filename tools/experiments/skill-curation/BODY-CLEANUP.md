# Repeatable active skill-body cleanup

No model calls or global source edits. Existing Jev findings are hints; changed
source hashes are reported as stale, not silently reused. Run from Pi-Swarm root.

## Plan
```
python tools/experiments/skill-curation/body_cleanup.py plan \
 --root ~/.swarm/skills/autogen \
 --findings artifacts/jev-backfill/full-skill-classification-v1/cleanup-queue.jsonl \
 --out artifacts/skill-curation/body-cleanup-v1
```
Plan ranks active SKILL.md files by size and emits stable source-hash-bound H2
section IDs. Nested sections stay inside their parent span. Introductory content
is retained. Read the actual source before making decisions. Review file format:
```
[{"id":"SECTION_ID","action":"split","reviewed":true,
  "reviewer":"review identity","rationale":"source-linked reasoning",
  "procedure":"## Heading\nReviewed actionable guidance"}]
```
A reviewed flag is an attributed decision, not an independently enforced truth.

## Preview and verify
```
python tools/experiments/skill-curation/body_cleanup.py preview \
 --plan artifacts/skill-curation/body-cleanup-v1/plan.json \
 --decisions artifacts/skill-curation/body-cleanup-v1/reviewed-decisions.json \
 --out artifacts/skill-curation/body-cleanup-v1/previews
python tools/experiments/skill-curation/body_cleanup.py verify \
 artifacts/skill-curation/body-cleanup-v1/previews/clover-platform-operations
```
Unreviewed/unknown/duplicate decisions and source drift are rejected. Every split
preserves exact source text in a relative reference and inserts an explicit load
pointer. Verification reconstructs the entire original from preview+references.
Identical reruns reuse validated previews; differing previews require a new run.

## Publish separately
Inspect final diff and fresh SkillManage view/revision. Write preserved support
files first, then patch body with the latest expectedRevision. Never publish a
preview merely because reconstruction passes: semantic no-loss review is still
required. Project-memory migration additionally needs owner/evidence verification
and retrieval checks. Do not overwrite other support files or archive originals.

Explicit approved publication through the canonical SkillManage manager (not raw
file edits), after semantic review:
```
npx vite-node tools/experiments/skill-curation/publish_body.ts PREVIEW_FOLDER
npx vite-node tools/experiments/skill-curation/publish_body.ts PREVIEW_FOLDER --apply
```
Receipt records each revision. Refuse stale sources, support collisions and prior
receipts. Partial writes require inspection; do not delete the receipt to force retry.
The canonical patch normalizes metadata/increments version; verification compares
instruction content and support bytes, not unchanged SKILL.md frontmatter.
