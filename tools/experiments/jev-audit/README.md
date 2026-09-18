# Jev first-finder dogfood

Uses installed Pi with this checkout as a package, a temporary foreign workspace,
temporary HOME/agent settings, and a local scripted agent provider. Six tool calls
exercise five-turn capture; no production memory/skill store is used. 90s watchdog.

```sh
# Actual Jev: explicitly opted-in paid HTTP, key supplied in environment only
JEV_SMOKE_LIVE=1 node tools/experiments/jev-audit/smoke.mjs
```

Verified live: installed extension counts five completed turns and injects the
review into the next outgoing provider context. The scripted agent does not review
or save memories, so this does NOT prove capture→review→write→recall completion.
Generic hook nudges are disabled in this isolated smoke; unit tests separately
verify legacy capture suppression. No audit wake-up turn is created.

Default mock mode uses fetch interception, which did not intercept calls in this
installed Pi build. It exits nonzero; do not claim mocked wire delivery passed.
Real Jev mode worked. JSON/stream artifacts are ignored and contain test data only.

## Memory worker fork smoke

Run `node tools/experiments/jev-audit/memory-worker-smoke.mjs` to exercise the
installed Pi CLI against a temporary visible snapshot containing
`Project Orion uses PostgreSQL.`. A localhost scripted provider drives the
restricted fork through `memory_history` search, `memory_evidence`, verified
`remember` with a matching quote, and a final verified search. The smoke uses
`--fork`, the real `memory-maintenance-worker.ts`, an isolated
`PI_SWARM_MEMORY_DIR`, and a strict 90-second watchdog; it asserts the exact
outgoing allowlist (`memory_evidence,memory_history`), no Bash, successful
receipt JSONL, a verified final result, a distinct child session, and an
untouched parent snapshot. No external network or paid API is used.
