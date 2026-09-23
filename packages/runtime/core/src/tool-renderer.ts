const MAX_DISPLAY_CHARS = 20_000;
export const TOOL_PREVIEW_LINES = 5;

/** Deliberately dependency-free: this helper is also used by headless tests and adapters. */
class ToolOutputComponent {
  private readonly value: string;
  constructor(value: string) { this.value = value; }
  render(width: number): string[] {
    if (!this.value) return [""];
    const lines: string[] = [];
    for (const source of this.value.split("\n")) {
      if (width <= 0 || source.length <= width) { lines.push(source); continue; }
      for (let offset = 0; offset < source.length; offset += width) lines.push(source.slice(offset, offset + width));
    }
    return lines;
  }
  invalidate(): void {}
}

class CollapsibleToolOutputComponent {
  constructor(private readonly inner: { render(width: number): string[]; invalidate?: () => void }, private readonly expanded = false) {}
  render(width: number): string[] {
    const rows = this.inner.render(width);
    if (this.expanded || rows.length <= TOOL_PREVIEW_LINES || rows.some((row) => row.includes("ctrl+o to expand"))) return rows;
    return [`... (${rows.length - TOOL_PREVIEW_LINES} earlier lines, ctrl+o to expand)`, ...rows.slice(-TOOL_PREVIEW_LINES)];
  }
  invalidate(): void { this.inner.invalidate?.(); }
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  try { return JSON.stringify(value, null, 2) ?? String(value); }
  catch { return String(value); }
}

function output(result: any, expanded: boolean): string {
  const parts = Array.isArray(result?.content) ? result.content : [];
  const text = parts.filter((part: any) => part?.type === "text" && typeof part.text === "string").map((part: any) => part.text).join("\n");
  const images = parts.filter((part: any) => part?.type === "image").map((part: any) => `[image: ${part.mimeType ?? "unknown"}]`);
  const body = [text, ...images].filter(Boolean).join("\n");
  const details = expanded && result?.details !== undefined ? stringify(result.details) : "";
  const value = [body, details ? `details:\n${details}` : ""].filter(Boolean).join("\n");
  if (value.length <= MAX_DISPLAY_CHARS) return value;
  return `${value.slice(0, MAX_DISPLAY_CHARS)}\n… [display truncated]`;
}

/** Adds only the missing renderer; tool-specific renderers remain authoritative. */
export function withDefaultToolRenderer<T extends Record<string, any>>(tool: T): T {
  if (typeof tool.renderResult === "function") {
    return {
      ...tool,
      renderResult(result: any, options: any, theme: any) {
        return new CollapsibleToolOutputComponent(tool.renderResult(result, options, theme), Boolean(options?.expanded));
      },
    } as T;
  }
  return {
    ...tool,
    renderResult(result: any, options: any, theme: any) {
      const value = output(result, Boolean(options?.expanded));
      const label = options?.isPartial ? "…" : result?.isError || options?.isError ? "✗ " : "";
      const failed = result?.isError || options?.isError;
      const raw = `${label}${value || (options?.isPartial ? "working" : failed ? "failed" : "done")}`;
      const styled = failed && typeof theme?.fg === "function" ? theme.fg("error", raw) : raw;
      return new CollapsibleToolOutputComponent(new ToolOutputComponent(styled), Boolean(options?.expanded));
    },
  } as T;
}
