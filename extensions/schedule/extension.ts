import { join, resolve } from "node:path";
import { adoptLegacyFile, workspaceStateDir } from "../../.pi/lib/state/workspace-state.ts";
import { registerScheduleTools, Scheduler, ScheduleStore, type SchedulerOptions } from "../../packages/tools/schedule/src/index.ts";
import { withDefaultToolRenderer } from "../../packages/runtime/core/src/tool-renderer.ts";

export interface ScheduleExtensionAPI {
  getCwd?(): string;
  registerTool(tool: unknown): void;
  sendUserMessage(content: string, options?: { deliverAs?: "steer" | "followUp"; triggerTurn?: boolean }): void | Promise<void>;
  on?(event: string, handler: (...args: any[]) => unknown): void;
}

export interface ScheduleExtensionOptions extends Omit<SchedulerOptions, "sink" | "workDir"> {
  workDir?: string;
}

export async function registerScheduleExtension(
  pi: ScheduleExtensionAPI,
  options: ScheduleExtensionOptions = {},
): Promise<Scheduler> {
  const workDir = resolve(options.workDir ?? pi.getCwd?.() ?? process.cwd());
  // Scheduled tasks are session-local runtime state, not project content: keep them in
  // the per-user state root so `/loop` and `/goal` no longer leave `.swarm/scheduled_tasks.json`
  // untracked in the user's repository. A legacy in-repo file is adopted once.
  const storePath = join(workspaceStateDir(workDir), "scheduled_tasks.json");
  adoptLegacyFile(join(workDir, ".swarm", "scheduled_tasks.json"), storePath);
  const scheduler = new Scheduler({
    ...options,
    workDir,
    store: options.store ?? new ScheduleStore(storePath),
    sink: async (prompt) => {
      await pi.sendUserMessage(prompt, { deliverAs: "followUp", triggerTurn: true });
    },
  });
  registerScheduleTools({ ...pi, registerTool: (tool: unknown) => pi.registerTool(withDefaultToolRenderer(tool as any)) }, scheduler);
  await scheduler.start();
  pi.on?.("session_shutdown", () => scheduler.stop());
  return scheduler;
}

export default async function scheduleExtension(pi: ScheduleExtensionAPI): Promise<void> {
  await registerScheduleExtension(pi);
}
