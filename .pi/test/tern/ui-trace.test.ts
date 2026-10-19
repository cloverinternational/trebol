import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TranscriptProjector, type PiEventLike } from "../../lib/tern/bridge.ts";
import { createUiTrace, findFlicker, type TraceFrame } from "../../lib/tern/ui-trace.ts";

const DIR = join(import.meta.dirname, "fixtures/turn-work");
const events = (name: string) => readFileSync(join(DIR, `${name}.events.jsonl`), "utf8").trim().split("\n").map((l) => JSON.parse(l) as PiEventLike);

// Replays events through the projector exactly as the bridge renders them and returns the trace's frames.
function trace(evs: readonly PiEventLike[]): TraceFrame[] {
	const dir = mkdtempSync(join(tmpdir(), "tern-trace-"));
	let t = 0;
	const tr = createUiTrace(dir, () => ++t);
	const p = new TranscriptProjector();
	let busy = false;
	for (const e of evs) {
		tr.event(e);
		if (e.type === "agent_start") busy = true;
		if (e.type === "agent_end" || e.type === "agent_settled") busy = false;
		if (p.apply(e) || e.type.startsWith("agent_")) tr.render(p.nodes(), e.type, busy);
	}
	return readFileSync(tr.file!, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((l) => l.k === "frame");
}

describe("UI trace", () => {
	it("writes only changed frames and never event payload text", () => {
		const evs = events("2026-10-18T20-18-16-017Z");
		const dir = mkdtempSync(join(tmpdir(), "tern-trace-"));
		const tr = createUiTrace(dir);
		const p = new TranscriptProjector();
		for (const e of evs) { tr.event(e); p.apply(e); tr.render(p.nodes(), e.type, true); tr.render(p.nodes(), "ui", true); }
		const lines = readFileSync(tr.file!, "utf8").trim().split("\n").map((l) => JSON.parse(l));
		const frames = lines.filter((l) => l.k === "frame");
		for (let i = 1; i < frames.length; i++) expect(JSON.stringify([frames[i].busy, frames[i].rows])).not.toBe(JSON.stringify([frames[i - 1].busy, frames[i - 1].rows]));
		expect(lines.filter((l) => l.k === "ev").every((l) => !("message" in l) && !("result" in l))).toBe(true);
	});

	it("detects a row that vanishes and a card that flips while busy", () => {
		const row = (id: string, role: string, state = "") => [id, role, state, ""] as [string, string, string, string];
		const f = (seq: number, busy: boolean, ...rows: ReturnType<typeof row>[]): TraceFrame => ({ k: "frame", at: seq, seq, trigger: "x", busy, rows });
		const found = findFlicker([
			f(1, true, row("u", "pi.user")),
			f(2, true, row("u", "pi.user"), row("a", "pi.assistant")),
			f(3, true, row("u", "pi.user"), row("g", "tern.work-live")),
			f(4, true, row("u", "pi.user"), row("g", "tern.work", "Failed 2 steps")),
			f(5, true, row("u", "pi.user"), row("g", "tern.work-live")),
			// Near miss: settling after agent_end is not flicker.
			f(6, false, row("u", "pi.user"), row("g", "tern.work", "Done 2 steps")),
		]).map((x) => `${x.kind} ${x.id}`);
		expect(found).toEqual(["vanished a", "settled-while-busy g", "state-flip g"]);
	});

	it("reports what the recorded corpus runs show while busy", () => {
		const report = ["2026-10-18T19-18-23-235Z", "2026-10-18T19-29-42-211Z", "2026-10-18T20-18-16-017Z"].flatMap((n) => findFlicker(trace(events(n))).map((x) => `${n.slice(11, 19)} ${x.kind} ${x.role}`));
		expect(report).toMatchSnapshot();
	});
});
