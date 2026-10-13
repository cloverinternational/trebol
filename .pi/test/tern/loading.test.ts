import { describe, expect, it } from "vitest";
import { IDLE_LOADING, LOADING_NODE_ID, loadingNode, reduceLoading, type LoadingEvent, type LoadingState } from "../../lib/tern/loading.ts";

function run(events: LoadingEvent[], from: LoadingState = IDLE_LOADING): LoadingState {
	return events.reduce(reduceLoading, from);
}

describe("reduceLoading", () => {
	it("goes pending on prompt, running on agent_start, idle on agent_end", () => {
		expect(run([{ type: "prompt_start" }]).phase).toBe("pending");
		expect(run([{ type: "prompt_start" }, { type: "agent_start" }]).phase).toBe("running");
		expect(run([{ type: "prompt_start" }, { type: "agent_start" }, { type: "agent_end" }]).phase).toBe("idle");
	});

	it("clears on agent_settled", () => {
		expect(run([{ type: "agent_start" }, { type: "agent_settled" }]).phase).toBe("idle");
	});

	it("does not fall back to pending when a prompt arrives mid-run", () => {
		expect(run([{ type: "agent_start" }, { type: "prompt_start" }]).phase).toBe("running");
	});

	it("clears on abort while pending or running", () => {
		expect(run([{ type: "prompt_start" }, { type: "abort" }]).phase).toBe("idle");
		expect(run([{ type: "agent_start" }, { type: "abort" }]).phase).toBe("idle");
	});

	it("clears on prompt failure so nothing is stuck", () => {
		expect(run([{ type: "prompt_start" }, { type: "failure" }]).phase).toBe("idle");
		expect(run([{ type: "agent_start" }, { type: "failure" }]).phase).toBe("idle");
	});

	it("resets on session switch and tracks the new session", () => {
		const s = run([{ type: "agent_start" }, { type: "session_switch", sessionId: "s2" }]);
		expect(s.phase).toBe("idle");
		expect(s.sessionId).toBe("s2");
	});

	it("returns to idle on close and ignores later events", () => {
		const s = run([{ type: "agent_start" }, { type: "close" }]);
		expect(s.phase).toBe("idle");
		expect(s.closed).toBe(true);
		expect(run([{ type: "agent_start" }], s).phase).toBe("idle");
		expect(run([{ type: "prompt_start" }], s).phase).toBe("idle");
	});

	it("ignores terminal events while already idle (returns same state)", () => {
		expect(reduceLoading(IDLE_LOADING, { type: "agent_end" })).toBe(IDLE_LOADING);
		expect(reduceLoading(IDLE_LOADING, { type: "abort" })).toBe(IDLE_LOADING);
	});

	it("never stays loading after any sequence ending in a terminal event", () => {
		const starts: LoadingEvent[] = [{ type: "prompt_start" }, { type: "agent_start" }];
		const terminals: LoadingEvent[] = [
			{ type: "agent_end" }, { type: "agent_settled" }, { type: "abort" }, { type: "failure" },
			{ type: "session_switch", sessionId: null }, { type: "close" },
		];
		for (const start of starts) for (const end of terminals) {
			expect(run([start, end]).phase).toBe("idle");
		}
	});
});

describe("loadingNode", () => {
	it("is null when idle", () => {
		expect(loadingNode(IDLE_LOADING)).toBeNull();
	});

	it("uses a stable id across pending and running", () => {
		const pending = loadingNode(run([{ type: "prompt_start" }]));
		const running = loadingNode(run([{ type: "agent_start" }]));
		expect(pending?.id).toBe(LOADING_NODE_ID);
		expect(running?.id).toBe(LOADING_NODE_ID);
		expect(pending?.k).toBe("spinner");
		expect(running?.k).toBe("shimmer");
	});
});
