# Attribution

The scenario fixtures in `scenarios/` are copied from
`codex-rs/apply-patch/tests/fixtures/scenarios` in openai/codex at commit
`430a16799d90e296fb27b1e94f206023902b7e56`. That upstream project is licensed
under the Apache License 2.0; the full text is in `LICENSE` and the upstream
`NOTICE` is in `NOTICE` (copied verbatim from the same commit).

`../oracle/trebol_oracle.rs` is Trebol's agent-path harness. It calls the
upstream `codex-apply-patch` public API and is not part of upstream.
