#!/usr/bin/env node
/** Two Claw orchestrator sessions as two real OS processes on one workspace store; each must receive only its own
 *  runs plus the daemon-wide items. Sandbox: a temp workspace, no daemon process, no Tern, no Hoja.
 *
 *  Usage: node --experimental-strip-types tools/e2e/claw-two-orchestrators.mjs
 *  Prints PASS or FAIL with what each process received. */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const lib = (p) => join(root, ".pi", "lib", "claw", p);

if (process.argv[2] === "--child") {
	// One orchestrator process: register this session, then pump until told to stop, printing every delivered id.
	const [, , , dir, session] = process.argv;
	const { ClawStore } = await import(lib("store.ts"));
	const { pumpInbox, deliveredInboxIds } = await import(lib("inbox.ts"));
	const store = new ClawStore(dir);
	store.registerSession(session, process.pid, () => true);
	process.stdout.write("ready\n");
	const received = [];
	const persisted = [];
	const deadline = Date.now() + 4000;
	while (Date.now() < deadline) {
		await pumpInbox({
			store, session, now: () => Date.now(),
			delivered: () => deliveredInboxIds(persisted),
			send: async (m) => { received.push(...m.details.eventIds); persisted.push({ type: "custom_message", customType: m.customType, details: m.details }); return true; },
		});
		await new Promise((r) => setTimeout(r, 100));
	}
	process.stdout.write(`${JSON.stringify({ session, pid: process.pid, received })}\n`);
	process.exit(0);
}

const dir = mkdtempSync(join(tmpdir(), "claw-two-orch-"));
try {
	const { ClawStore } = await import(lib("store.ts"));
	const { applyEvent } = await import(lib("daemon.ts"));
	const store = new ClawStore(join(dir, ".swarm", "claw"));
	const child = (session) => {
		const proc = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", fileURLToPath(import.meta.url), "--child", store.dir, session], { stdio: ["ignore", "pipe", "inherit"] });
		let out = "";
		const ready = new Promise((resolve) => proc.stdout.on("data", (d) => { out += d; if (out.includes("ready")) resolve(); }));
		const done = new Promise((resolve) => proc.on("exit", () => resolve(JSON.parse(out.trim().split("\n").at(-1)))));
		return { ready, done };
	};
	const a = child("sess-A");
	const b = child("sess-B");
	await Promise.all([a.ready, b.ready]);
	const run = (id, owner) => store.saveRun({ id, label: id, task: "t", cwd: dir, status: "running", phase: "tab_open", createdAt: "", updatedAt: "", project: "P", eventsOffset: 0, settles: 0, attempts: 0, outbox: [], seen: [], ...(owner ? { owner } : {}) });
	for (const [id, owner] of [["run-a1", "sess-A"], ["run-b1", "sess-B"], ["run-a2", "sess-A"]]) {
		applyEvent(run(id, owner), { eid: `f-${id}`, type: "finish", at: "", runId: id, outcome: "completed", summary: `${id} done`, evidence: ["x"] }, store);
	}
	store.appendInbox({ kind: "error", text: "daemon-wide", key: "daemon:e2e" });
	const [ra, rb] = await Promise.all([a.done, b.done]);
	// What each process was woken with, named by the run the item is about (or the daemon-wide key).
	const items = store.readInbox(0).items;
	const about = (id) => { const item = items.find((i) => i.id === id); return item?.runId ?? item?.key ?? id; };
	const got = Object.fromEntries([ra, rb].map((r) => [r.session, r.received.map(about).sort()]));
	const want = { "sess-A": ["daemon:e2e", "run-a1", "run-a2"], "sess-B": ["daemon:e2e", "run-b1"] };
	const ok = JSON.stringify(got["sess-A"]) === JSON.stringify(want["sess-A"]) && JSON.stringify(got["sess-B"]) === JSON.stringify(want["sess-B"]);
	process.stdout.write(`${JSON.stringify({ pids: [ra.pid, rb.pid], got }, null, 2)}\n${ok ? "PASS" : "FAIL"}\n`);
	process.exitCode = ok ? 0 : 1;
} finally {
	rmSync(dir, { recursive: true, force: true });
}
