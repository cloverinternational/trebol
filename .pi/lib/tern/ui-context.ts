// Pure helpers for Pi UI text (widget lines, task snapshots). The bound ExtensionUIContext is ext-ui.ts.

const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
const CONTROL_RE = /[\x00-\x08\x0b-\x1f\x7f]/g;

export const UI_LINE_LIMIT = 8;

// Strips terminal escapes and control bytes, then bounds each line to width with an ellipsis.
export function sanitizeUiLines(lines: readonly string[], width: number, maxLines: number = UI_LINE_LIMIT): string[] {
	const cols = Math.max(1, Math.floor(width));
	const out: string[] = [];
	for (const raw of lines) {
		if (out.length >= maxLines) break;
		const clean = raw.replace(ANSI_RE, "").replace(/\r\n?|\n/g, " ").replace(CONTROL_RE, "");
		const chars = Array.from(clean);
		out.push(chars.length > cols ? `${chars.slice(0, Math.max(0, cols - 1)).join("")}…` : clean);
	}
	return out;
}

// Task and footer snapshots arrive as untrusted strings; anything that is not a string is dropped.
export function uiTextOf(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}
