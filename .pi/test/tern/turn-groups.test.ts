import { describe, expect, it } from "vitest";
import { TranscriptProjector } from "../../lib/tern/bridge.ts";
import { segmentTranscript, summarizeToolGroup } from "../../lib/tern/turn-groups.ts";
import type { TspNode } from "../../lib/tern/tsp.ts";

const steps = (nodes: TspNode[]): TspNode[] => nodes.flatMap((n) => (n.p?.role === "tern.work" || n.p?.role === "tern.work-live" ? (n.c ?? []).filter((c) => c.k === "tool") : [n]));
const start = (p: TranscriptProjector, toolCallId: string, command = "echo") => p.apply({ type: "tool_execution_start", toolCallId, toolName: "bash", args: { command } });
const end = (p: TranscriptProjector, toolCallId: string, isError = false) => p.apply({ type: "tool_execution_end", toolCallId, toolName: "bash", result: { content: [{ type: "text", text: "ok" }], details: { exit_code: 0, duration_ms: 10 } }, isError });

describe("turn grouping (pure)", () => {
	it("groups every tool call in a user turn into one segment, placed at its first call", () => {
		const items = [
			{ role: "user" }, { role: "tool" }, { role: "tool" }, { role: "assistant" }, { role: "tool" }, { role: "user" }, { role: "tool" },
		];
		expect(segmentTranscript(items).map((s) => (s.kind === "tools" ? s.items.length : "msg"))).toEqual(["msg", 3, "msg", "msg", 1]);
	});

	it("reports running, done, failed and interrupted from step results only", () => {
		expect(summarizeToolGroup([{ status: "running", startedAt: 0 }, { status: "ok", startedAt: 0, took: 5 }]).status).toBe("running");
		expect(summarizeToolGroup([{ status: "ok", startedAt: 0, took: 5 }, { status: "ok", startedAt: 2, took: 10 }])).toEqual({ status: "done", active: 0, durationMs: 12 });
		expect(summarizeToolGroup([{ status: "ok" }, { status: "error" }]).status).toBe("failed");
		expect(summarizeToolGroup([{ status: "error", cancelled: true }, { status: "ok" }]).status).toBe("interrupted");
	});
});

describe("turn grouping in the Tern transcript", () => {
	it("shows only active steps while running, including parallel steps", () => {
		const p = new TranscriptProjector();
		p.apply({ type: "message_start", message: { role: "user", content: [{ type: "text", text: "fix login" }] } });
		start(p, "a");
		start(p, "b");
		end(p, "a");
		const live = p.nodes()[1]!;
		expect(live.p?.role).toBe("tern.work-live");
		expect(steps(p.nodes()).filter((n) => n.k === "tool")).toEqual([]);
		expect(live.c).toBeUndefined();
		expect(live.p).toMatchObject({ text: "fix login · 1 running" });
	});

	it("collapses a finished turn into one summary holding every step, in order, with the goal", () => {
		const p = new TranscriptProjector();
		p.apply({ type: "message_start", message: { role: "user", content: [{ type: "text", text: "fix login" }] } });
		start(p, "a"); end(p, "a");
		start(p, "b"); end(p, "b", true);
		const [summary] = p.nodes().slice(1);
		expect(summary?.p).toMatchObject({ role: "tern.work", title: "Failed", status: "error", target: "fix login", collapsed: true, collapsible: true, meta: ["2 steps"] });
		expect(summary?.c?.map((c) => c.id)).toEqual(["t-a", "t-b"]);
	});

	it("starts a new group after a queued user message", () => {
		const p = new TranscriptProjector();
		p.apply({ type: "message_start", message: { role: "user", content: [{ type: "text", text: "first" }] } });
		start(p, "a"); end(p, "a");
		p.apply({ type: "message_start", message: { role: "user", content: [{ type: "text", text: "second" }] } });
		start(p, "b");
		const nodes = p.nodes();
		expect(nodes.filter((n) => n.p?.role === "tern.work" || n.p?.role === "tern.work-live").map((n) => n.p?.role)).toEqual(["tern.work", "tern.work-live"]);
		expect(nodes.find((n) => n.p?.role === "tern.work")?.p?.target).toBe("first");
		expect(nodes.find((n) => n.p?.role === "tern.work-live")?.p?.text).toBe("second · 1 running");
	});

	it("restores persisted tool calls and results, and marks unresolved calls interrupted", () => {
		const p = new TranscriptProjector();
		p.replaceFromSessionBranch([
			{ id: "u1", type: "message", message: { role: "user", content: [{ type: "text", text: "run tests" }] } },
			{ id: "a1", type: "message", message: { role: "assistant", content: [
				{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "npm test" } },
				{ type: "toolCall", id: "c2", name: "bash", arguments: { command: "npm run lint" } },
			] } },
			{ id: "r1", type: "message", message: { role: "toolResult", toolCallId: "c1", toolName: "bash", isError: false, content: [{ type: "text", text: "all green" }], details: { exit_code: 0, duration_ms: 300 } } },
		]);
		const summary = p.nodes().find((n) => n.p?.role === "tern.work");
		expect(summary?.p).toMatchObject({ role: "tern.work", title: "Interrupted", status: "cancelled", target: "run tests" });
		const restored = summary?.c ?? [];
		expect(restored.map((c) => c.p?.status)).toEqual(["done", "cancelled"]);
		expect(restored[0]?.p).toMatchObject({ took: 300 });
	});
});

