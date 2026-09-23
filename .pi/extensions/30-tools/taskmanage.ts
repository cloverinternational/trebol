import {
  registerTaskHooks,
  registerTaskManage,
  type HookConfig,
} from "../../../packages/tools/taskmanage/src/index.ts";
import "../../lib/runtime/hook-state.ts";
import { withSwarmToolSurface, rawPi } from "../../lib/runtime/swarm-tool-surface.ts";
import { registerSwarmBuiltinHooks } from "../../lib/runtime/swarm-builtin-hooks-runtime.ts";
import { registerBootstrapHandoff } from "../../lib/runtime/bootstrap-dispatch.ts";
import { openTaskBrowser } from "./task-browser.ts";

/**
 * Minimal structural subset of Pi's ExtensionAPI used by TaskManage.
 *
 * Keeping this adapter structural means the standalone package does not need
 * to depend on a particular Pi release just to remain buildable and testable.
 */
export interface TaskManageExtensionAPI {
  registerTool(tool: unknown): void;
  appendEntry(type: string, data: unknown): void;
  registerCommand?(name: string, spec: { description: string; handler: (args: string, ctx: any) => unknown }): void;
  registerShortcut?(shortcut: string, spec: { description: string; handler: (ctx: any) => unknown }): void;
  on(
    event: string,
    handler: (
      event: unknown,
      ctx: { sessionManager?: { getEntries(): readonly unknown[] } },
    ) => unknown,
  ): void;
}

export interface TaskManageExtensionOptions extends HookConfig { headless?: boolean; interactionTimeoutMs?: number; }

/**
 * Register the canonical TaskManage tool and its lifecycle coordinator.
 *
 * The manager is intentionally created once per Pi extension instance and is
 * shared by both registrations. Pi reloads create a new instance; the
 * session_start handler rehydrates it from the replacement session manager.
 */
const taskRuntimeByPi = new WeakMap<object, { manager: any; hooks: any; interactions: any }>();
export function registerTaskManageExtension(
  pi: TaskManageExtensionAPI,
  options?: TaskManageExtensionOptions,
) {
  const owner = rawPi(pi as object);
  const existing = taskRuntimeByPi.get(owner);
  if (existing) return existing;
  const bridged: any[] = [];
  const registrationPi = { ...pi, registerTool: (tool: unknown) => { registerBootstrapHandoff(tool); bridged.push(tool); pi.registerTool(tool); } };
  const manager = registerTaskManage(registrationPi, undefined, { workspaceRoot: process.cwd() });
  pi.on("before_agent_start", (event: any) => ({
    systemPrompt: String(event.systemPrompt ?? "") + "\n<task_completion_contract>Read each task's questions before implementation and treat them as explicit acceptance obligations. A successful code edit or test is not a successful TaskManage completion. To complete a question-bearing task, supply answers:[{question:QUESTION_ID,answer:TRUTHFUL_ANSWER,evidence:WORKSPACE_FILE_REFERENCE}] covering every question in the same completion operation. Evidence must use a real file#Heading or file#Lx-Ly reference. If TaskManage rejects completion, acknowledge the failure, read the current task and exact error, and change the missing/invalid input before retrying. Never repeat an unchanged rejected completion, delete questions to bypass validation, or invent evidence. If an answer cannot be established, keep the task unfinished with a blocker and clearly distinguish implemented changes from verified completion in your final response. Use ask_user_question only for decisions requiring the user, not questions you can answer by inspecting or testing.</task_completion_contract>"
  }));
  // Swarm's builtin task hooks (.pi/lib/runtime/swarm-builtin-hooks.ts) read
  // task state through this handle; the coordinator below keeps only the
  // task-audit bookkeeping so no second copy of the nudges reaches the model.
  (globalThis as any)[Symbol.for("pi-swarm-task-manager")] = manager;
  (pi as any).codemodeTools = [...((pi as any).codemodeTools ?? []), ...bridged];
  // Swarm's builtin hooks (task-enforcement, task-maintenance, skill budget,
  // sleep/stdin, annoyance) in HooksManager order; idempotent per Pi instance.
  registerSwarmBuiltinHooks(pi, {
    // Canonical hook pipeline owns enforcement; the secondary coordinator is
    // silent bookkeeping only. Acting without a focused task must be blocked.
    enforcementMode: options?.enforcementMode ?? "block",
    completion: {
      enabled: options?.enforcementMode !== "off",
      toolThreshold: options?.maintenanceToolThreshold ?? 8,
      maxNudges: 3,
    },
  });
  // Keep the secondary coordinator silent: the canonical pipeline above owns
  // task gates and lifecycle guidance, avoiding duplicate visible hooks.
  const hooks = registerTaskHooks(pi, manager, { ...options, enforcementMode: "off", silent: true });
  // ask_user_question is provided by the forked ask-user extension (30-tools/ask-user).
  // Keep interaction registration here out of the root extension: Pi rejects
  // duplicate tool names when both extensions are auto-loaded.
  const open = (ctx: any) => { if (ctx?.hasUI === false || !ctx.ui?.custom) { ctx?.ui?.notify?.("/tasks requires interactive TUI mode.", "error"); return; } return openTaskBrowser(ctx, manager); };
  pi.registerCommand?.("tasks", { description: "Open the read-only task browser", handler: async (_args, ctx) => open(ctx) });
  // Ctrl+T is reserved by Pi thinking controls; use a distinct Swarm binding.
  pi.registerShortcut?.("ctrl+alt+shift+j", { description: "Open the read-only task browser", handler: open });
  const result = { manager, hooks };
  taskRuntimeByPi.set(owner, result);
  return result;
}

export default function taskManageExtension(pi: TaskManageExtensionAPI): void {
  registerTaskManageExtension(withSwarmToolSurface(pi));
}
