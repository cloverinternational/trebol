// Kanban rendering for the TaskManage overlay. Pure: consumes the board model and
// returns lines; holds no semantic state (selection lives in the model caller).
import { BOARD_COLUMNS, type BoardModel, type BoardSelection, type BoardTask } from "../../.pi/lib/tern/task-board.ts";

export interface BoardCard extends BoardTask {
	subject: string;
	active?: boolean;
	blocked?: boolean;
}

export interface BoardRenderLayout {
	visibleWidth?: (text: string) => number;
	truncateToWidth: (text: string, width: number) => string;
}

export interface BoardRenderTheme {
	fg?: (color: string, text: string) => string;
	bold?: (text: string) => string;
}

const STATUS_MARK: Record<string, string> = { todo: "○", in_progress: "◐", done: "●" };
const MIN_COLUMN = 20;

export function renderBoard(model: BoardModel<BoardCard>, sel: BoardSelection, width: number, layout: BoardRenderLayout, theme: BoardRenderTheme): string[] {
	const colWidth = Math.max(MIN_COLUMN, Math.floor(width / BOARD_COLUMNS.length));
	const visibleCols = Math.max(1, Math.min(BOARD_COLUMNS.length, Math.floor(width / colWidth)));
	// Keep the selected column on screen; narrow terminals scroll horizontally by column.
	const start = Math.max(0, Math.min(sel.column, BOARD_COLUMNS.length - visibleCols));
	const cell = colWidth - 3; // one leading space, one trailing gap, then the border
	const measure = (s: string) => layout.visibleWidth?.(s) ?? Array.from(s).length;
	const fit = (s: string, w: number) => {
		const t = layout.truncateToWidth(s, w);
		return t + " ".repeat(Math.max(0, w - measure(t)));
	};
	const accent = (s: string) => theme.fg?.("accent", s) ?? s;
	const muted = (s: string) => theme.fg?.("muted", s) ?? s;
	const bold = (s: string) => theme.bold?.(s) ?? s;

	const columns = model.columns.slice(start, start + visibleCols).map((col, offset) => {
		const ci = start + offset;
		const lines = [fit(`${muted(STATUS_MARK[col.id] ?? "○")} ${bold(col.title)} ${muted(String(col.tasks.length))}`, cell), muted("─".repeat(cell))];
		if (!col.tasks.length) lines.push(muted("No tasks"));
		col.tasks.forEach((t, row) => {
			const selected = ci === sel.column && row === sel.row;
			lines.push(fit(`${selected ? accent("▸") : " "} #${t.id} ${t.subject}`, cell));
			const meta = [t.active ? "active" : "", t.blocked ? "blocked" : ""].filter(Boolean).join(" · ");
			lines.push(muted(fit(`  ${meta}`, cell)));
			lines.push("");
		});
		return lines;
	});

	const height = Math.max(...columns.map(c => c.length));
	const out: string[] = [];
	for (let r = 0; r < height; r++) {
		out.push(columns.map(c => " " + fit(c[r] ?? "", cell) + muted("│")).join(""));
	}
	return out;
}
