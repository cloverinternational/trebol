// Pure kanban/list model for the Tern TaskManage view. No TUI or I/O imports:
// rendering lives elsewhere and holds no semantic state.
export interface BoardTask {
	id: string;
	status: string;
}

export type BoardColumnId = "todo" | "in_progress" | "done";
export type BoardViewMode = "board" | "list";

export const BOARD_COLUMNS: readonly { id: BoardColumnId; title: string }[] = [
	{ id: "todo", title: "Todo" },
	{ id: "in_progress", title: "In Progress" },
	{ id: "done", title: "Done" },
];

export interface BoardColumn<T extends BoardTask = BoardTask> {
	id: BoardColumnId;
	title: string;
	tasks: T[];
}

export interface BoardModel<T extends BoardTask = BoardTask> {
	columns: BoardColumn<T>[];
	/** Same tasks in the same order as the board read column by column. */
	list: T[];
}

export interface BoardSelection {
	view: BoardViewMode;
	column: number;
	row: number;
}

/** Maps a TaskManage status to a column. Unknown statuses fall back to Todo. */
export function columnFor(status: string): BoardColumnId {
	if (status === "in_progress") return "in_progress";
	if (status === "completed") return "done";
	return "todo";
}

/** Every input task lands in exactly one column; empty columns are kept. */
export function buildBoard<T extends BoardTask>(tasks: readonly T[]): BoardModel<T> {
	const columns: BoardColumn<T>[] = BOARD_COLUMNS.map(c => ({ id: c.id, title: c.title, tasks: [] }));
	for (const task of tasks) {
		const id = columnFor(task.status);
		columns.find(c => c.id === id)!.tasks.push(task);
	}
	return { columns, list: columns.flatMap(c => c.tasks) };
}

export function initialSelection(): BoardSelection {
	return { view: "board", column: 0, row: 0 };
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

/** Re-establishes bounds after any model or selection change. */
export function clampSelection<T extends BoardTask>(model: BoardModel<T>, selection: BoardSelection): BoardSelection {
	const column = clamp(selection.column, 0, model.columns.length - 1);
	const rows = selection.view === "list" ? model.list.length : model.columns[column]!.tasks.length;
	const row = clamp(selection.row, 0, Math.max(0, rows - 1));
	return { view: selection.view, column, row };
}

export function moveRow<T extends BoardTask>(model: BoardModel<T>, selection: BoardSelection, delta: number): BoardSelection {
	return clampSelection(model, { ...selection, row: selection.row + delta });
}

/** Column moves only apply in board view; the row resets to stay in bounds. */
export function moveColumn<T extends BoardTask>(model: BoardModel<T>, selection: BoardSelection, delta: number): BoardSelection {
	if (selection.view === "list") return clampSelection(model, selection);
	return clampSelection(model, { ...selection, column: selection.column + delta, row: selection.row });
}

export function toggleView<T extends BoardTask>(model: BoardModel<T>, selection: BoardSelection): BoardSelection {
	const next: BoardSelection = { ...selection, view: selection.view === "board" ? "list" : "board" };
	return clampSelection(model, next);
}

export function selectedTask<T extends BoardTask>(model: BoardModel<T>, selection: BoardSelection): T | undefined {
	const s = clampSelection(model, selection);
	return s.view === "list" ? model.list[s.row] : model.columns[s.column]!.tasks[s.row];
}
