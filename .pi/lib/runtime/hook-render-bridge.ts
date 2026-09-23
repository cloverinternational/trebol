import { Container, Text } from "@earendil-works/pi-tui";
import { getHookObservations, subscribeHookObservations } from "./hook-observations.ts";
import { hookRowsVisible } from "./hook-state.ts";
import { renderHookPresentation } from "./hook-presenter.ts";
import { withDefaultToolRenderer } from "../../../packages/runtime/core/src/tool-renderer.ts";

const WRAPPED = Symbol.for("pi-swarm-hook-render-wrapper");

function trace(stage: string, data: Record<string, unknown>) {
  if (process.env.SWARM_HOOK_TRACE !== "1") return;
  try { console.error(JSON.stringify({ stage, ...data })); } catch { /* diagnostics never affect rendering */ }
}

class HookRowsComponent extends Container {
  private readonly unsubscribe: () => void;
  private renderBase: () => any;
  private callArgs: any;
  constructor(private readonly id: string, renderBase: () => any, private readonly phase: "pre" | "post", private readonly theme: any, private readonly invalidateRow: () => void) {
    super();
    this.renderBase = renderBase;
    this.unsubscribe = subscribeHookObservations(id, () => { this.invalidateRow(); });
  }
  setRenderBase(renderBase: () => any): void { this.renderBase = renderBase; }
  setCallArgs(args: any, invalidate = false): void {
    this.callArgs = args;
    if (invalidate) this.invalidateRow();
  }
  getCallArgs(): any { return this.callArgs; }
  updateArgs(args: any): void { this.setCallArgs(args, true); }
  dispose(): void { this.unsubscribe(); this.clear(); }
  render(width: number): string[] {
    const hooks = hookRowsVisible() ? getHookObservations(this.id)[this.phase] : [];
    trace("hook-rows-render", { toolCallId: this.id, phase: this.phase, count: hooks.length, visible: hookRowsVisible() });
    const lines: string[] = [];
    if (this.phase === "pre") for (const hook of hooks) lines.push(...renderHookPresentation({ hook: hook.hookName, phase: "before", outcome: hook.outcome, reason: hook.reason, output: hook.output }, this.theme).render(width));
    const base = this.renderBase(); if (base) lines.push(...base.render(width));
    if (this.phase === "post") for (const hook of hooks) lines.push(...renderHookPresentation({ hook: hook.hookName, phase: "after", outcome: hook.outcome, reason: hook.reason, output: hook.output }, this.theme).render(width));
    trace("hook-rows-lines", { toolCallId: this.id, phase: this.phase, count: lines.length, first: lines[0] ?? "" });
    return lines;
  }
}

export function wrapToolForHookRows(tool: any): any {
  if (!tool || tool[WRAPPED]) return tool;
  tool = withDefaultToolRenderer(tool);
  trace("renderer-wrapper-created", { tool: tool.name });
  const originalCall = tool.renderCall;
  const originalResult = tool.renderResult;
  const wrapped: any = {
    ...tool,
    [WRAPPED]: true,
    async execute(...args: any[]) { return tool.execute(...args); },
    renderCall(args: any, theme: any, context: any) {
      const id = String(context?.toolCallId ?? "");
      trace("render-call", { tool: tool.name, toolCallId: id });
      trace("render-call-context", { tool: tool.name, toolCallId: id, hasInvalidate: typeof context?.invalidate === "function" });
      const state = context?.state ?? {};
      // Pi streams tool arguments after the first renderCall and updates the
      // existing component via updateArgs; it does not call renderCall again.
      // Read mutable state at render time so the wrapped renderer does not keep
      // the initial `{}`/partial arguments (which rendered `$ ...`).
      const base = () => originalCall?.(
        state.piSwarmHookRowsPre?.getCallArgs() ?? args,
        theme,
        { ...context, executionStarted: state.piSwarmExecutionStarted ?? context?.executionStarted },
      ) ?? new Text(theme.fg("toolTitle", tool.label ?? tool.name), 0, 0);
      state.piSwarmHookRowsPre ??= new HookRowsComponent(id, base, "pre", theme, context?.invalidate ?? (() => {}));
      state.piSwarmHookRowsPre.setRenderBase(base);
      state.piSwarmHookRowsPre.setCallArgs(args);
      return state.piSwarmHookRowsPre;
    },
    renderResult(result: any, options: any, theme: any, context: any) {
      const id = String(context?.toolCallId ?? "");
      trace("render-result", { tool: tool.name, toolCallId: id });
      trace("render-result-context", { tool: tool.name, toolCallId: id, hasInvalidate: typeof context?.invalidate === "function" });
      const state = context?.state ?? {};
      // The call renderer may have been created before execution started. Pi
      // keeps that component and only sends updateResult events afterward, so
      // propagate the live lifecycle bit through the shared renderer state.
      state.piSwarmExecutionStarted = context?.executionStarted === true;
      const base = () => originalResult?.(result, options, theme, context) ?? new Text(result?.isError ? theme.fg("error", "failed") : theme.fg("success", "done"), 0, 0);
      state.piSwarmHookRowsPost ??= new HookRowsComponent(id, base, "post", theme, context?.invalidate ?? (() => {}));
      state.piSwarmHookRowsPost.setRenderBase(base);
      return state.piSwarmHookRowsPost;
    },
  };
  return wrapped;
}
