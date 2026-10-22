#!/usr/bin/env node
/** Measure the /claw supervision metrics of a store, so "before" and "after" are the same five numbers computed the
 *  same way. Reads a claw dir (runs/, inbox.jsonl, optional notices.jsonl) and prints JSON plus a short table.
 *
 *  Usage: node tools/claw/metrics.mjs --store <claw dir> [--tern <tern ls --json snapshot>] [--label before]
 *
 *  Metrics (all over the runs in the store, optionally filtered by --since/--until on createdAt):
 *   duplicateNoticesPerRun  notices of one kind beyond the first for the same run (transitions only should be 0)
 *   runsWithoutTab          runs that reached a worker phase but no tab block was ever recorded
 *   deadBeforeAnyEvent      runs ended with no event at all (a worker that never said anything)
 *   orphanTabs              terminal runs whose tab was never closed (cross-checked against the Tern snapshot)
 *   needsUserLatencySec     for every needs_user notice: seconds until a human action or the window end
 *   recoverySec             for every terminal run: seconds from terminal update to its tab close (undefined if never)
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const arg = (name, fallback) => {
	const i = args.indexOf(`--${name}`);
	return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const storeDir = arg("store");
if (!storeDir) throw new Error("usage: metrics.mjs --store <claw dir> [--tern snapshot.json] [--label name]");
const label = arg("label", "store");
const since = arg("since");
const until = arg("until");

const readLines = (path) => {
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8").split("\n").filter(Boolean).flatMap((line) => {
		try { return [JSON.parse(line)]; } catch { return []; }
	});
};

const terminal = new Set(["completed", "failed", "lost", "cancelled"]);
const runsDir = join(storeDir, "runs");
const runs = readdirSync(runsDir).filter((f) => /^run-[\w-]+\.json$/.test(f))
	.map((f) => JSON.parse(readFileSync(join(runsDir, f), "utf8")))
	.filter((r) => (!since || r.createdAt >= since) && (!until || r.createdAt <= until))
	.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

const eventsOf = (id) => readLines(join(runsDir, `${id}.events.jsonl`));
const inbox = readLines(join(storeDir, "inbox.jsonl"));
const notices = [...inbox, ...readLines(join(storeDir, "notices.jsonl"))].sort((a, b) => String(a.at).localeCompare(String(b.at)));
const windowEnd = until ?? new Date().toISOString();

/** Tern snapshot: which blocks are still live right now. */
let liveBlocks = null;
const ternPath = arg("tern");
if (ternPath) {
	const snap = JSON.parse(readFileSync(ternPath, "utf8"));
	liveBlocks = new Set();
	for (const session of snap.sessions ?? []) for (const tab of session.tabs ?? []) for (const block of tab.blocks ?? []) {
		if (block.exited == null && block.live !== false) liveBlocks.add(block.id);
	}
}

const perRun = new Map();
for (const item of notices) {
	if (!item.runId) continue;
	const list = perRun.get(item.runId) ?? [];
	list.push(item);
	perRun.set(item.runId, list);
}

const duplicates = [];
const repeatedKeys = [];
for (const [runId, items] of perRun) {
	const byKind = {};
	const byKey = {};
	for (const item of items) {
		byKind[item.kind] = (byKind[item.kind] ?? 0) + 1;
		const key = `${item.kind}|${item.key ?? item.id}`;
		byKey[key] = (byKey[key] ?? 0) + 1;
	}
	for (const [kind, count] of Object.entries(byKind)) if (count > 1) duplicates.push({ runId, kind, count, extra: count - 1 });
	for (const [key, count] of Object.entries(byKey)) if (count > 1) repeatedKeys.push({ runId, key, count });
}
const duplicateExtras = duplicates.reduce((n, d) => n + d.extra, 0);
/** Actionable = an item the orchestrator must look at. Digests and heartbeats are the collapsed, periodic remainder. */
const actionable = inbox.filter((i) => i.kind !== "claw_digest" && i.kind !== "claw_heartbeat");
const inboxByKind = inbox.reduce((acc, i) => ({ ...acc, [i.kind]: (acc[i.kind] ?? 0) + 1 }), {});

/** A run that reached a worker phase but never recorded a tab, or was cancelled before any tab existed. */
const runsWithoutTab = runs.filter((r) => r.block === undefined && ["issue_created", "tab_opening", "tab_open"].includes(r.phase));
const deadBeforeAnyEvent = runs.filter((r) => eventsOf(r.id).length === 0 && (terminal.has(r.status) || r.status === "launching"));

const terminalRuns = runs.filter((r) => terminal.has(r.status));
const unclosed = terminalRuns.filter((r) => r.block !== undefined && !r.tabClosedAt);
const unclosedLive = liveBlocks ? unclosed.filter((r) => liveBlocks.has(r.block)) : [];

const needsUser = [];
for (const r of runs) {
	const items = perRun.get(r.id) ?? [];
	for (const item of items) {
		if (item.kind !== "run_needs_user") continue;
		const answered = items.find((i) => String(i.at) > String(item.at) && ["run_cancelled", "run_completed", "run_failed"].includes(i.kind));
		const end = answered ? Date.parse(answered.at) : terminal.has(r.status) ? Date.parse(r.updatedAt) : Date.parse(windowEnd);
		needsUser.push({ runId: r.id, at: item.at, answeredBy: answered?.kind ?? (terminal.has(r.status) ? `status:${r.status}` : null), seconds: Math.max(0, Math.round((end - Date.parse(item.at)) / 1000)) });
	}
}
const median = (values) => {
	if (!values.length) return null;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)];
};

const recovery = terminalRuns.filter((r) => r.tabClosedAt).map((r) => Math.max(0, Math.round((Date.parse(r.tabClosedAt) - Date.parse(r.updatedAt)) / 1000)));
const recoveredRuns = notices.filter((i) => i.kind === "run_recovered").length;
const stalled = notices.filter((i) => i.kind === "run_stalled").length;
const orphans = notices.filter((i) => i.kind === "run_tab_orphan").length;
const digests = notices.filter((i) => i.kind === "claw_digest").length;
const heartbeats = notices.filter((i) => i.kind === "claw_heartbeat").length;

const report = {
	label,
	window: { since: since ?? runs[0]?.createdAt ?? null, until: windowEnd, runs: runs.length },
	inbox: {
		total: inbox.length, byKind: inboxByKind, digests: inboxByKind.claw_digest ?? 0, heartbeats: inboxByKind.claw_heartbeat ?? 0,
		actionable: actionable.length, actionablePerRun: runs.length ? Number((actionable.length / runs.length).toFixed(2)) : 0,
		repeatedKeys: repeatedKeys.length, notices: notices.length,
	},
	duplicateNoticesPerRun: runs.length ? Number((duplicateExtras / runs.length).toFixed(2)) : 0,
	duplicateNotices: { extras: duplicateExtras, groups: duplicates.length, repeatedKeys: repeatedKeys.length, byKind: duplicates.reduce((acc, d) => ({ ...acc, [d.kind]: (acc[d.kind] ?? 0) + d.extra }), {}) },
	runsWithoutTab: runsWithoutTab.length,
	deadBeforeAnyEvent: deadBeforeAnyEvent.length,
	orphanTabs: { terminalRuns: terminalRuns.length, unclosed: unclosed.length, unclosedLiveNow: liveBlocks ? unclosedLive.length : null, remediationReported: orphans },
	needsUser: { notices: needsUser.length, medianLatencySec: median(needsUser.map((n) => n.seconds)), maxLatencySec: needsUser.reduce((m, n) => Math.max(m, n.seconds), 0), unanswered: needsUser.filter((n) => !n.answeredBy).length },
	recoverySec: { closedTabs: recovery.length, median: median(recovery), max: recovery.reduce((m, n) => Math.max(m, n), 0) },
	supervision: { stalledReports: stalled, orphanReports: orphans, recoveredRuns, digests, heartbeats, noticeItems: notices.length },
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!args.includes("--json")) {
	const r = report;
	process.stderr.write(`\n${label}: ${r.window.runs} runs ${r.window.since}..${r.window.until}\n`);
	process.stderr.write(`  inbox items           : ${r.inbox.total} (${r.inbox.actionable} actionable = ${r.inbox.actionablePerRun}/run, ${r.inbox.digests} digests, ${r.inbox.heartbeats} heartbeats, ${r.inbox.repeatedKeys} repeated keys)\n`);
	process.stderr.write(`  duplicate notices/run : ${r.duplicateNoticesPerRun} (${r.duplicateNotices.extras} extras)\n`);
	process.stderr.write(`  runs without a tab    : ${r.runsWithoutTab}\n`);
	process.stderr.write(`  dead before any event : ${r.deadBeforeAnyEvent}\n`);
	process.stderr.write(`  orphan tabs           : ${r.orphanTabs.unclosed}/${r.orphanTabs.terminalRuns} terminal (live now: ${r.orphanTabs.unclosedLiveNow ?? "n/a"})\n`);
	process.stderr.write(`  needs_user latency    : median ${r.needsUser.medianLatencySec}s, max ${r.needsUser.maxLatencySec}s over ${r.needsUser.notices}\n`);
	process.stderr.write(`  tab close after end   : median ${r.recoverySec.median}s over ${r.recoverySec.closedTabs} runs\n`);
	process.stderr.write(`  supervision items     : ${r.supervision.noticeItems} (${r.supervision.digests} digests, ${r.supervision.heartbeats} heartbeats, ${r.supervision.stalledReports} stall reports, ${r.supervision.orphanReports} orphan reports, ${r.supervision.recoveredRuns} recoveries)\n\n`);
}
