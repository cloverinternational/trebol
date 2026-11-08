# Experimental Absurd worker adapters

Not part of the local agent implementation or its module graph. No runnable,
production daemon assembly is provided. These adapters require an injected Pi
runtime factory and a configured Absurd/Postgres database.

- `src/worker-daemon.ts`: worker lifecycle library, not a CLI/service.
- `src/general-agent-adapter.ts`: task/checkpoint adapter.
- `src/absurd-control-plane.ts`: experimental dispatcher with **in-memory**
  agent/job/idempotency/event metadata. Database task persistence does not make
  this control plane restart-safe.

Build explicitly: `npm run build:experimental`. Tests use injected fakes and do
not certify live Postgres execution, authorization, or recovery. The workspace
still installs dependencies with the root workspace install; this separation
removes runtime/build coupling, not dependency installation altogether.

Before promotion: runnable authenticated daemon composition, host policy
enforcement, durable metadata/recovery, and real database acceptance tests.
