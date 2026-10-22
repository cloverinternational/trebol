import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyEvent, handleRequest, reconcileRun, type DaemonDeps } from "../../lib/claw/daemon.ts";
import { statusSummary } from "../../lib/claw/orchestrator.ts";
import { ClawStore, type Run } from "../../lib/claw/store.ts";

/** Fake Tern that records every call. Closing a block that is not live fails the way `tern close` does. */
function fakeDeps(store: ClawStore, live: Set<number>) {
	const calls: string[][] = [];
	const tern = async (args: string[]) => {
		calls.push(args);
		if (args[0] === "inspect") return JSON.stringify({ sessions: [{ id: 1, tabs: [{ id: 1, name: "Claw", blocks: [...live].map((id) => ({ id, exited: null, live: true })) }] }] });
		if (args[0] === "close") {
			const id = Number(args[1]);
			if (!live.has(id)) throw new Error(`tern close: no block ${id}`);
			live.delete(id);
		}
		return "{}";
	};
	const deps = { store, tern, hoja: {} as never, workspace: store.dir, now: () => new Date(), alive: () => false, signal: () => undefined } as unknown as DaemonDeps;
	return { deps, calls };
}

function runWith(store: ClawStore, patch: Partial<Run>): Run {
	const run: Run = {
		id: `run-test-${Math.random().toString(16).slice(2, 8)}`, label: "t", task: "t", cwd: "/tmp", status: "running", phase: "tab_open",
		createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), project: "CRM Clover File", eventsOffset: 0, settles: 0,
		attempts: 0, outbox: [], seen: [], ...patch,
	};
	return store.saveRun(run);
}

describe("claw process: repro on recorded event shapes", () => {
	let dir: string;
	let store: ClawStore;
	beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "claw-proc-")); store = new ClawStore(dir); });
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("issue 1: repeated settled turns with no finish emit one run_idle per idle episode, not one per settle", () => {
		const run = runWith(store, { status: "running" });
		for (let i = 0; i < 4; i++) applyEvent(run, { eid: `s${i}`, type: "settled", at: "", runId: run.id, text: "still going" }, store);
		expect(store.readInbox(0).items.filter((i) => i.kind === "run_idle")).toHaveLength(1);
	});

	it("issue 1b: a settle after a send (run active again) notifies idle once more", async () => {
		const { deps } = fakeDeps(store, new Set([7]));
		const run = runWith(store, { status: "running", block: 7 });
		applyEvent(run, { eid: "a", type: "settled", at: "", runId: run.id, text: "x" }, store);
		store.saveRun(run);
		await handleRequest({ id: "req-s", kind: "send", createdAt: "", runId: run.id, text: "continue" }, deps);
		const again = store.getRun(run.id)!;
		applyEvent(again, { eid: "b", type: "settled", at: "", runId: run.id, text: "y" }, store);
		expect(store.readInbox(0).items.filter((i) => i.kind === "run_idle")).toHaveLength(2);
	});

	it("issue 2: a terminal run whose tab is still live gets its tab closed by the reconcile pass", async () => {
		const { deps, calls } = fakeDeps(store, new Set([9]));
		const run = runWith(store, { status: "completed", block: 9 });
		await reconcileRun(run, deps, new Set([9]));
		expect(calls.some((c) => c[0] === "close" && c[1] === "9")).toBe(true);
	});

	it("issue 3: cancelling a run whose tab is already gone does not record a tab-close error", async () => {
		const { deps } = fakeDeps(store, new Set());
		const run = runWith(store, { status: "awaiting_user", block: 11 });
		await handleRequest({ id: "req-c", kind: "cancel", createdAt: "", runId: run.id }, deps);
		expect(store.getRun(run.id)?.error).toBeUndefined();
	});

	it("issue 4: the status summary says since when a run is waiting on the user", () => {
		const at = "2026-10-21T20:00:00.000Z";
		runWith(store, { status: "awaiting_user", finish: { outcome: "needs_user", summary: "pick a branch", evidence: [], at } });
		expect(statusSummary(store).awaitingUser).toEqual([{ id: expect.any(String), summary: "pick a branch", since: at }]);
	});
});
