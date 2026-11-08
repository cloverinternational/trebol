// Never report a passing integration test without exercising a database/worker.
console.error("NOT IMPLEMENTED: no live Postgres/Absurd acceptance test is wired. " +
  "The optional fixture is in infra/postgres; worker adapters are experimental. " +
  "Setting a database URL does not validate enqueue, execution, or recovery.");
process.exitCode = 2;
