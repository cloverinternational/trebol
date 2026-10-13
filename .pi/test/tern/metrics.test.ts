import { describe, expect, it } from "vitest";
import { SessionMetrics, contextPercent, formatActive, formatTokens, usageOutput } from "../../lib/tern/metrics.ts";

describe("usageOutput", () => {
	it("reads real output usage and ignores messages without it", () => {
		expect(usageOutput({ usage: { output: 42 } })).toBe(42);
		expect(usageOutput({ role: "user", content: "hi" })).toBeUndefined();
		expect(usageOutput({ usage: { output: "42" } })).toBeUndefined();
		expect(usageOutput({ usage: { output: -1 } })).toBeUndefined();
		expect(usageOutput({ usage: null })).toBeUndefined();
		expect(usageOutput(null)).toBeUndefined();
	});
});

describe("contextPercent", () => {
	it("passes through finite percents and rounds", () => {
		expect(contextPercent({ tokens: 10, contextWindow: 100, percent: 42.6 })).toBe(43);
		expect(contextPercent({ percent: 0 })).toBe(0);
	});
	it("omits unknown (null after compaction) and malformed values", () => {
		expect(contextPercent({ tokens: null, contextWindow: 100, percent: null })).toBeUndefined();
		expect(contextPercent({ percent: Number.NaN })).toBeUndefined();
		expect(contextPercent({ percent: "50" })).toBeUndefined();
		expect(contextPercent({ percent: -5 })).toBeUndefined();
		expect(contextPercent(undefined)).toBeUndefined();
	});
});

describe("formatters", () => {
	it("formats tokens and active time", () => {
		expect(formatTokens(999)).toBe("999");
		expect(formatTokens(1500)).toBe("1.5k");
		expect(formatActive(65_000)).toBe("1m 05s");
		expect(formatActive(3_725_000)).toBe("1h 02m");
	});
});

describe("SessionMetrics", () => {
	it("reports nothing before any real usage or observed turn", () => {
		const m = new SessionMetrics();
		m.reset("s1", []);
		expect(m.snapshot(1000)).toEqual({ outputTokens: undefined, activeMs: undefined });
	});

	it("rebases output tokens on persisted entries of the session", () => {
		const m = new SessionMetrics();
		m.reset("s1", [
			{ type: "message", message: { role: "assistant", usage: { output: 10 } } },
			{ type: "message", message: { role: "user", content: "x" } },
			{ type: "message", message: { role: "assistant", usage: { output: 5 } } },
			{ type: "model_change" },
		]);
		expect(m.snapshot(0).outputTokens).toBe(15);
	});

	it("adds live usage and ignores messages without it", () => {
		const m = new SessionMetrics();
		m.reset("s1", []);
		m.addMessage({ role: "assistant", usage: { output: 7 } });
		m.addMessage({ role: "assistant", content: "no usage" });
		expect(m.snapshot(0).outputTokens).toBe(7);
	});

	it("accumulates active time over observed turns only", () => {
		const m = new SessionMetrics();
		m.reset("s1", []);
		m.start(1000);
		expect(m.snapshot(1500).activeMs).toBe(500);
		m.stop(3000);
		expect(m.snapshot(9000).activeMs).toBe(2000);
		m.start(10_000);
		m.start(11_000); // a second start does not restart the open turn
		m.stop(12_000);
		expect(m.snapshot(20_000).activeMs).toBe(4000);
	});

	it("ignores a stop without a matching start and clamps clock skew", () => {
		const m = new SessionMetrics();
		m.reset("s1", []);
		m.stop(5000);
		expect(m.snapshot(6000).activeMs).toBeUndefined();
		m.start(9000);
		m.stop(8000);
		expect(m.snapshot(8000).activeMs).toBe(0);
	});

	it("resets everything on session switch", () => {
		const m = new SessionMetrics();
		m.reset("s1", [{ type: "message", message: { usage: { output: 9 } } }]);
		m.start(0);
		m.stop(1000);
		m.reset("s2", []);
		expect(m.sessionId).toBe("s2");
		expect(m.snapshot(5000)).toEqual({ outputTokens: undefined, activeMs: undefined });
	});

	it("drops an open turn on reset so it cannot leak into the next session", () => {
		const m = new SessionMetrics();
		m.reset("s1", []);
		m.start(0);
		m.reset("s2", []);
		m.stop(4000);
		expect(m.snapshot(5000).activeMs).toBeUndefined();
	});
});
