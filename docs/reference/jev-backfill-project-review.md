# Staged project mapping and review integration

## Reference patterns, not imported runtimes

Agent-MCP local reference: https://github.com/rinadelph/Agent-MCP at
13d98b2c9e770a97a77521e605e7e41db024852d. Its project_context_tools.py uses
mutable SQLite project-context entries. Borrow project-local organization, not
INSERT OR REPLACE semantics or unproven knowledge-graph claims.

MemPalace: https://github.com/MemPalace/mempalace at
22fd87f09c19d5ffb2d6966486483353937931c0. Inspect
mempalace/convo_miner.py::_split_new_and_duplicate_conversations: hashes normalized
conversation text within a wing; source registry tracks unchanged imports.
Borrow scoped source registry/checkpoint ideas. Our stricter duplicate handling
requires proven ancestor identity, not matching prose alone. Project manifest/Git
signals may propose mappings; they do not override Pi's canonical identity.

## Implemented

- project_mapping.py maps existing cwd via Git common directory + worktree, matching
  memoryIdentity. Non-Git directories stay distinct. Missing paths remain unresolved;
  aliases require an explicit file, and mappings bind to scan-manifest hash.
- 627 sources:622 mapped /5 unresolved,11 repository-or-directory identities.
- lineage.py records duplicate dispositions without deleting sources. Real frozen
  headers supplied no parentSession edges:0 proven cross-file duplicates. Do not
  claim effective fork dedup or merge coincident text to inflate coverage.
- review_staged.py prepares3 bounded evidence windows with source/event/chunk/hash
  links, validates mapping/snapshot, and invokes restricted Pi memory worker.
  Mandatory isolated staging root,6-turn worker limit,90s process-group deadline,
  durable job reservations,max10 total including earlier exploratory reviewer.
- Three real clover-plexus/astra reviewer jobs completed. Two dated user-intent/
  decision records verified by the worker; one historical-goal candidate. These
  are attributed historical statements, NOT proof implementation exists today.

## Recall defect discovered and repaired

Workers chose custom namespaces, invisible to bootstrap's default namespace.
Worker now rejects non-default namespace: project separation comes from canonical
repository identity. Existing staging records were copied into default namespace
with original ID/revision attribution, preserving originals; no live store changed.
Opt-in backfill-staging.local.test verifies two default verified records recall in
own project and do not appear under other project identities. Candidate stays out.
The queries are tag-derived smoke checks, not independent retrieval-quality scores.

## Running and boundaries

```
python tools/experiments/jev-backfill/project_mapping.py artifacts/jev-backfill/staged-scan-v2
python tools/experiments/jev-backfill/review_staged.py artifacts/jev-backfill/staged-scan-v2
# Explicit paid reviewer, existing reservations prevent duplicate jobs:
python tools/experiments/jev-backfill/review_staged.py artifacts/jev-backfill/staged-scan-v2 --run --model clover-plexus/astra --max-jobs 1
```

Mapping is frozen and refuses overwrite. Run tests test_project_mapping.py,
test_review_staged.py,test_lineage.py. Full corpus classification is still not
complete:20 prior Jev calls,4 reviewer jobs total (1 exploratory +3 hard-budgeted).
No expanded Jev spend, no live promotion. Five unresolved mappings, changed/corrupt
sources, no proven cross-file lineage, richer independent quality evaluation and
source-context coverage remain open. No vendor edits or new memory database.
