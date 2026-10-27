/** Orchestrator inbox delivery. At-least-once with receiver dedup.
 *  - Sending a wake only means Pi accepted it. The inbox offset advances only after the item's id is seen in this
 *    session's own transcript (a custom_message entry carrying details.eventIds). Until then the batch is "in flight".
 *  - One cursor per orchestrator session (store sessions/<session>.json). A session receives the items addressed to it
 *    (`item.owner`, the session that started the run or trigger) and the unaddressed ones; another session's items are
 *    skipped, so two Claw sessions in one workspace never receive each other's runs.
 *  - Restart of the same session: an in-flight batch sent by another process is re-sent at once unless its ids are
 *    already in that transcript.
 *  - Dedup uses stable inbox ids, never ids written by the model.
 *  - Not guaranteed: a turn may be scheduled twice if a resend races a slow persist; an external side effect of a turn is
 *    never deduplicated by this module. */
import { createHash } from "node:crypto";
import type { ClawStore, InboxItem, OrchestratorState } from "./store.ts";

export const INBOX_TYPE = "claw-inbox";
export const RESEND_AFTER_MS = 30_000;

export type TranscriptEntry = { type?: string; customType?: string; details?: unknown };
export type InboxMessage = { customType: string; content: string; display: boolean; details: { eventIds: string[] } };
export type PumpDeps = {
	store: ClawStore;
	session: string;
	/** Ids of inbox items already persisted in this session's branch. */
	delivered: () => Set<string>;
	/** Dispatches a wake. Resolves true when accepted for delivery, which is not persistence. */
	send: (message: InboxMessage) => Promise<boolean>;
	now: () => number;
	/** This process; defaults to process.pid. */
	pid?: number;
};
/** not_owner: this session is not registered for delivery (it never turned Claw on or called a claw tool). */
export type PumpResult = "not_owner" | "waiting" | "idle" | "sent" | "advanced";

export function deliveredInboxIds(entries: readonly TranscriptEntry[]): Set<string> {
	const ids = new Set<string>();
	for (const entry of entries) {
		if (entry.type !== "custom_message" || entry.customType !== INBOX_TYPE) continue;
		const eventIds = (entry.details as { eventIds?: unknown } | undefined)?.eventIds;
		if (Array.isArray(eventIds)) for (const id of eventIds) if (typeof id === "string") ids.add(id);
	}
	return ids;
}

/** Items written before ids existed fall back to a content hash, so they still dedup. */
export function inboxId(item: InboxItem): string {
	return item.id ?? item.key ?? `legacy-${createHash("sha256").update(JSON.stringify(item)).digest("hex").slice(0, 16)}`;
}

const running = new Set<string>();

/** Single-flight per store and session: an overlapping tick returns "waiting" without touching state. */
export async function pumpInbox(deps: PumpDeps): Promise<PumpResult> {
	const flight = `${deps.store.dir}\0${deps.session}`;
	if (running.has(flight)) return "waiting";
	running.add(flight);
	try { return await step(deps); } finally { running.delete(flight); }
}

/** Items for this session: its own runs' and triggers', plus unaddressed ones (daemon-wide, or older than owners). */
export const forSession = (item: InboxItem, session: string): boolean => item.owner === undefined || item.owner === session;

/** Read-modify-write of this session's own cursor; never touches another session's. */
function update(store: ClawStore, session: string, patch: (cur: OrchestratorState) => OrchestratorState): boolean {
	const cur = store.readCursor(session);
	if (!cur) return false;
	store.writeCursor(session, patch(cur));
	return true;
}

async function step(deps: PumpDeps): Promise<PumpResult> {
	const { store, session, now } = deps;
	const pid = deps.pid ?? process.pid;
	const state = store.readCursor(session);
	if (!state) return "not_owner";
	const delivered = deps.delivered();
	let offset = state.offset;
	let advanced = false;
	if (state.inflight) {
		const inflight = state.inflight;
		if (inflight.ids.every((id) => delivered.has(id))) {
			update(store, session, (cur) => ({ ...cur, offset: inflight.endOffset, inflight: undefined }));
			offset = inflight.endOffset;
			advanced = true;
		} else if (inflight.session === session && (inflight.pid === undefined || inflight.pid === pid) && now() - Date.parse(inflight.sentAt) < RESEND_AFTER_MS) {
			return "waiting";
		}
	}
	const read = store.readInbox(offset);
	if (!read.items.length) return advanced ? "advanced" : "idle";
	const pendingItems = read.items.filter((item) => forSession(item, session) && !delivered.has(inboxId(item)));
	if (!pendingItems.length) {
		update(store, session, (cur) => ({ ...cur, offset: read.offset, inflight: undefined }));
		return "advanced";
	}
	const ids = pendingItems.map(inboxId);
	update(store, session, (cur) => ({ ...cur, inflight: { ids, endOffset: read.offset, sentAt: new Date(now()).toISOString(), session, pid } }));
	const body = pendingItems.map((item) => `- [${item.kind}] ${item.text}`).join("\n");
	const accepted = await deps.send({ customType: INBOX_TYPE, content: `Claw inbox (${ids.length}):\n${body}`, display: true, details: { eventIds: ids } });
	if (!accepted) {
		update(store, session, (cur) => ({ ...cur, inflight: undefined }));
		return advanced ? "advanced" : "idle";
	}
	return "sent";
}
