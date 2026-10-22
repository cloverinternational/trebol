import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deliveredInboxIds, INBOX_TYPE, inboxId, pumpInbox, RESEND_AFTER_MS, type InboxMessage, type PumpDeps } from "../../lib/claw/inbox.ts";
import { ClawStore } from "../../lib/claw/store.ts";

/** Pi transcript double: `persisted` is what the session file contains. A send only records the wake. */
function harness(store: ClawStore, session: string) {
	const persisted: InboxMessage[] = [];
	const sent: InboxMessage[] = [];
	let clock = 1_000_000;
	const deps: PumpDeps = {
		store, session,
		delivered: () => deliveredInboxIds(persisted.map((m) => ({ type: "custom_message", customType: INBOX_TYPE, details: m.details }))),
		send: async (message) => { sent.push(message); return true; },
		now: () => clock,
	};
	return { deps, persisted, sent, persist: () => { persisted.push(...sent.filter((m) => !persisted.includes(m))); }, advance: (ms: number) => { clock += ms; } };
}

describe("claw inbox: persist-before-ack", () => {
	let dir: string;
	let store: ClawStore;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "claw-inbox-"));
		store = ClawStore.forWorkspace(dir);
		store.writeOrchestrator({ offset: 0, owner: "s1", ownerPid: process.pid });
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("a dispatched wake is not an acknowledgement: the offset stays until the item is in the transcript", async () => {
		store.appendInbox({ kind: "notify", text: "first", key: "k1" });
		const h = harness(store, "s1");
		expect(await pumpInbox(h.deps)).toBe("sent");
		expect(store.readOrchestrator().offset).toBe(0);
		expect(store.readOrchestrator().inflight?.ids).toEqual(["k1"]);
		expect(await pumpInbox(h.deps)).toBe("waiting");
		h.persist();
		expect(await pumpInbox(h.deps)).toBe("advanced");
		expect(store.readOrchestrator().offset).toBeGreaterThan(0);
		expect(store.readOrchestrator().inflight).toBeUndefined();
		expect(h.sent).toHaveLength(1);
	});

	it("an item is delivered once per session transcript: items already persisted are never re-sent", async () => {
		store.appendInbox({ kind: "notify", text: "a", key: "dup-1" });
		const h = harness(store, "s1");
		h.persisted.push({ customType: INBOX_TYPE, content: "earlier", display: true, details: { eventIds: ["dup-1"] } });
		expect(await pumpInbox(h.deps)).toBe("advanced");
		expect(h.sent).toHaveLength(0);
		expect(store.readOrchestrator().offset).toBeGreaterThan(0);
	});

	it("a restart with an in-flight batch resends it to the new process unless its ids are already persisted", async () => {
		store.appendInbox({ kind: "notify", text: "lost-wake", key: "wk-1" });
		const before = harness(store, "s1");
		await pumpInbox(before.deps);
		// Process dies before persistence. A new process (new session) takes ownership and resumes.
		store.writeOrchestrator({ ...store.readOrchestrator(), owner: "s2", ownerPid: 999999 });
		const after = harness(store, "s2");
		expect(await pumpInbox(after.deps)).toBe("sent");
		expect(after.sent[0].details.eventIds).toEqual(["wk-1"]);
		after.persist();
		expect(await pumpInbox(after.deps)).toBe("advanced");
		expect(store.readOrchestrator().offset).toBeGreaterThan(0);
	});

	it("an overdue in-flight batch in the same session is resent with the same stable id", async () => {
		store.appendInbox({ kind: "notify", text: "slow", key: "slow-1" });
		const h = harness(store, "s1");
		await pumpInbox(h.deps);
		h.advance(RESEND_AFTER_MS + 1);
		expect(await pumpInbox(h.deps)).toBe("sent");
		expect(h.sent.map((m) => m.details.eventIds)).toEqual([["slow-1"], ["slow-1"]]);
	});

	it("a non-owner session delivers nothing and writes nothing", async () => {
		store.appendInbox({ kind: "notify", text: "for owner", key: "o-1" });
		const h = harness(store, "not-owner");
		const before = JSON.stringify(store.readOrchestrator());
		expect(await pumpInbox(h.deps)).toBe("not_owner");
		expect(h.sent).toHaveLength(0);
		expect(JSON.stringify(store.readOrchestrator())).toBe(before);
	});

	it("overlapping pumps on one store run a single send", async () => {
		store.appendInbox({ kind: "notify", text: "once", key: "c-1" });
		const h = harness(store, "s1");
		const slowSend = h.deps.send;
		h.deps.send = async (m) => { await new Promise((r) => setTimeout(r, 20)); return slowSend(m); };
		const [a, b] = await Promise.all([pumpInbox(h.deps), pumpInbox(h.deps)]);
		expect([a, b].sort()).toEqual(["sent", "waiting"]);
		expect(h.sent).toHaveLength(1);
	});

	it("a wake Pi refuses is not left in flight, so the next pass tries again", async () => {
		store.appendInbox({ kind: "notify", text: "refused", key: "r-1" });
		const h = harness(store, "s1");
		h.deps.send = async () => false;
		expect(await pumpInbox(h.deps)).toBe("idle");
		expect(store.readOrchestrator().inflight).toBeUndefined();
		expect(store.readOrchestrator().offset).toBe(0);
	});

	it("every inbox item carries a stable id; appending the same key twice writes one item", () => {
		store.appendInbox({ kind: "notify", text: "x", key: "same" });
		store.appendInbox({ kind: "notify", text: "x again", key: "same" });
		const { items } = store.readInbox(0);
		expect(items).toHaveLength(1);
		expect(items[0].id).toBe("same");
		store.appendInbox({ kind: "notify", text: "no key" });
		expect(store.readInbox(0).items[1].id).toMatch(/^evt-/);
	});

	it("legacy items without an id still dedup through a content hash", () => {
		writeFileSync(store.inboxPath, `${JSON.stringify({ at: "t", kind: "notify", text: "old" })}\n`);
		const [item] = store.readInbox(0).items;
		expect(inboxId(item)).toMatch(/^legacy-/);
		expect(inboxId(item)).toBe(inboxId(item));
	});

	it("only custom_message entries of the inbox type count as delivered; the model's own text never does", () => {
		const ids = deliveredInboxIds([
			{ type: "message", customType: INBOX_TYPE, details: { eventIds: ["x"] } },
			{ type: "custom_message", customType: "other", details: { eventIds: ["y"] } },
			{ type: "custom_message", customType: INBOX_TYPE, details: { eventIds: ["z"] } },
		]);
		expect([...ids]).toEqual(["z"]);
	});
});
