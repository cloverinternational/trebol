import { describe, expect, it } from "vitest";
import { judgeChart, parseMarkdownTables, parseNumber, planChart, planMarkdownCharts, renderTextChart, toTspChart } from "../../lib/tern/auto-graph.ts";

const TABLE = [
	"| Model | Pass rate | Latency |",
	"| --- | ---: | --- |",
	"| alpha | 91% | 1.2s |",
	"| beta | 78% | 2.4s |",
	"| gamma | 85% | 0.9s |",
].join("\n");

describe("auto-graph", () => {
	it("parses Markdown tables with header and body rows", () => {
		const tables = parseMarkdownTables(`intro\n\n${TABLE}\n\ndone`);
		expect(tables).toHaveLength(1);
		expect(tables[0].headers).toEqual(["Model", "Pass rate", "Latency"]);
		expect(tables[0].rows).toHaveLength(3);
	});

	it("parses numbers with units and thousands separators", () => {
		expect(parseNumber("1,200")).toBe(1200);
		expect(parseNumber("91%")).toBe(91);
		expect(parseNumber("2.4s")).toBe(2.4);
		expect(parseNumber("alpha")).toBeNull();
	});

	it("plans bars from the first non-negative numeric column", () => {
		const plan = planChart(parseMarkdownTables(TABLE)[0]);
		expect(plan).toEqual({
			kind: "bars",
			header: "Pass rate",
			points: [
				{ label: "alpha", value: 91 },
				{ label: "beta", value: 78 },
				{ label: "gamma", value: 85 },
			],
		});
	});

	it("skips tables without a label column, too few rows, or non-positive measures", () => {
		expect(planChart({ headers: ["a", "b"], rows: [["1", "2"], ["3", "4"]] })).toBeNull();
		expect(planChart({ headers: ["a", "b"], rows: [["x", "2"]] })).toBeNull();
		expect(planChart({ headers: ["a", "b"], rows: [["x", "-2"], ["y", "4"]] })).toBeNull();
		expect(planChart({ headers: ["a", "b"], rows: [["x", "0"], ["y", "0"]] })).toBeNull();
	});

	it("renders scaled text bars and a Tern chart node", () => {
		const plans = planMarkdownCharts(TABLE);
		expect(plans).toHaveLength(1);
		const text = renderTextChart(plans[0], 10).split("\n");
		expect(text[0]).toBe("Pass rate (3 rows)");
		expect(text[1]).toBe("alpha ██████████ 91");
		const node = toTspChart(plans[0], "g1");
		expect(node.k).toBe("chart");
		expect(node.p?.kind).toBe("bars");
		expect(node.p?.series).toEqual([
			{ value: 91, label: "alpha", title: "alpha: 91" },
			{ value: 78, label: "beta", title: "beta: 78" },
			{ value: 85, label: "gamma", title: "gamma: 85" },
		]);
	});

	describe("judge second pass", () => {
		const table = parseMarkdownTables(TABLE)[0];
		const plan = planChart(table)!;
		const config = { baseUrl: "http://plexus.test/v1/systemone", apiKey: "k" };
		const reply = (body: unknown, ok = true) => async () => ({ ok, status: ok ? 200 : 500, json: async () => body });

		it("keeps the plan when the judge chooses bars and posts the documented body", async () => {
			let sent: any;
			const fetchImpl = async (url: string, init: any) => {
				sent = { url, headers: init.headers, body: JSON.parse(init.body) };
				return { ok: true, status: 200, json: async () => ({ answers: { kind: { type: "choice", choice: "bars" } } }) };
			};
			expect(await judgeChart(table, plan, config, fetchImpl)).toEqual(plan);
			expect(sent.url).toBe(config.baseUrl);
			expect(sent.headers.Authorization).toBe("Bearer k");
			expect(sent.body.model).toBe("jev-latest");
			expect(sent.body.state).toContain("| alpha | 91% | 1.2s |");
			expect(sent.body.questions.kind.type).toBe("choice");
		});

		it("drops the chart when the judge chooses none", async () => {
			expect(await judgeChart(table, plan, config, reply({ answers: { kind: { type: "choice", choice: "none" } } }) as any)).toBeNull();
		});

		it("falls back to the heuristic plan on HTTP error, network error, or invalid answer", async () => {
			expect(await judgeChart(table, plan, config, reply({}, false) as any)).toEqual(plan);
			expect(await judgeChart(table, plan, config, (async () => { throw new Error("down"); }) as any)).toEqual(plan);
			expect(await judgeChart(table, plan, config, reply({ answers: { kind: { choice: "pie" } } }) as any)).toEqual(plan);
		});
	});
});
