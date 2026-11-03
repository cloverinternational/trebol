import { summarizeWorkStep, type WorkStep } from "./work-summary.ts";
import type { TspNode } from "./tsp.ts";

export interface InspectableStep extends WorkStep { role: string; text?: string; output?: string; errorText?: string; startedAt?: number }
export type WorkFilter = "all" | "active" | "failed";
export function workCounts(steps: readonly WorkStep[]) {
	return {
		total: steps.length,
		active: steps.filter((s) => s.status === "running" && !s.cancelled).length,
		failed: steps.filter((s) => (s.status === "error" || s.timedOut) && !s.cancelled).length,
		done: steps.filter((s) => s.status === "ok" && !s.cancelled).length,
		cancelled: steps.filter((s) => s.cancelled).length,
	};
}
export function filterWork(steps: readonly InspectableStep[], filter: WorkFilter, query = ""): InspectableStep[] {
	const q = query.trim().toLowerCase();
	return steps.filter((s) => {
		if (s.role !== "tool") return false;
		if (filter === "active" && (s.status !== "running" || s.cancelled)) return false;
		if (filter === "failed" && (!(s.status === "error" || s.timedOut) || s.cancelled)) return false;
		const r = summarizeWorkStep(s);
		return !q || `${r.label} ${r.target ?? ""} ${r.result}`.toLowerCase().includes(q);
	});
}
const node = (id: string, k: string, p: Record<string, unknown>, c?: TspNode[]): TspNode => ({ id, k, p, ...(c ? { c } : {}) });
const button = (id: string, text: string, click: string) => node(id, "button", { text, variant: "quiet", size: "sm", actions: { click } });

export function workToolbar(id: string, steps: readonly WorkStep[], filter: string): TspNode {
	const counts = workCounts(steps);
	return node(`${id}-explore`, "row", { gap: "sm", wrap: true, role: "pi.work.explore" }, [
		...([ ["all", "All", counts.total], ["active", "Active", counts.active], ["failed", "Failed", counts.failed] ] as const).map(([key, label, count]) => node(`${id}-filter-${key}`, "button", { text: `${label} ${count}`, on: filter === key, variant: "quiet", size: "sm", tone: key === "failed" && count ? "warning" : "neutral", actions: { click: `work.filter.${key}=${id}` } })),
		button(`${id}-inspect`, "Search & inspect", `work.inspect=${id}`),
	]);
}

/** Safe projections only: never dump arbitrary tool arguments into a UI summary. */
export function workInspectorNodes(id: string, steps: readonly InspectableStep[], selected: string | undefined, query: string, cursor: number, filter: WorkFilter, columns: number): TspNode[] {
	const rows = filterWork(steps, filter, query);
	const step = rows.find((s) => s.id === selected) ?? rows[0];
	const summary = step ? summarizeWorkStep(step) : undefined;
	const output = step?.output || step?.errorText || step?.text || "No output captured yet.";
	const limit = 24000;
	const clipped = output.length > limit;
	const cells = (text: string) => [{ t: text }];
	return [node("work-inspector", "overlay", { head: "Work · Step inspector", meta: `${rows.length} matching steps`, size: "lg", modal: true, role: "pi.work.inspector", end: "work-inspector-close", foot: "work-inspector-footer" }, [
		button("work-inspector-close", "Close", "work.inspect.close"),
		node("work-inspector-search", "input", { text: query, cursor, icon: "search", placeholder: "Search step names, safe targets and outcomes…", aria: "Search work steps" }),
		node("work-inspector-tabs", "tabs", { active: filter, variant: "segmented", items: [ { id: "all", label: "All" }, { id: "active", label: "Active" }, { id: "failed", label: "Failed" } ] }),
		node("work-inspector-body", columns < 100 ? "col" : "row", { gap: "lg", align: "stretch" }, [
			node("work-inspector-list-scroll", "scroll", { grow: 1, basis: 0, max: { h: "24lines" } }, [node("work-inspector-list", "table", {
				selectable: true, selected: step?.id,
				cols: [{ id: "step", head: "Step", grow: 1, priority: 10 }, { id: "status", head: "Outcome", priority: 2 }],
				rows: rows.map((s) => { const r = summarizeWorkStep(s); return { id: s.id, cells: { step: cells([r.label, r.target].filter(Boolean).join(" · ")), status: cells(r.result) } }; }),
			})]),
			node("work-inspector-detail", "col", { grow: 1, basis: 0, gap: "sm" }, step ? [
				node("work-inspector-facts", "card", { head: summary!.label, meta: summary!.result }, [node("work-inspector-target", "text", { text: summary!.target ?? "No safe target metadata supplied", tone: "muted" }), node("work-inspector-id", "text", { text: `Step ID · ${step.id}`, tone: "muted" })]),
				node("work-inspector-output", "scroll", { max: { h: "24lines" } }, [node("work-inspector-code", "code", { text: clipped ? output.slice(0, limit / 2) + "\n\n… middle omitted …\n\n" + output.slice(-limit / 2) : output, wrap: true })]),
				...(clipped ? [node("work-inspector-truncated", "text", { text: `Showing first/last ${limit / 2} characters of ${output.length}. Return to the original step or its output-file reference for more.`, tone: "warning" })] : []),
				button("work-inspector-reveal", "Reveal original step", `work.reveal=${step.id}`),
			] : [node("work-inspector-empty", "empty", { title: "No matching steps", description: "Change the filter or search. New work appears as runtime events arrive." })]),
		]),
		node("work-inspector-footer", "text", { text: "Esc Close · ↑↓ Select · Tab Filter · Read-only inspection; no work is retried", tone: "muted" }),
	])];
}
