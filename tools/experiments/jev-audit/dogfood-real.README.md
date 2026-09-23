# Real-provider Jev audit dogfood

Run `node dogfood-real.mjs`. It uses one bounded real `pi -p` parent and one
restricted real fork (`clover-plexus/astra`), temporary fixture/workspace and
isolated `PI_SWARM_MEMORY_DIR`. Worker tools are explicitly allowlisted and Bash
is denied. The Jev finding is clearly labeled injected when no
`TYPESAFE_API_KEY` is present; credentials are never read or exported. Artifacts
are written under ignored `artifacts/jev-audit/dogfood-<time>/`.

## Integrated unscripted run

`TYPESAFE_API_KEY` in environment; run:
`node tools/experiments/jev-audit/dogfood-integrated.mjs`
Uses existing provider configuration (no copied credentials), but isolated
workspace, memory and autogen directories. Main agent/provider and Jev are real,
not scripted. 180-second process-group watchdog; artifacts retained for evidence.

Observed first run: parent completed fixture, reviewer failed because cleaned
assistant snapshot messages lacked usage.totalTokens. Runner now includes required
bounded usage metadata; opaque tool details and vault values remain excluded.

Observed second run (`integrated-1789679665427`): real main agent created NOTES.md
with PostgreSQL fact and untested-deployment caveat. Jev audit entries exist; actual
fork worker read evidence, wrote verified attributed fixture documentation with
same caveat, and recorded confirm verdict. Production recall test retrieved record
29ab2c78-af24-45be-bb6c-f626429e3bb5 from isolated store. No production-readiness
claim was promoted. Namespace first attempt failed, then worker corrected it;
review policy now explicitly says use default namespace.

Partial lifecycle: parent exited with last maintenance status running; child final
receipt not reconciled to parent. Successful record is not proof of successful
whole-worker completion or parent task reconciliation. Do not present this as
fully unattended service delivery. Need durable headless completion reconciliation.

The Dream-RSI-inspired prefix review prompt is active in maintenance runner;
offline policy-improvement prompt is saved but not executed. No replay simulator
or autonomous policy evolution is claimed. Global skill cleanup remains preview.
