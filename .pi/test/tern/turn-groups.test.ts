import { describe, expect, it } from "vitest";
import { TranscriptProjector } from "../../lib/tern/bridge.ts";
import { segmentTranscript, summarizeToolGroup } from "../../lib/tern/turn-groups.ts";
import type { TspNode } from "../../lib/tern/tsp.ts";

const start = (p: TranscriptProjector, toolCallId: string, command = "echo") => p.apply({ type: "tool_execution_start", toolCallId, toolName: "bash", args: { command } });
// A work group's table rows: one item per tool step, in call order.
const rowsOf = (group: TspNode | undefined) => (group?.c ?? []).filter((c) => c.k === "list").flatMap((list) => list.c ?? []);
const end = (p: TranscriptProjector, toolCallId: string, isError = false) => p.apply({ type: "tool_execution_end", toolCallId, toolName: "bash", result: { content: [{ type: "text", text: "ok" }], details: { exit_code: 0, duration_ms: 10 } }, isError });

describe("turn grouping (pure)", () => {
	it("groups every tool call in a user turn into one segment, placed at its first call", () => {
		const items = [
			{ role: "user" }, { role: "tool" }, { role: "tool" }, { role: "assistant" }, { role: "tool" }, { role: "user" }, { role: "tool" },
		];
		expect(segmentTranscript(items).map((s) => (s.kind === "tools" ? s.items.length : "msg"))).toEqual(["msg", 4, "msg", 1]);
		// Narration before the last tool call joins the work; the answer after it, and a custom notice that starts a turn, stay messages.
		const withAnswer = [{ role: "user" }, { role: "assistant" }, { role: "tool" }, { role: "assistant" }, { role: "system", turnStart: true }, { role: "tool" }, { role: "assistant" }];
		expect(segmentTranscript(withAnswer).map((s) => (s.kind === "tools" ? s.items.map((i) => i.role).join("+") : s.item.role))).toEqual(["user", "assistant+tool", "assistant", "system", "tool", "assistant"]);
	});

	it("reports running, done, failed and interrupted from step results only", () => {
		expect(summarizeToolGroup([{ status: "running", startedAt: 0 }, { status: "ok", startedAt: 0, took: 5 }]).status).toBe("running");
		expect(summarizeToolGroup([{ status: "ok", startedAt: 0, took: 5 }, { status: "ok", startedAt: 2, took: 10 }])).toEqual({ status: "done", active: 0, failedSteps: 0, durationMs: 12 });
		// A step error the agent continued from is not a failed turn.
		expect(summarizeToolGroup([{ status: "ok" }, { status: "error" }])).toMatchObject({ status: "done", failedSteps: 1 });
		expect(summarizeToolGroup([{ status: "ok", turnFailed: true }, { status: "error", turnFailed: true }]).status).toBe("failed");
		expect(summarizeToolGroup([{ status: "error", cancelled: true }, { status: "ok" }]).status).toBe("interrupted");
	});
});

describe("turn grouping in the Tern transcript", () => {
	it("opens the running card with its running rows by default, and folds to every step, including parallel steps", () => {
		const p = new TranscriptProjector();
		p.apply({ type: "message_start", message: { role: "user", content: [{ type: "text", text: "fix login" }] } });
		start(p, "a");
		start(p, "b");
		end(p, "a");
		const live = p.nodes()[1]!;
		expect(live).toMatchObject({ k: "tool", p: { role: "tern.work-live", status: "running", collapsible: true, collapsed: false, meta: ["2 steps"] } });
		// Activity panel: running steps only; finished step a is named by the "Last" line instead.
		expect(rowsOf(live).map((r) => r.id)).toEqual(["row-t-b"]);
		expect(live.p).toMatchObject({ text: "1 running · fix login" });
		p.setGroupCollapsed(live.id, true);
		const folded = p.nodes()[1]!;
		expect(folded).toMatchObject({ k: "tool", p: { role: "tern.work-live", collapsed: true } });
		expect(rowsOf(folded).map((r) => r.id)).toEqual(["row-t-a", "row-t-b"]);
	});

	it("collapses a finished turn into one summary holding every step, in order, with the goal", () => {
		const p = new TranscriptProjector();
		p.apply({ type: "message_start", message: { role: "user", content: [{ type: "text", text: "fix login" }] } });
		start(p, "a"); end(p, "a");
		start(p, "b"); end(p, "b", true);
		const [summary] = p.nodes().slice(1);
		expect(summary?.p).toMatchObject({ role: "tern.work", title: "Done", status: "done", target: "fix login", collapsed: true, collapsible: true, meta: ["2 steps", "1 failed"] });
		expect(rowsOf(summary).map((r) => r.id)).toEqual(["row-t-a", "row-t-b"]);
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
		expect(nodes.find((n) => n.p?.role === "tern.work-live")?.p?.text).toBe("1 running · second");
	});

	it("an aborted turn reads Interrupted live and on restore, even when every step had finished", () => {
		const user = { role: "user", content: [{ type: "text", text: "check" }] };
		const call = { role: "assistant", content: [{ type: "toolCall", id: "a", name: "bash", arguments: {} }], stopReason: "toolUse" };
		const result = { role: "toolResult", toolCallId: "a", toolName: "bash", isError: false, content: [{ type: "text", text: "ok" }], details: { exit_code: 0 } };
		const aborted = { role: "assistant", content: [], stopReason: "aborted", errorMessage: "This operation was aborted" };
		const live = new TranscriptProjector();
		live.apply({ type: "agent_start" });
		live.apply({ type: "message_start", message: user });
		live.apply({ type: "message_start", message: call });
		live.apply({ type: "message_end", message: call });
		start(live, "a");
		live.apply({ type: "tool_execution_end", toolCallId: "a", toolName: "bash", result, isError: false });
		live.apply({ type: "message_start", message: aborted });
		live.apply({ type: "message_end", message: aborted });
		live.apply({ type: "agent_end" });
		const restored = new TranscriptProjector();
		restored.replaceFromSessionBranch([user, call, result, aborted].map((message, i) => ({ id: `e${i}`, type: "message", message })));
		for (const p of [live, restored]) {
			const card = p.nodes().find((n) => n.p?.role === "tern.work");
			expect(card?.p).toMatchObject({ title: "Interrupted", status: "cancelled", meta: ["1 step"] });
			expect(rowsOf(card)[0]?.p?.tone).toBe("success");
		}
	});

	it("an abort's 'context canceled' error is a cancelled step, a real failure in the same turn stays failed", () => {
		const p = new TranscriptProjector();
		p.apply({ type: "agent_start" });
		p.apply({ type: "message_start", message: { role: "user", content: [{ type: "text", text: "go" }] } });
		start(p, "real"); start(p, "cut");
		p.apply({ type: "tool_execution_end", toolCallId: "real", toolName: "bash", result: { content: [{ type: "text", text: "Error executing bash: Command exited with code 2: x" }] }, isError: true });
		p.apply({ type: "tool_execution_end", toolCallId: "cut", toolName: "bash", result: { content: [{ type: "text", text: "command execution error: context canceled" }] }, isError: true });
		p.apply({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "This operation was aborted" } });
		p.apply({ type: "agent_end" });
		const card = p.nodes().find((n) => n.p?.role === "tern.work");
		expect(card?.p?.title).toBe("Interrupted");
		expect(rowsOf(card).map((r) => r.p?.tone)).toEqual(["error", "muted"]);
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
		const restored = rowsOf(summary);
		expect(restored.map((r) => r.p?.tone)).toEqual(["success", "muted"]);
		expect(restored[0]?.p).toMatchObject({ value: "Done · 300 ms" });
	});
});

