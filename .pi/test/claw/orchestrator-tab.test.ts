import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clawSession, launchTab, nameClawTab, ownPaneBlock, type TernExec } from "../../lib/claw/launcher.ts";
import { ClawStore, type Run } from "../../lib/claw/store.ts";
import { applyEvent } from "../../lib/claw/daemon.ts";
import { registerOrchestrator } from "../../../extensions/claw/extension.ts";
import { gateActiveTools, swarmSurfaceFor } from "../../lib/runtime/swarm-tool-gating.ts";

describe("claw tools on the model surface", () => {
	it("keeps claw_finish and the orchestrator claw tools when Pi's active set is gated", () => {
		expect(swarmSurfaceFor({ interactive: false }).has("claw_finish")).toBe(true);
		expect(gateActiveTools(["claw_finish"], { interactive: false }, {}, ["claw_finish"])).toBeUndefined();
		expect(gateActiveTools(["claw_spawn", "claw_trigger"], { interactive: false }, {}, ["claw_spawn", "claw_trigger"])).toBeUndefined();
	});

	it("still hides an unrelated Pi-only extension tool", () => {
		expect(swarmSurfaceFor({ interactive: false }).has("some_pi_only_tool")).toBe(false);
		expect(gateActiveTools(["some_pi_only_tool"], { interactive: false }, {}, ["some_pi_only_tool"])).toEqual([]);
	});
});

type Tab = { id: number; name: string | null; blocks: number[] };

describe("claw run events after a finish", () => {
	it("a settled turn after claw_finish is not reported as idle; the run stays completed", () => {
		const dir = mkdtempSync(join(tmpdir(), "claw-events-"));
		try {
			const store = ClawStore.forWorkspace(dir);
			const run: Run = { id: "run-ev1", label: "w", task: "t", cwd: dir, status: "running", phase: "tab_open", createdAt: "", updatedAt: "", project: "p", eventsOffset: 0, settles: 0, attempts: 0, outbox: [], seen: [] };
			applyEvent(run, { eid: "f1", type: "finish", at: "", runId: run.id, outcome: "completed", summary: "ok", evidence: ["date"] }, store);
			applyEvent(run, { eid: "s1", type: "settled", at: "", runId: run.id, text: "done" }, store);
			expect(run.status).toBe("completed");
			expect(run.finalText).toBe("done");
			expect(store.readInbox(0).items.map((i) => i.kind)).toEqual(["run_completed"]);
		} finally { rmSync(dir, { recursive: true, force: true }); }
	});

	it("a settled turn with no finish is still reported as idle (near miss: not a completion)", () => {
		const dir = mkdtempSync(join(tmpdir(), "claw-events-"));
		try {
			const store = ClawStore.forWorkspace(dir);
			const run: Run = { id: "run-ev2", label: "w", task: "t", cwd: dir, status: "running", phase: "tab_open", createdAt: "", updatedAt: "", project: "p", eventsOffset: 0, settles: 0, attempts: 0, outbox: [], seen: [] };
			applyEvent(run, { eid: "s2", type: "settled", at: "", runId: run.id, text: "waiting" }, store);
			expect(run.status).toBe("idle");
			expect(store.readInbox(0).items.map((i) => i.kind)).toEqual(["run_idle"]);
		} finally { rmSync(dir, { recursive: true, force: true }); }
	});
});
type Window = { sessions: { id: number; tabs: Tab[] }[] };

/** A fake Tern window. `rename` mutates tab names like Tern does; the options inject refusals and silent no-ops. */
function fakeTern(initial: Window, opts: { refuseRename?: boolean; silentRename?: boolean; absent?: boolean } = {}) {
	const win: Window = JSON.parse(JSON.stringify(initial));
	const calls: string[][] = [];
	const exec: TernExec = async (args) => {
		calls.push(args);
		if (opts.absent) throw Object.assign(new Error("spawn tern ENOENT"), { code: "ENOENT" });
		if (args[0] === "inspect") {
			return JSON.stringify({ sessions: win.sessions.map((s) => ({ id: s.id, tabs: s.tabs.map((t) => ({ id: t.id, name: t.name, blocks: t.blocks.map((id) => ({ id, exited: null, live: true })) })) })) });
		}
		if (args[0] === "rename") {
			if (opts.refuseRename) throw new Error("tern: rename refused");
			if (!opts.silentRename) {
				const block = Number(args[1]);
				for (const s of win.sessions) for (const t of s.tabs) if (t.blocks.includes(block)) t.name = args[2];
			}
			return "{}";
		}
		if (args[0] === "new") return JSON.stringify({ tab: 9001, block: 9002 });
		return "{}";
	};
	const names = () => Object.fromEntries(win.sessions.flatMap((s) => s.tabs.map((t) => [t.id, t.name])));
	return { exec, calls, names, renames: () => calls.filter((c) => c[0] === "rename") };
}

// Our pane is block 500 in an unnamed tab; an unrelated tab (block 700) is already named "Claw" (another orchestrator).
const base: Window = { sessions: [{ id: 1, tabs: [
	{ id: 10, name: null, blocks: [500] },
	{ id: 11, name: "Claw", blocks: [700] },
	{ id: 12, name: "Notes", blocks: [800] },
] }] };

describe("claw orchestrator tab naming", () => {
	it("renames only the tab holding this pane, to Claw, and confirms the name stuck", async () => {
		const t = fakeTern(base);
		await expect(nameClawTab(t.exec, 500)).resolves.toEqual({ tab: 10, renamed: true });
		expect(t.renames()).toEqual([["rename", "500", "Claw", "--json"]]);
		expect(t.names()).toEqual({ 10: "Claw", 11: "Claw", 12: "Notes" });
	});

	it("never touches an unrelated tab, even when it is the one already named Claw", async () => {
		const t = fakeTern(base);
		await nameClawTab(t.exec, 500);
		expect(t.calls.flat()).not.toContain("700");
		expect(t.calls.flat()).not.toContain("800");
	});

	it("does nothing when this pane's tab is already named Claw", async () => {
		const t = fakeTern({ sessions: [{ id: 1, tabs: [{ id: 10, name: "Claw", blocks: [500] }] }] });
		await expect(nameClawTab(t.exec, 500)).resolves.toEqual({ tab: 10, renamed: false });
		expect(t.renames()).toHaveLength(0);
	});

	it("refuses when the pane is not a live block of this window, and renames nothing", async () => {
		const t = fakeTern(base);
		await expect(nameClawTab(t.exec, 4242)).rejects.toThrow("is not a live block");
		expect(t.renames()).toHaveLength(0);
	});

	it("refuses when Tern refuses the rename", async () => {
		const t = fakeTern(base, { refuseRename: true });
		await expect(nameClawTab(t.exec, 500)).rejects.toThrow("rename refused");
		expect(t.names()[10]).toBeNull();
	});

	it("refuses when Tern answers but the name did not change", async () => {
		const t = fakeTern(base, { silentRename: true });
		await expect(nameClawTab(t.exec, 500)).rejects.toThrow("did not stick");
	});

	it("reports an absent Tern as an error instead of inventing a tab", async () => {
		const t = fakeTern(base, { absent: true });
		await expect(nameClawTab(t.exec, 500)).rejects.toThrow("ENOENT");
		expect(t.renames()).toHaveLength(0);
	});

	it("reads the pane identity only from a numeric TERN_PANE", () => {
		expect(ownPaneBlock({ TERN_PANE: "106334800314469" })).toBe(106334800314469);
		expect(ownPaneBlock({ TERN_PANE: " 42 " })).toBe(42);
		expect(ownPaneBlock({ TERN_PANE: "x" })).toBeUndefined();
		expect(ownPaneBlock({})).toBeUndefined();
	});

	it("routes launches to the session of the orchestrator pane, not a same-named tab elsewhere", async () => {
		const win: Window = { sessions: [
			{ id: 1, tabs: [{ id: 10, name: "Claw", blocks: [700] }] },
			{ id: 2, tabs: [{ id: 20, name: null, blocks: [500] }] },
		] };
		const t = fakeTern(win);
		await expect(clawSession(t.exec, 500)).resolves.toBe(2);
		await expect(clawSession(t.exec)).resolves.toBe(1);
	});

	it("a worker tab whose rename fails is still reported as open, with named false", async () => {
		const t = fakeTern(base, { refuseRename: true });
		const made = await launchTab(t.exec, { session: 1, cwd: "/tmp", label: "smoke", runId: "run-x1", clawDir: "/tmp/c", prompt: "p" });
		expect(made).toEqual({ tab: 9001, block: 9002, named: false });
	});
});

describe("/claw on command", () => {
	let dir: string;
	beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "claw-cmd-")); });
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	function harness(tern: TernExec, env: NodeJS.ProcessEnv) {
		const commands: Record<string, { handler: (args: string, ctx: any) => Promise<unknown> }> = {};
		const pi = { getCwd: () => dir, on: () => undefined, registerTool: () => undefined, registerCommand: (name: string, o: any) => { commands[name] = o; } };
		const ensured: string[] = [];
		registerOrchestrator(pi, { tern, env, ensure: (store) => { ensured.push(store.dir); return 4242; } });
		const notes: { msg: string; level: string }[] = [];
		const ctx = { ui: { notify: (msg: string, level = "info") => notes.push({ msg, level }) } };
		return { run: (args: string) => commands.claw.handler(args, ctx), notes, ensured, store: ClawStore.forWorkspace(dir) };
	}

	it("names the pane's tab Claw, records the pane, and starts the daemon", async () => {
		const t = fakeTern(base);
		const h = harness(t.exec, { TERN_PANE: "500" });
		await h.run("on");
		expect(t.renames()).toEqual([["rename", "500", "Claw", "--json"]]);
		expect(h.notes.at(-1)).toEqual({ msg: expect.stringContaining('Tab named "Claw".'), level: "info" });
		expect(h.store.readControl()).toMatchObject({ enabled: true, pane: 500 });
		expect(h.ensured).toHaveLength(1);
	});

	it("warns with the exact manual step when Tern refuses, and still turns Claw on", async () => {
		const t = fakeTern(base, { refuseRename: true });
		const h = harness(t.exec, { TERN_PANE: "500" });
		await h.run("on");
		expect(h.notes.at(-1)?.level).toBe("warning");
		expect(h.notes.at(-1)?.msg).toContain('Tab not named: tern: rename refused. Name it "Claw" yourself.');
		expect(h.store.readControl().enabled).toBe(true);
	});

	it("warns when Tern is absent, without touching any tab", async () => {
		const t = fakeTern(base, { absent: true });
		const h = harness(t.exec, { TERN_PANE: "500" });
		await h.run("on");
		expect(h.notes.at(-1)?.msg).toContain("ENOENT");
		expect(h.notes.at(-1)?.level).toBe("warning");
		expect(h.ensured).toHaveLength(1);
	});

	it("outside a Tern pane it names nothing and calls Tern not at all", async () => {
		const t = fakeTern(base);
		const h = harness(t.exec, {});
		await h.run("on");
		expect(t.calls).toHaveLength(0);
		expect(h.notes.at(-1)?.msg).toContain("TERN_PANE unset");
		expect(h.store.readControl().pane).toBeUndefined();
	});

	it("off keeps the recorded pane for the next on", async () => {
		const t = fakeTern(base);
		const h = harness(t.exec, { TERN_PANE: "500" });
		await h.run("on");
		await h.run("off");
		expect(h.store.readControl()).toMatchObject({ enabled: false, pane: 500 });
	});
});
