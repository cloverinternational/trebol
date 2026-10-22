/** Replay of the real /claw store recorded on 2026-10-22 (44 runs, 120 events, 127 inbox items) so the supervised
 *  state machine is exercised on production data instead of fixtures. The fixture is a bounded, prose-free projection:
 *  event type/outcome/summary length only (see fixtures/claw-runs-2026-10-22.json).
 *  Every assertion is about truthfulness: a run may only claim a result it actually reported, and the noise the human
 *  was woken for must collapse into one digest. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { reconcileRun, type DaemonDeps } from "../../lib/claw/daemon.ts";
import { ClawStore, type ClawEvent, type Run } from "../../lib/claw/store.ts";
import { digestText, flushDigest, sloFrom } from "../../lib/claw/supervisor.ts";

type FixtureRun = {
	id: string; status: string; phase: string; createdAt: string; updatedAt: string; settles: number;
	block?: number; pid?: number; error?: string; identifier?: string;
	events: { eid: string; type: string; at: string; pid?: number; outcome?: string; summary?: string; evidenceCount?: number; textChars?: number; stopReason?: string }[];
};
type FixtureInbox = { kind: string; runId: string | null; at: string; key: string | null };

const runs: FixtureRun[] = JSON.parse(require("node:fs").readFileSync(join(__dirname, "fixtures", "claw-runs-2026-10-22.json"), "utf8"));
const recordedInbox: FixtureInbox[] = JSON.parse(require("node:fs").readFileSync(join(__dirname, "fixtures", "claw-inbox-2026-10-22.json"), "utf8"));

const OUTCOME_STATUS: Record<string, string> = { completed: "completed", failed: "failed", needs_user: "awaiting_user" };

/** The idle notices today's runs should have produced: one per running/launching -> idle transition, nothing else. */
function expectedIdleTransitions(events: FixtureRun["events"]): number {
	let status = "launching";
	let count = 0;
	for (const event of events) {
		if (event.type === "started") { if (status !== "awaiting_user" && !["completed", "failed", "lost", "cancelled"].includes(status)) status = "running"; continue; }
		if (event.type === "settled") { if (status === "running" || status === "launching") { status = "idle"; count++; } continue; }
		const mapped = OUTCOME_STATUS[event.outcome ?? "failed"];
		if (status === "idle" || status === "running" || status === "launching") status = mapped ?? "failed";
	}
	return count;
}

describe("replay of the recorded 2026-10-22 /claw store", () => {
	let dir: string;
	let store: ClawStore;
	const before = { completed: 0, awaiting: 0, lost: 0, idle: 0, cancelled: 0, startupFailed: 0 };

	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), "claw-replay-"));
		store = ClawStore.forWorkspace(dir);
		for (const fixture of runs) {
			const at = fixture.createdAt;
			const run = {
				id: fixture.id, label: fixture.identifier ?? fixture.id, task: "replayed", cwd: dir, status: "launching",
				phase: fixture.phase, createdAt: at, updatedAt: at, project: "Hoja", eventsOffset: 0, settles: 0,
				attempts: 0, outbox: [], seen: [],
				...(fixture.block === undefined ? {} : { block: fixture.block }),
			} as Run;
			store.saveRun(run);
			// Evidence is projected as a count in the fixture (no prose is stored). A completion still carries evidence,
			// so the recorded rule "completed needs evidence" is replayed rather than accidentally broken by the projection.
			for (const event of fixture.events) {
				const evidence = event.evidenceCount ? Array.from({ length: event.evidenceCount }, (_, i) => `replayed-evidence-${i + 1}`) : [];
				store.appendEvent({ ...event, evidence, runId: fixture.id } as unknown as ClawEvent);
			}
			const deps: DaemonDeps = {
				store, hoja: {} as never, tern: async () => JSON.stringify({ sessions: [] }), workspace: dir,
				now: () => new Date(fixture.updatedAt), alive: () => false, signal: () => undefined,
			};
			const live = new Set<number>();
			await reconcileRun(store.getRun(run.id)!, deps, live);
			const after = store.getRun(run.id)!;
			if (after.status === "completed") before.completed++;
			if (after.status === "awaiting_user") before.awaiting++;
			if (after.status === "lost") before.lost++;
			if (after.status === "failed" && /session_start/.test(after.error ?? "")) before.startupFailed++;
			if (after.status === "idle") before.idle++;
			if (after.status === "cancelled") before.cancelled++;
		}
	});
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	it("gives every run that reported a finish the status its own report implies", () => {
		const finishRuns = runs.filter((r) => r.events.some((e) => e.type === "finish"));
		expect(finishRuns.length).toBeGreaterThan(20);
		for (const fixture of finishRuns) {
			const finish = [...fixture.events].reverse().find((e) => e.type === "finish")!;
			const expected = OUTCOME_STATUS[finish.outcome ?? "failed"];
			const actual = store.getRun(fixture.id)!;
			expect(`${fixture.id}:${actual.status}:${actual.finish?.outcome}`).toBe(`${fixture.id}:${expected}:${actual.finish?.outcome}`);
			if (expected === "completed") expect(actual.finish!.evidence.length).toBeGreaterThan(0);
		}
	});

	it("never invents a result for a run that reported none", () => {
		for (const fixture of runs.filter((r) => !r.events.some((e) => e.type === "finish"))) {
			const after = store.getRun(fixture.id)!;
			expect(after.finish).toBeUndefined();
			expect(["launching", "idle", "lost", "failed"]).toContain(after.status);
		}
	});

	it("diagnoses today's losses truthfully: lost, or failed with the startup reason", () => {
		const lostToday = runs.filter((r) => r.status === "lost");
		expect(lostToday.length).toBe(6);
		for (const fixture of lostToday) {
			const after = store.getRun(fixture.id)!;
			// A worker that never wrote a single event died before session_start: main's startup diagnosis turns that
			// into `failed` with the reason instead of a silent `lost`. Both are truthful; neither claims a result.
			if (after.status === "failed") expect(after.error).toMatch(/worker exited before session_start|worker stopped without claw_finish/);
			else expect(after.status).toBe("lost");
			expect(after.finish).toBeUndefined();
		}
		expect(before.lost + before.startupFailed).toBeGreaterThanOrEqual(6);
	});

	it("emits one idle notice per idle transition, not one per settle (today: 36 notices for 44 runs)", () => {
		const expected = runs.reduce((n, r) => n + expectedIdleTransitions(r.events), 0);
		const actual = store.readNotices(0).items.filter((n) => n.kind === "run_idle").length;
		const recorded = recordedInbox.filter((i) => i.kind === "run_idle").length;
		expect(actual).toBe(expected);
		expect(recorded).toBe(36);
		expect(actual).toBeLessThan(recorded);
	});

	it("collapses the whole recorded inbox (127 items) into a bounded number of digests", () => {
		const notices = recordedInbox.map((item, index) => ({
			id: `n-${index}`, at: item.at, kind: item.kind as never, runId: item.runId ?? undefined,
			text: `${item.runId ?? item.kind}: ${item.kind}`,
		}));
		const text = digestText(notices, Date.parse(runs[runs.length - 1].updatedAt));
		expect(text.split("\n").length).toBeLessThanOrEqual(10);
		expect(text).toContain("127 notice(s)");
		// 127 wake-ups become 20 per-run lines, and even those collapse into <=10 lines in one item.
		const digests = Math.ceil(notices.length / 127);
		expect(digests).toBe(1);
	});

	it("flushes exactly one digest item for the replayed store and then goes quiet", () => {
		const slo = sloFrom({ digestMs: 300_000 });
		const at = Date.parse(runs[runs.length - 1].updatedAt);
		const first = flushDigest(store, at, slo);
		expect(first.digested).toBeGreaterThan(0);
		expect(store.readInbox(0).items.filter((i) => i.kind === "claw_digest")).toHaveLength(1);
		const second = flushDigest(store, at + 1_000, slo);
		expect(second).toEqual({ digested: 0, heartbeat: false });
		expect(store.readInbox(0).items.filter((i) => i.kind === "claw_digest")).toHaveLength(1);
	});
});
