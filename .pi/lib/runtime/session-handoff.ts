// Structural host/test adapters intentionally accept heterogeneous event and tool payloads; runtime guards narrow the fields used here.
import { randomUUID } from "node:crypto";
import { dispatchRegisteredHook } from "./hook-state.ts";

// Explicit registration bridge for lifecycle code (supervisor task reconciliation)
// that must invoke TaskManage without an ExtensionToolContext.
// Adapters replace their registration on reload; this does not create managers.
// Pi loads extensions in separate jiti module graphs. Share only registrations,
// never domain state; owning adapters refresh these definitions on each load.
const key = Symbol.for("pi-swarm-session-handoff-tools");
const sessions: Map<string, Map<string, { owner: object; tool: any }>> = (globalThis as any)[key] ??= new Map();
const sessionId = (ctx: any) => ctx?.sessionManager?.getSessionId?.();
export function registerSessionHandoff(pi: any, tool: any) {
  if (tool.name !== "TaskManage") return;
  const owner = {};
  let id: string | undefined;
  const release = () => {
    if (!id) return;
    const tools = sessions.get(id);
    if (tools?.get(tool.name)?.owner === owner) tools.delete(tool.name);
    if (tools?.size === 0) sessions.delete(id);
    id = undefined;
  };
  pi.on("session_start", (_event: any, ctx: any) => {
    release(); id = sessionId(ctx); if (!id) return;
    const tools = sessions.get(id) ?? new Map();
    tools.set(tool.name, { owner, tool }); sessions.set(id, tools);
  });
  pi.on("session_shutdown", release);
}
export async function dispatchSessionHandoff(name: "TaskManage", input: any, signal: AbortSignal, ctx: any, active: string[]) {
  if (signal.aborted) throw new Error("Handoff cancelled");
  if (!active.includes(name)) throw new Error(`${name} is not active; a handoff cannot widen tool permissions`);
  if (typeof ctx?.executeTool === "function") {
    const outcome = await ctx.executeTool(name, input, { signal });
    if (signal.aborted) throw new Error("Handoff cancelled");
    if (outcome.isError || outcome.result?.isError) throw new Error(outcome.result?.content?.[0]?.text || `${name} failed`);
    return outcome.result;
  }
  // Lifecycle-driven supervisor reconciliation has no ExtensionToolContext.
  // Keep its compatibility path explicit until it is moved to a host tool.
  const tool = sessions.get(sessionId(ctx))?.get(name)?.tool;
  if (!tool) throw new Error(`${name} is unavailable for session handoff`);
  const event = { toolName: name, toolCallId: `handoff-${randomUUID()}`, input };
  const before = await dispatchRegisteredHook("tool_call", event, ctx);
  if (before?.block) throw new Error(before.reason || `${name} blocked`);
  let result: any;
  try { result = await tool.execute(event.toolCallId, input, signal, undefined, ctx); }
  catch (error) { result = { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] }; }
  const after = await dispatchRegisteredHook("tool_result", { ...event, ...result }, ctx);
  result = { ...result, ...(after ?? {}) };
  if (result.isError) throw new Error(result.content?.[0]?.text || `${name} failed`);
  return result;
}
