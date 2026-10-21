/** Worker-side (child pi) helpers. The worker only appends events to its own run file; the daemon applies them. */
import { randomBytes } from "node:crypto";
import type { ClawStore, ClawEvent, Finish } from "./store.ts";

/** Tools a worker may never call: it is a depth-1 worker and must not create workers, schedules or triggers. */
export const WORKER_BLOCKED_TOOLS: readonly string[] = [
	"Agent", "AgentControl", "Subagent", "Delegate", "DelegateOutput", "BackgroundTask", "SubagentOutput", "TaskOutput",
	"claw_spawn", "claw_send", "claw_cancel", "claw_trigger", "claw_list", "claw_read",
];

export type WorkerIdentity = { runId: string; clawDir: string };
export function workerIdentity(env: Record<string, string | undefined> = process.env): WorkerIdentity | undefined {
	const runId = env.PI_CLAW_RUN;
	const clawDir = env.PI_CLAW_DIR;
	return runId && clawDir && /^run-[\w-]+$/.test(runId) ? { runId, clawDir } : undefined;
}

const eid = () => `evt-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;

export function recordStarted(store: ClawStore, runId: string, pid: number, sessionFile?: string): void {
	store.appendEvent({ eid: eid(), type: "started", at: new Date().toISOString(), runId, pid, sessionFile });
}

/** Text and stop reason of the last assistant message in an agent_end event. */
export function lastAssistant(messages: unknown): { text: string; stopReason?: string } {
	const list = Array.isArray(messages) ? messages : [];
	for (let i = list.length - 1; i >= 0; i--) {
		const m = list[i] as { role?: string; content?: unknown; stopReason?: string };
		if (m?.role !== "assistant") continue;
		const text = typeof m.content === "string" ? m.content
			: Array.isArray(m.content) ? m.content.filter((p: { type?: string }) => p?.type === "text").map((p: { text?: string }) => p.text ?? "").join("\n")
			: "";
		return { text: text.slice(0, 4000), stopReason: m.stopReason };
	}
	return { text: "" };
}

export function recordSettled(store: ClawStore, runId: string, messages: unknown): void {
	const last = lastAssistant(messages);
	store.appendEvent({ eid: eid(), type: "settled", at: new Date().toISOString(), runId, text: last.text, stopReason: last.stopReason });
}

/** Validates the explicit completion report. Completion needs evidence; "completed" without it is refused here. */
export function validateFinish(input: { outcome?: unknown; summary?: unknown; evidence?: unknown }): Omit<Finish, "at"> {
	const outcome = input.outcome;
	if (outcome !== "completed" && outcome !== "failed" && outcome !== "needs_user") throw new Error('outcome must be "completed", "failed" or "needs_user"');
	const summary = typeof input.summary === "string" ? input.summary.trim() : "";
	if (!summary) throw new Error("summary is required");
	const evidence = Array.isArray(input.evidence) ? input.evidence.map((e) => String(e).trim()).filter(Boolean).slice(0, 50) : [];
	if (outcome === "completed" && evidence.length === 0) throw new Error("completed requires evidence: list the commands run, files changed or outputs checked");
	return { outcome, summary: summary.slice(0, 4000), evidence: evidence.map((e) => e.slice(0, 1000)) };
}

export function recordFinish(store: ClawStore, runId: string, finish: Omit<Finish, "at">): void {
	const event: ClawEvent = { eid: eid(), type: "finish", at: new Date().toISOString(), runId, outcome: finish.outcome, summary: finish.summary, evidence: finish.evidence };
	store.appendEvent(event);
}
