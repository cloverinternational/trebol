// Auto-graph for Markdown tables in finished assistant answers. Pure planning and projection:
// no I/O and no pi imports. Recreates the deterministic part of OMP's auto-graph (table parse,
// chart plan, text rendering). The OMP judge second pass is not included in this version.
import type { TspNode } from "./tsp.ts";

export interface MarkdownTable {
	headers: string[];
	rows: string[][];
}

export interface ChartPoint {
	label: string;
	value: number;
}

export interface ChartPlan {
	kind: "bars";
	header: string;
	points: ChartPoint[];
}

const SEPARATOR = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
const NUMBER = /^([-+]?\d+(?:\.\d+)?)\s*(%|ms|s|k|m|x)?$/i;
const MAX_ROWS = 24;

function splitRow(line: string): string[] {
	return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
}

export function parseMarkdownTables(text: string): MarkdownTable[] {
	const lines = text.split("\n");
	const tables: MarkdownTable[] = [];
	for (let i = 0; i + 1 < lines.length; i++) {
		if (!lines[i].includes("|") || !SEPARATOR.test(lines[i + 1])) continue;
		const headers = splitRow(lines[i]);
		const rows: string[][] = [];
		let j = i + 2;
		while (j < lines.length && lines[j].includes("|") && lines[j].trim() !== "") {
			rows.push(splitRow(lines[j]));
			j++;
		}
		tables.push({ headers, rows });
		i = j - 1;
	}
	return tables;
}

export function parseNumber(cell: string): number | null {
	const match = NUMBER.exec(cell.replace(/,/g, "").trim());
	return match ? Number(match[1]) : null;
}

// A table charts when it has a text label column (first column) and one non-negative numeric
// column that is not all zero. Only the first such measure is charted.
export function planChart(table: MarkdownTable): ChartPlan | null {
	const { headers, rows } = table;
	if (rows.length < 2 || rows.length > MAX_ROWS || headers.length < 2) return null;
	if (rows.some((row) => row.length !== headers.length)) return null;
	const labels = rows.map((row) => row[0]);
	if (labels.some((label) => label === "" || parseNumber(label) !== null)) return null;
	for (let col = 1; col < headers.length; col++) {
		const values = rows.map((row) => parseNumber(row[col]));
		if (values.some((value) => value === null || value < 0)) continue;
		const numbers = values as number[];
		if (Math.max(...numbers) <= 0) continue;
		return { kind: "bars", header: headers[col], points: labels.map((label, i) => ({ label, value: numbers[i] })) };
	}
	return null;
}

export function planMarkdownCharts(text: string): ChartPlan[] {
	return parseMarkdownTables(text).map(planChart).filter((plan): plan is ChartPlan => plan !== null);
}

export interface JudgeConfig {
	baseUrl: string;
	apiKey: string;
	model?: string;
	timeoutMs?: number;
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

function tableToMarkdown(table: MarkdownTable): string {
	const row = (cells: string[]) => `| ${cells.join(" | ")} |`;
	return [row(table.headers), row(table.headers.map(() => "---")), ...table.rows.map(row)].join("\n");
}

// Second pass: asks the Plexus judge whether to chart a heuristic plan. Returns the plan to draw,
// null when the judge says no chart, and the heuristic plan on any error, timeout or invalid answer.
export async function judgeChart(table: MarkdownTable, plan: ChartPlan, config: JudgeConfig, fetchImpl: FetchLike = fetch as unknown as FetchLike): Promise<ChartPlan | null> {
	const body = {
		model: config.model ?? "jev-latest",
		state: tableToMarkdown(table),
		questions: {
			kind: {
				type: "choice",
				instructions: "The state is a Markdown table from a coding assistant's answer. A chart will be drawn under the table. Choose the chart that makes its comparison clearest, or none when a chart adds nothing.",
				criteria: {
					bars: "One numeric measure compared across categories.",
					none: "Identifiers, settings, or too few comparable values: a chart adds nothing.",
				},
			},
		},
	};
	try {
		const response = await fetchImpl(config.baseUrl, {
			method: "POST",
			headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(config.timeoutMs ?? 15000),
		});
		if (!response.ok) return plan;
		const data = (await response.json()) as { answers?: { kind?: { choice?: unknown } } };
		const choice = data.answers?.kind?.choice;
		if (choice === "none") return null;
		return plan;
	} catch {
		return plan;
	}
}

export function renderTextChart(plan: ChartPlan, width = 24): string {
	const max = Math.max(...plan.points.map((point) => point.value));
	const labelWidth = Math.max(...plan.points.map((point) => point.label.length));
	const lines = [`${plan.header} (${plan.points.length} rows)`];
	for (const point of plan.points) {
		const filled = Math.round((point.value / max) * width);
		lines.push(`${point.label.padEnd(labelWidth)} ${"█".repeat(filled).padEnd(width)} ${point.value}`);
	}
	return lines.join("\n");
}

// Tern draws this natively from the Surface Protocol (`chart` element, bars kind; see Tern docs elements/motion).
export function toTspChart(plan: ChartPlan, id: string): TspNode {
	return {
		id,
		k: "chart",
		p: {
			kind: "bars",
			size: "sm",
			summary: plan.header,
			series: plan.points.map((point) => ({ value: point.value, label: point.label, title: `${point.label}: ${point.value}` })),
		},
	};
}
