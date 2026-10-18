# Manual labels for sample.txt (seed 20261018, n=25 of 672 answered TaskManage candidates)
Single labeller (agent), not blind, not adjudicated. Staleness was checked only for trebol paths.

| label | n | ids |
|---|---|---|
| durable + currently correct | 8 | S03 S04* S06 S15 S16 S21 S23 S25 |
| durable but stale now | 2 | S05 (`.pi/extensions/10-context/mandatory-compaction.ts` missing; no `mandatory-compaction` in repo), S10 (claims /btw has no overlay; `extensions/swarm-btw/extension.ts` L120-121 now sets `overlay: true`) |
| session receipt (files read / tests passed / commit made) | 14 | S01 S02 S07 S08 S09 S11 S12 S13 S14 S17 S18 S20 S22 S24 |
| malformed (answer does not answer question) | 1 | S19 ("Which styles…?" -> "Yes. …") |

\* S04 holds host IPs, user@host pairs and partial key fingerprints in a candidate record; redaction did not remove them.
