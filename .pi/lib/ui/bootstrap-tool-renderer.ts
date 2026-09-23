import { redactKnowledge } from "../state/knowledge-store.ts";
/** Presentation-only renderer for the streaming bootstrap tool.
 *
 * The bootstrap tool owns execution and emits `BootstrapToolDetails` through
 * its normal onUpdate/result payload. This module deliberately keeps no
 * timers, does not infer completion, and never sends a message to the model.
 */

export type BootstrapStage =
  | "scope"
  | "selectors"
  | "task-draft"
  | "skills"
  | "tasks"
  | "complete";
export type BootstrapStatus = "running" | "complete" | "degraded" | "cancelled" | "failed";

export interface BootstrapCount { done: number; total?: number; }
export interface BootstrapFailure { summary: string; stage?: BootstrapStage; }
export interface BootstrapCitation { label: string; source?: string; }

/** The shape recommended for both execute `onUpdate` and the final details. */
export interface BootstrapToolDetails {
  stage: BootstrapStage;
  status: BootstrapStatus;
  mode?: "parallel" | "combined";
  model?: string;
  elapsedMs?: number;
  scope?: string;
  memory?: BootstrapCount;
  selectors?: BootstrapCount;
  skillsSelected?: number;
  skillsLoaded?: number;
  tasksDrafted?: number;
  tasksCommitted?: number;
  failures?: BootstrapFailure[];
  citations?: BootstrapCitation[];
  /** Set by the tool when the user requested expanded provenance. */
  showCitations?: boolean;
  /** Final execution brief is visible even in collapsed/default mode. */
  brief?: string;
}

export interface BootstrapRenderOptions {
  expanded?: boolean;
  isPartial?: boolean;
  isError?: boolean;
  width?: number;
}

const COLLAPSED_BRIEF_CHARS = 360;
const FULL_BRIEF_CHARS = 12000;
const MAX_FAILURES = 4;
const MAX_CITATIONS = 8;

const stageLabel: Record<BootstrapStage, string> = {
  scope: "scope resolution",
  selectors: "memory/skill selection",
  "task-draft": "optional task draft",
  skills: "skill loading",
  tasks: "authoritative task commit",
  complete: "complete",
};

function count(value: BootstrapCount | undefined): string {
  if (!value) return "";
  return `${value.done}/${value.total === undefined ? "?" : value.total}`;
}

function statusMark(status: BootstrapStatus, running: boolean): string {
  if (running) return "⋯";
  if (status === "complete") return "✓";
  if (status === "degraded") return "!";
  if (status === "cancelled") return "−";
  if (status === "failed") return "✗";
  return "⋯";
}

function clip(value: string, limit: number): string {
  const text = value.trim();
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 18)).trimEnd()} … [truncated]`;
}

function progressBar(stage: BootstrapStage, status: BootstrapStatus): string {
  if (status === "failed") return "[████░░░░]";
  if (status === "cancelled") return "[███░░░░░]";
  const stages: BootstrapStage[] = ["scope", "selectors", "skills", "task-draft", "tasks", "complete"];
  const filled = status === "complete" ? 8 : Math.max(1, Math.round(((Math.max(0, stages.indexOf(stage)) + 1) / stages.length) * 8));
  return `[${"█".repeat(filled)}${"░".repeat(8 - filled)}]`;
}

/** Pure, test-friendly formatting. No line contains a synthetic footer/header. */
export function formatBootstrapTool(details: BootstrapToolDetails | undefined, options: BootstrapRenderOptions = {}): string {
  if (options.isError) details = { ...(details ?? { stage: "scope" }), status: "failed" };
  if (!details) return options.isPartial ? "⋯ bootstrap: starting" : "bootstrap: no result";
  const running = details.status === "running";
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  const mark = running && details.elapsedMs !== undefined ? frames[Math.floor(details.elapsedMs / 250) % frames.length] : statusMark(details.status, running);
  const stage = stageLabel[details.stage] ?? details.stage ?? (options.isPartial ? "starting" : "result unavailable");
  const lines = [
    `${mark} bootstrap ${progressBar(details.stage, details.status)} ${stage}`,
    `  ${details.mode ? `mode=${details.mode} · ` : ""}${details.model ? `model=${details.model}` : "session model"}${details.elapsedMs !== undefined ? ` · ${Math.max(0, details.elapsedMs)}ms` : ""}`,
  ];
  if (details.scope) lines.push(`  ▸ scope  ${details.scope}`);
  const metrics = [
    details.memory && `memory ${count(details.memory)}`,
    details.selectors && `selectors ${count(details.selectors)}`,
    (details.skillsSelected !== undefined || details.skillsLoaded !== undefined) && `skills ${details.skillsLoaded ?? 0}/${details.skillsSelected ?? 0}`,
    (details.tasksDrafted !== undefined || details.tasksCommitted !== undefined) && `tasks ${details.tasksCommitted ?? 0}/${details.tasksDrafted ?? 0}`,
  ].filter(Boolean);
  if (metrics.length) lines.push(`  ▸ ${metrics.join("   ")}`);
  if (details.failures?.length) {
    lines.push("  ── failures ──");
    for (const failure of details.failures.slice(0, MAX_FAILURES)) lines.push(`  ✗ ${failure.stage ? `${failure.stage}: ` : ""}${clip(failure.summary, options.expanded ? 600 : 220)}`);
    if (details.failures.length > MAX_FAILURES) lines.push(`  … ${details.failures.length - MAX_FAILURES} more failures`);
  }
  if ((options.expanded || details.showCitations) && details.citations?.length) {
    lines.push("  ── evidence ──");
    for (const citation of details.citations.slice(0, MAX_CITATIONS)) lines.push(`  ↳ ${citation.label}${citation.source ? `: ${citation.source}` : ""}`);
  }
  if (details.brief) {
    lines.push("", options.expanded ? "  ── handoff ──" : "  ↳ handoff ready (ctrl+o to expand)");
    if (options.expanded) lines.push(clip(details.brief, FULL_BRIEF_CHARS));
    else lines.push(`  ${clip(details.brief.replace(/\s+/g, " "), COLLAPSED_BRIEF_CHARS)}`);
  }
  return lines.join("\n");
}

class BootstrapComponent {
  private value: string;
  constructor(value: string) { this.value = value; }
  setText(value: string): void { this.value = value; }
  invalidate(): void {}
  render(width: number): string[] {
    const limit = Math.max(1, Number.isFinite(width) ? width : 80);
    return this.value.split("\n").flatMap(line => {
      const chars = Array.from(line);
      if (!chars.length) return [""];
      const wrapped: string[] = [];
      for (let i = 0; i < chars.length; i += limit) wrapped.push(chars.slice(i, i + limit).join(""));
      return wrapped;
    });
  }
}

export interface BootstrapToolRenderer {
  renderCall(args: { scope?: string } | undefined, theme?: unknown, context?: unknown): BootstrapComponent;
  renderResult(result: { details?: BootstrapToolDetails; isError?: boolean; content?: Array<{type: string; text?: string}> }, options?: BootstrapRenderOptions, theme?: unknown, context?: unknown): BootstrapComponent;
}

/** Factory for a tool definition. State is event-derived; it has no clock or side effects. */
export function createBootstrapToolRenderer(): BootstrapToolRenderer {
  return {
    renderCall(args) {
      return new BootstrapComponent(`Bootstrap${args?.scope ? ` · scope=${args.scope}` : ""}`);
    },
    renderResult(result, options = {}) {
      // Each result belongs to one execution. Never reuse another call's
      // details: the renderer factory is shared across all tool rows.
      const details = result?.details;
      if (!details?.stage) {
        const text = (result?.content ?? []).filter(p => p.type === "text").map(p => p.text ?? "").join("\n");
        if (text) return new BootstrapComponent(`${result.isError ? "✗ Bootstrap failed" : "Bootstrap · result (display metadata missing)"}\n${redactKnowledge(text)}`);
        if (!options.isPartial) return new BootstrapComponent("! Bootstrap returned no displayable result. Completion is unknown. Check .swarmpi/execution/ for this run; an existing task does not prove bootstrap succeeded.");
      }
      return new BootstrapComponent(formatBootstrapTool(details, { ...options, isError: options.isError || result?.isError }));
    },
  };
}
