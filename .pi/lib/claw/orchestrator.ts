/** Orchestrator-side client: every mutation is a request file the daemon answers. Reads go straight to the store. */
import { existsSync } from "node:fs";
import { ClawStore, readJson, TERMINAL, type Request, type RequestBody, type Response } from "./store.ts";
import { pidAlive, startDaemonProcess } from "./daemon.ts";

export const DAEMON_MAIN = new URL("./daemon-main.ts", import.meta.url).pathname;
export const REQUEST_TIMEOUT_MS = 90_000;

export function daemonPid(store: ClawStore): number | undefined {
	const pid = readJson<{ pid: number }>(store.lockPath)?.pid;
	return pid !== undefined && pidAlive(pid) ? pid : undefined;
}

export function ensureDaemon(store: ClawStore, workspace: string): number | undefined {
	const pid = daemonPid(store);
	if (pid !== undefined) return pid;
	startDaemonProcess(workspace, store, DAEMON_MAIN);
	return undefined;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Queues one request and waits for the daemon's answer. A daemon that exited while idle is restarted, so the request
 *  is never orphaned. A timeout leaves the request queued: the daemon will still serve it (idempotent by request id). */
export async function request(store: ClawStore, workspace: string, body: RequestBody, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
	const req = { ...body, id: store.newId("req"), createdAt: new Date().toISOString() } as Request;
	store.writeRequest(req);
	ensureDaemon(store, workspace);
	const deadline = Date.now() + timeoutMs;
	let lastCheck = Date.now();
	for (;;) {
		const res: Response | undefined = store.readResponse(req.id);
		if (res) {
			if (!res.ok) throw new Error(res.error ?? "claw daemon refused the request");
			return res.result;
		}
		if (Date.now() >= deadline) throw new Error(`claw daemon did not answer in ${Math.round(timeoutMs / 1000)}s; request ${req.id} stays queued`);
		if (Date.now() - lastCheck > 5000) { lastCheck = Date.now(); ensureDaemon(store, workspace); }
		await sleep(250);
	}
}

export function statusSummary(store: ClawStore) {
	const runs = store.listRuns();
	const counts: Record<string, number> = {};
	for (const r of runs) counts[r.status] = (counts[r.status] ?? 0) + 1;
	return {
		enabled: store.readControl().enabled,
		daemonPid: daemonPid(store) ?? null,
		runs: counts,
		active: runs.filter((r) => !TERMINAL.includes(r.status) && r.status !== "awaiting_user").map((r) => ({ id: r.id, label: r.label, status: r.status, identifier: r.hoja?.identifier })),
		awaitingUser: runs.filter((r) => r.status === "awaiting_user").map((r) => ({ id: r.id, summary: r.finish?.summary })),
		hojaSyncPending: runs.reduce((n, r) => n + r.outbox.filter((o) => !o.done).length, 0),
		triggers: store.listTriggers().map((t) => ({ id: t.id, enabled: t.enabled, next: t.nextFireAt, fired: t.fired, lastError: t.lastError })),
		unreadInbox: store.readInbox(store.readOrchestrator().offset).items.length,
		logExists: existsSync(store.logPath),
	};
}

