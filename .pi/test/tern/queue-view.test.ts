import { describe, expect, it } from "vitest";
import { queueGroups, queueNodes } from "../../lib/tern/queue-view.ts";
import type { TspNode } from "../../lib/tern/tsp.ts";

const items = (nodes: TspNode[]) => nodes[0]?.c ?? [];
const textOf = (item: TspNode) => item.c?.find((c) => c.k === "text")?.p?.text;

describe("queue band (OMP QueuedMessagesBand)", () => {
	it("renders nothing when the queue is empty", () => {
		expect(queueNodes(queueGroups([], []))).toEqual([]);
	});

	it("renders one pill per message with icon, text and Edit, no count for a single message", () => {
		const nodes = queueNodes(queueGroups([], ["only"]));
		expect(nodes[0]).toMatchObject({ k: "col", p: { role: "omp.queue" } });
		const [pill] = items(nodes);
		expect(pill.p).toMatchObject({ role: "omp.queue.item", title: "After yield" });
		expect(pill.c?.map((c) => c.k)).toEqual(["icon", "text", "row"]);
		expect(pill.c?.[2].p).toMatchObject({ role: "omp.queue.edit", actions: { click: "queue.edit" } });
		expect(pill.c?.[2].c?.[0]).toMatchObject({ k: "kbd", p: { keys: ["alt", "up"] } });
	});

	it("orders steering before follow-ups and badges the total on the first pill only", () => {
		const pills = items(queueNodes(queueGroups(["s1"], ["f1", "f2"])));
		expect(pills.map(textOf)).toEqual(["s1", "f1", "f2"]);
		expect(pills.map((p) => p.p?.title)).toEqual(["Steering", "After yield", "After yield"]);
		expect(pills[0].c?.find((c) => c.k === "badge")?.p).toMatchObject({ text: "3", role: "omp.queue.count" });
		expect(pills.slice(1).some((p) => p.c?.some((c) => c.k === "badge"))).toBe(false);
		expect(new Set(pills.map((p) => p.id)).size).toBe(3);
	});

	it("keeps multiline and tabbed text on one truncated line", () => {
		const [pill] = items(queueNodes(queueGroups([], ["a\tb\n  next\r\nlast"])));
		const text = pill.c?.find((c) => c.k === "text");
		expect(text?.p).toMatchObject({ text: "a   b ↵ next ↵ last", wrap: "none", truncate: "end", grow: 1 });
	});
});
