/**
 * Vitest setup: keep every test's machine-local runtime state out of the developer's
 * real `~/.local/state/pi-swarm`.
 *
 * Claw, the scheduler and the diagnostics log all resolve their state root from
 * `PI_SWARM_STATE_DIR` (`.pi/lib/state/workspace-state.ts`). Suites build stores from
 * throwaway workspaces, so without this they would each leave a
 * `workspaces/<temp-dir-key>/` folder behind in the real state directory — the same
 * litter, relocated. One temp root per worker process; child processes inherit it.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.PI_SWARM_STATE_DIR?.trim()) {
  const root = mkdtempSync(join(tmpdir(), `pi-swarm-state-${process.pid}-`));
  process.env.PI_SWARM_STATE_DIR = root;
  process.on("exit", () => { try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ } });
}
