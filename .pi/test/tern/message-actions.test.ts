import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { PiTernBridge, type PiEventLike, type PiSessionLike } from "../../lib/tern/bridge.ts";
import { messageItemFromNode, resolveUserEntry, userEntriesOf } from "../../lib/tern/message-actions.ts";
import { parseTspMessages, type TspMessage } from "../../lib/tern/tsp.ts";

type Node = { id: string; k: string; p?: Record<string, any>; c?: unknown[] };
function surfaceTree(writes: string[]) {
	const nodes = new Map<string, Node>();
	for (const w of writes) for (const m of parseTspMessages(w)) for (const op of ((m.body as { ops?: unknown[][] }).ops ?? [])) {
		const walk = (n: Node) => { nodes.set(n.id, n); for (const c of (n.c ?? []) as Node[]) walk(c); };
		if (op[0] === "add") walk(op[4] as Node);
		if (op[0] === "del") nodes.delete(op[1] as string);
		if (op[0] === "set") { const n = nodes.get(op[1] as string); if (n) n.p = { ...n.p, ...(op[2] as object) }; }
	}
	return nodes;
}

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const user = (text: string, image = false) => ({ role: "user", content: [{ type: "text", text }, ...(image ? [{ type: "image", data: PNG, mimeType: "image/png" }] : [])], timestamp: Date.now() }) as never;
const reply = (text: string) => ({ role: "assistant", content: [{ type: "text", text }], api: "x", provider: "p", model: "m", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() }) as never;

// A Pi session over a real, file-backed SessionManager. navigateTree applies AgentSession.navigateTree's rule for a
// user entry (agent-session.js: "User message: leaf = parent (null if root), text goes to editor") and emits
// session_tree as Pi does; prompt persists the prompt and a reply the way a turn would.
function setup(seed: (sm: SessionManager) => void = () => {}) {
	const dir = mkdtempSync(join(tmpdir(), "tern-msg-"));
	const sm = SessionManager.create(dir, dir);
	seed(sm);
	const listeners = new Set<(e: PiEventLike) => void>();
	const emit = (e: PiEventLike) => { for (const l of listeners) l(e); };
	const calls: string[] = [];
	const sent: Array<{ text: string; images: number }> = [];
	const session = {
		subscribe: (l: (e: PiEventLike) => void) => { listeners.add(l); return () => listeners.delete(l); },
		prompt: async (text: string, opts?: { images?: unknown[] }) => {
			sent.push({ text, images: opts?.images?.length ?? 0 });
			emit({ type: "agent_start" });
			sm.appendMessage({ ...(user(text) as object), content: [{ type: "text", text }, ...((opts?.images ?? []) as object[])] } as never);
			sm.appendMessage(reply(`re: ${text}`));
			emit({ type: "agent_end" });
		},
		abort: async () => {},
		dispose() {},
		sessionManager: sm,
		navigateTree: async (id: string) => {
			calls.push(`navigate:${id}`);
			const target = sm.getEntry(id)!;
			if (target.parentId) sm.branch(target.parentId); else sm.resetLeaf();
			emit({ type: "session_tree" });
			return { cancelled: false };
		},
	} as unknown as PiSessionLike;
	const writes: string[] = [];
	const bridge = new PiTernBridge(session, { write: (d: string) => writes.push(d), surfaceId: "pi", credits: 1_000_000 } as never);
	bridge.start("pi");
	const act = (act: string, id: string) => bridge.handle({ verb: "e", body: { ev: "action", sf: "pi", act, id } } as TspMessage);
	const users = () => userEntriesOf(sm.getBranch());
	return { sm, bridge, act, emit, calls, sent, users, surface: () => surfaceTree(writes), file: sm.getSessionFile()! };
}

function twoTurns(sm: SessionManager) {
	sm.appendMessage(user("first"));
	sm.appendMessage(reply("reply one"));
	sm.appendMessage(user("second"));
	sm.appendMessage(reply("reply two"));
}

describe("message actions", () => {
	it("maps node ids and refuses to guess when the transcript and branch disagree", () => {
		expect(messageItemFromNode("msg-m12.edit")).toBe("m12");
		expect(messageItemFromNode("msg-ab12cd34")).toBe("ab12cd34");
		expect(messageItemFromNode("composer")).toBeUndefined();
		const entries = [{ id: "e1", text: "a", images: [] }, { id: "e2", text: "b", images: [] }];
		expect(resolveUserEntry("e2", [], entries)?.id).toBe("e2");
		expect(resolveUserEntry("n2", ["n1", "n2"], entries)?.id).toBe("e2");
		expect(resolveUserEntry("n2", ["n0", "n1", "n2"], entries)).toBeUndefined();
	});

	it("a click on your message shows Edit / Resend / Copy; a second click or Esc hides it", () => {
		const { act, users, surface, bridge } = setup(twoTurns);
		const [u1] = users();
		const card = surface().get(`msg-${u1!.id}`)!;
		expect(card.p?.actions).toEqual({ click: "message.focus", menu: ["edit-message", "resend-message", "copy"] });
		act("message.focus", `msg-${u1!.id}`);
		const row = surface().get(`msg-${u1!.id}.actions`)!;
		expect((row.c as Node[]).map((b) => b.p?.spans[0].t)).toEqual(["Edit", "Resend", "Copy"]);
		act("message.focus", `msg-${u1!.id}`);
		expect(surface().has(`msg-${u1!.id}.actions`)).toBe(false);
		act("message.focus", `msg-${u1!.id}`);
		bridge.escape();
		expect(surface().has(`msg-${u1!.id}.actions`)).toBe(false);
	});

	it("Resend branches before the message and sends it again; the original stays in the session file", async () => {
		const { act, users, sm, sent, calls, file } = setup(twoTurns);
		const [, u2] = users();
		const parent = sm.getEntry(u2!.id)!.parentId!;
		await act("resend-message", `msg-${u2!.id}.resend`);
		expect(calls).toEqual([`navigate:${u2!.id}`]);
		expect(sent).toEqual([{ text: "second", images: 0 }]);
		// The reply both prompts answer now has two children: the original "second" and the resent one.
		const reopened = SessionManager.open(file);
		expect(reopened.getEntries().filter((e) => e.parentId === parent)).toHaveLength(2);
		expect(userEntriesOf(reopened.getBranch()).map((e) => e.text)).toEqual(["first", "second"]);
		expect(userEntriesOf(reopened.getBranch()).at(-1)!.id).not.toBe(u2!.id);
		expect(reopened.getEntry(u2!.id)).toBeDefined();
	});

	it("Edit fills the composer without touching the session; Esc restores the draft; send branches", async () => {
		const { act, users, sm, sent, calls, bridge, surface } = setup(twoTurns);
		const [, u2] = users();
		const leaf = sm.getLeafId();
		bridge.setDraft("half-typed thought");
		await act("edit-message", `msg-${u2!.id}.edit`);
		expect(surface().get("composer")?.p?.text).toBe("second");
		expect(surface().get("editing-banner-text")?.p?.spans[0].t).toBe("Editing message");
		expect(surface().get(`msg-${u2!.id}`)?.p?.tone).toBe("accent");
		expect(sm.getLeafId()).toBe(leaf);
		bridge.escape();
		expect(surface().get("composer")?.p?.text).toBe("half-typed thought");
		expect(surface().has("editing-banner")).toBe(false);
		expect(calls).toEqual([]);

		bridge.setDraft("");
		await act("edit-message", `msg-${u2!.id}.edit`);
		bridge.setDraft("second, but better");
		await bridge.submitDraft();
		expect(calls).toEqual([`navigate:${u2!.id}`]);
		expect(sent.at(-1)?.text).toBe("second, but better");
		expect(userEntriesOf(sm.getBranch()).map((e) => e.text)).toEqual(["first", "second, but better"]);
		expect(sm.getEntry(u2!.id)).toBeDefined();
		expect(surface().has("editing-banner")).toBe(false);
	});

	it("brings a message's images back as chips on Edit and sends them on Resend", async () => {
		const { act, users, sent, bridge } = setup((sm) => { sm.appendMessage(user("look", true)); sm.appendMessage(reply("seen")); });
		const [u] = users();
		await act("edit-message", `msg-${u!.id}`);
		expect(bridge.attachments.map((a) => [a.kind, a.blob?.mime])).toEqual([["image", "image/png"]]);
		bridge.escape();
		expect(bridge.attachments).toEqual([]);
		await act("resend-message", `msg-${u!.id}`);
		expect(sent).toEqual([{ text: "look", images: 1 }]);
	});

	it("resolves a message sent in this pane (no entry id on screen) by position", async () => {
		const { act, users, calls, bridge } = setup();
		await bridge.submit("hello");
		const [u] = users();
		await act("resend-message", "msg-n1");
		expect(calls).toEqual([`navigate:${u!.id}`]);
	});

	it("refuses while a turn runs and says why", async () => {
		const { act, users, emit, calls, surface } = setup(twoTurns);
		emit({ type: "agent_start" });
		const [u1] = users();
		await act("edit-message", `msg-${u1!.id}`);
		await act("resend-message", `msg-${u1!.id}`);
		expect(calls).toEqual([]);
		expect(JSON.stringify([...surface().values()])).toContain("Wait for the current turn to finish");
	});
});
