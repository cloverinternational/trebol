import { judgeChart, parseMarkdownTables, planChart, renderTextChart, toTspChart, type ChartPlan } from "../../.pi/lib/tern/auto-graph.ts";

/**
 * message_end is the Pi replacement boundary; each plannable table in a finished answer gets a chart message beneath it.
 * With PLEXUS_BASE_URL and PLEXUS_API_KEY set and TREBOL_AUTO_GRAPH_JUDGE=1, the heuristic plan is confirmed by the Plexus judge.
 */
export default function autoGraphExtension(pi: any): void {
	const isSubagent = process.env.PI_SWARM_SUBAGENT === "1";
	const judge = process.env.TREBOL_AUTO_GRAPH_JUDGE === "1" && process.env.PLEXUS_BASE_URL && process.env.PLEXUS_API_KEY
		? { baseUrl: process.env.PLEXUS_BASE_URL, apiKey: process.env.PLEXUS_API_KEY }
		: undefined;
	pi.on("message_end", async (event: any) => {
		const message = event?.message;
		if (isSubagent || message?.role !== "assistant" || message.stopReason !== "stop" || !Array.isArray(message.content)) return;
		if (message.content.some((part: any) => part?.type === "toolCall")) return;
		const text = message.content.filter((part: any) => part?.type === "text").map((part: any) => String(part.text ?? "")).join("\n");
		const plans: ChartPlan[] = [];
		for (const table of parseMarkdownTables(text)) {
			const plan = planChart(table);
			if (!plan) continue;
			const confirmed = judge ? await judgeChart(table, plan, judge) : plan;
			if (confirmed) plans.push(confirmed);
		}
		plans.forEach((plan, index) => {
			pi.sendMessage({
				customType: "pi-swarm-auto-graph",
				content: renderTextChart(plan),
				display: true,
				details: { plan, tsp: toTspChart(plan, `auto-graph-${index}`) },
			}, {});
		});
	});
}
