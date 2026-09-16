# Bootstrap-agent experiment harness

This is an isolated, opt-in benchmark harness. It uses synthetic evidence and
real `pi -p --model clover-plexus/claude-fable-5` subprocesses with tools,
extensions, context files, and skills disabled. Selector IDs are resolved only
against the supplied corpus; evidence and task proposals remain untrusted.

Run the requested screening (three cases × four arms):

```sh
node tools/experiments/bootstrap-agent/runner.mjs
```

Outputs are generated under ignored `artifacts/bootstrap-agent/`. Token usage
is reported only when Pi's JSON response exposes it; otherwise it is explicitly
`unavailable`. This harness does not create production tasks, persist memory,
or prove first-call integration.

## Historical planning screening

`planning-contract.mjs` exposes an experimental baseline/candidate prompt builder
and a strict plan/dependency validator. It does not change production bootstrap.
Use private, ignored artifacts for consented historical task/evidence replays;
never commit conversation records or reasoning streams. Persist only visible
final outputs and bounded provenance. Keep evidence identical between arms,
record criteria before running, repeat in counterbalanced order, and review each
action manually. Schema validity is not plan correctness. Report missing evidence
and transfer regressions; do not tune indefinitely against the same examples.

Current private screening records live under `artifacts/bootstrap-replay/`.
They measure planning only, not memory retrieval, implementation or real reboot
behavior. Original memory candidate pools were not retained. A historical task
replayed against current source is not an exact historical execution replay.

Validation: `npx vitest run tests/bootstrap-planning-contract.test.ts`.
