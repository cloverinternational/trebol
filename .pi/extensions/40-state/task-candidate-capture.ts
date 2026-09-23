import { captureTaskCandidates } from "../../lib/state/task-candidate-capture.ts";

const registered = new WeakSet<object>();
/** Reconcile after TaskManage rehydrates and after each tool result. TaskManage
 * is authoritative; this is only a candidate projection in the existing store. */
export default function taskCandidateCapture(pi: any): void {
  if (registered.has(pi)) return;
  registered.add(pi);
  const capture = (ctx: any) => {
    if (process.env.PI_SWARM_SUBAGENT === "1") return;
    const session = ctx?.sessionManager?.getSessionFile?.() ?? ctx?.sessionManager?.getSessionId?.();
    const manager = (globalThis as any)[Symbol.for("pi-swarm-task-manager")];
    if (!ctx?.cwd || !session || !manager?.snapshot) return;
    try {
      const tasks = manager.snapshot().tasks;
      if (Array.isArray(tasks)) captureTaskCandidates({ cwd: ctx.cwd, session, tasks });
    } catch { /* best-effort projection; TaskManage remains authoritative */ }
  };
  pi.on("session_start", (_event: unknown, ctx: any) => capture(ctx));
  // A sequential TaskManage batch may partially succeed. Reconcile its
  // authoritative snapshot even when the overall tool result is an error.
  pi.on("tool_result", (event: any, ctx: any) => { if (event?.toolName === "TaskManage") capture(ctx); });
}
