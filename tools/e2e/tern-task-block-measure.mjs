#!/usr/bin/env -S node --experimental-strip-types
/**
 * Measures the transcript task block in Tern itself (not by reading our own CSS): seeds a canonical
 * task snapshot, replays the real bridge's frames into a headless `tern serve`, then reports the block's
 * rendered box, its row/question counts and the computed font size of the row and question text.
 *
 *   node tools/e2e/tern-task-block-measure.mjs [--json] [--size=900x760]
 *
 * Exit 1 if the block is absent, so a green run means Tern really painted it.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiTernBridge } from "../../.pi/lib/tern/bridge.ts";
import { PI_COMPOSER_CSS } from "../../.pi/lib/tern/composer-style.ts";

const TERN = process.env.TERN_BIN ?? "tern";
const base = { priority: "medium", dependsOn: [], notes: [], createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" };
const taskState = {
	type: "custom",
	customType: "pi-swarm-task-state",
	data: {
		schemaVersion: 2, revision: 1, savedAt: "2026-01-01T00:00:00Z", nextId: 7, keys: {}, tasks: [
			{ ...base, id: "1", subject: "Wire the live task block", status: "in_progress", active: true,
				questions: [{ id: "q1", text: "Does the block render only live work?" }, { id: "q2", text: "Is the row type one step down?" }],
				answers: [{ question: "q1", answer: "yes", evidence: "tool:Bash#1" }] },
			{ ...base, id: "2", subject: "Unblock the migration task", status: "pending", dependsOn: ["1"],
				questions: [{ id: "q1", text: "Who signs off the schema change?" }] },
			{ ...base, id: "3", subject: "Write the release note", status: "pending" },
			{ ...base, id: "4", subject: "Ship 0.9.0", status: "completed" },
			{ ...base, id: "5", subject: "Remove the composer copy", status: "completed" },
			{ ...base, id: "6", subject: "Audit the old popover", status: "completed" },
		],
	},
};

const listeners = new Set();
const session = {
	state: {},
	subscribe: (listener) => (listeners.add(listener), () => listeners.delete(listener)),
	prompt: () => new Promise(() => {}),
	abort: async () => {},
	dispose() {},
	sessionManager: { getSessionId: () => "task-block-measure", getEntries: () => [taskState], getBranch: () => [taskState], getCwd: () => process.cwd() },
};

const dir = mkdtempSync(join(tmpdir(), "tern-task-block-"));
const sock = join(dir, "ctl.sock");
const rec = join(dir, "frames.jsonl");
const cssFile = join(dir, "composer.css");
let child;
const cleanup = () => { try { if (existsSync(sock)) ctl("quit"); } catch { /* already gone */ } child?.kill(); rmSync(dir, { recursive: true, force: true }); };
process.on("exit", cleanup);

const writes = [];
const bridge = new PiTernBridge(session, { write: (data) => writes.push(data), surfaceId: "pi", credits: 1_000_000 });
bridge.start("pi");
const lines = [];
let t = 0;
for (const write of writes) {
	for (const hit of write.matchAll(/\x1b_tsp;([A-Za-z]);([\s\S]*?)\x1b\\/g)) {
		try { lines.push(JSON.stringify({ t: (t += 16), dir: "out", verb: hit[1], body: JSON.parse(hit[2]) })); } catch { /* not a frame */ }
	}
}
bridge.close?.();
writeFileSync(rec, lines.join("\n") + "\n");
writeFileSync(cssFile, PI_COMPOSER_CSS);

child = spawn(TERN, ["serve", "--control", sock], { cwd: dir, stdio: "ignore", detached: true });
const deadline = Date.now() + 30_000;
while (!existsSync(sock)) {
	if (Date.now() > deadline) throw new Error("tern serve did not open its control socket");
	execFileSync("sleep", ["0.05"]);
}
function ctl(command) {
	const raw = execFileSync(TERN, ["ctl", "--control", sock, command], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
	const reply = JSON.parse(raw);
	if (reply.ok !== true) throw new Error(`tern ctl ${command}: ${reply.error ?? "failed"}`);
	return reply;
}

const size = (process.argv.find((a) => a.startsWith("--size=")) ?? "--size=900x760").slice("--size=".length).split("x");
ctl(`resize ${size[0]} ${size[1]}`);
ctl(`surface-play "${rec}"`);
ctl(`css composer ${cssFile}`);
ctl("wait 500");

const box = (selector) => (ctl(`tree ${selector}`).nodes ?? [])[0]?.rect ?? null;
const style = (selector) => (ctl(`dump ${selector}`).elements ?? [])[0] ?? null;
const count = (selector) => (ctl(`tree ${selector}`).nodes ?? []).length;

const block = box("[data-role='pi.tasks.block']");
if (!block) {
	console.error("FAIL: Tern painted no [data-role='pi.tasks.block']");
	cleanup();
	process.exit(1);
}
const target = style("[data-role='pi.tasks.block'] .sf-tool-target");
const question = style("[data-role='pi.tasks.line-q']");
const head = style("[data-role='pi.tasks.block-head']");
const summary = {
	blockHeight: block[3],
	blockRect: block,
	rows: count("[data-role='pi.tasks.line']"),
	questions: count("[data-role='pi.tasks.line-q']"),
	fonts: {
		head: head ? parseFloat(head.fontSize) : null,
		row: target ? parseFloat(target.fontSize) : null,
		question: question ? parseFloat(question.fontSize) : null,
	},
	headText: (ctl("tree [data-role='pi.tasks.block-head']").nodes ?? [])[0]?.text ?? "",
};
console.log(process.argv.includes("--json") ? JSON.stringify(summary, null, 2) : `task block ${JSON.stringify(summary)}`);
cleanup();
