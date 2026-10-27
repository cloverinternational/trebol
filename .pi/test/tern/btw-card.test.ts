import { describe, expect, it } from "vitest";
import { PiTernBridge, type PiSessionLike } from "../../lib/tern/bridge.ts";
import { BTW_CARD_ID, BTW_INPUT_ID, TernBtwCard, type BtwEventBus } from "../../lib/tern/btw-card.ts";
import { ESC, parseTspMessages } from "../../lib/tern/tsp.ts";
import {
	BTW_ABORT_EVENT,
	BTW_CLOSE_EVENT,
	BTW_STATE_EVENT,
	BTW_SUBMIT_EVENT,
	type BtwState,
} from "../../../extensions/swarm-btw/src/events.ts";

// A bus with synchronous delivery, so a publish reaches the card in the same tick it was emitted.
function fakeBus() {
	const handlers = new Map<string, Array<(data: unknown) => void>>();
	const emitted: Array<{ channel: string; data: unknown }> = [];
	const bus: BtwEventBus = {
		emit: (channel, data) => {
			emitted.push({ channel, data });
			for (const fn of handlers.get(channel) ?? []) fn(data);
		},
		on: (channel, fn) => {
			handlers.set(channel, [...(handlers.get(channel) ?? []), fn]);
			return () => handlers.set(channel, (handlers.get(channel) ?? []).filter((h) => h !== fn));
		},
	};
	return { bus, emitted };
}

const open = (state: Partial<BtwState> = {}): BtwState => ({ open: true, entries: [], ...state });

describe("TernBtwCard", () => {
	it("contributes nothing to the dock while no side question is open", () => {
		const { bus } = fakeBus();
		const card = new TernBtwCard(bus, () => {});
		expect(card.active).toBe(false);
		expect(card.nodes()).toEqual([]);
	});

	it("renders the open flow as an inline card, never an overlay", () => {
		const { bus } = fakeBus();
		const card = new TernBtwCard(bus, () => {});
		bus.emit(BTW_STATE_EVENT, open({ active: { question: "why?", answer: "because" } }));
		const [node] = card.nodes();
		expect(node?.id).toBe(BTW_CARD_ID);
		expect(node?.k).toBe("card");
		expect(node?.p?.role).toBe("pi.btw");
		expect(JSON.stringify(node)).toContain("You: why?");
		expect(JSON.stringify(node)).toContain("because");
	});

	it("sends only an explicitly typed question, and refuses Enter while an answer streams", () => {
		const { bus, emitted } = fakeBus();
		const card = new TernBtwCard(bus, () => {});
		bus.emit(BTW_STATE_EVENT, open());
		card.request();
		expect(emitted.some((e) => e.channel === BTW_SUBMIT_EVENT)).toBe(false);
		card.input("what changed?");
		expect(card.nodes()[0] && JSON.stringify(card.nodes())).toContain("what changed?");
		card.request();
		expect(emitted.find((e) => e.channel === BTW_SUBMIT_EVENT)?.data).toEqual({ question: "what changed?" });

		bus.emit(BTW_STATE_EVENT, open({ active: { question: "still running", answer: "" } }));
		card.input("ignored");
		card.request();
		expect(emitted.filter((e) => e.channel === BTW_SUBMIT_EVENT)).toHaveLength(1);
	});

	it("maps Escape to abort while running and to close when idle", () => {
		const { bus, emitted } = fakeBus();
		const card = new TernBtwCard(bus, () => {});
		bus.emit(BTW_STATE_EVENT, open());
		card.escape();
		expect(emitted.at(-1)?.channel).toBe(BTW_CLOSE_EVENT);
		bus.emit(BTW_STATE_EVENT, open({ active: { question: "q", answer: "" } }));
		card.escape();
		expect(emitted.at(-1)?.channel).toBe(BTW_ABORT_EVENT);
	});

	it("ignores malformed snapshots instead of drawing an invented flow", () => {
		const { bus } = fakeBus();
		const card = new TernBtwCard(bus, () => {});
		bus.emit(BTW_STATE_EVENT, { open: "yes" });
		bus.emit(BTW_STATE_EVENT, null);
		expect(card.active).toBe(false);
		expect(card.nodes()).toEqual([]);
	});
});

// --- bridge integration: the composer slot is what the user sees --------------------------------

function fakeSession() {
	const state = { sessionId: "s1", entries: [] as unknown[], model: undefined };
	const session = {
		subscribe: () => () => {},
		prompt: () => new Promise<void>(() => {}),
		abort: async () => {},
		dispose() {},
		get model() {
			return state.model;
		},
		sessionManager: { getSessionId: () => state.sessionId, getEntries: () => state.entries },
		getContextUsage: () => undefined,
	};
	return session as unknown as PiSessionLike;
}

function replay(writes: string[]): Map<string, { parent: string; p?: Record<string, unknown> }> {
	const nodes = new Map<string, { parent: string; p?: Record<string, unknown>; c?: unknown[] }>();
	const add = (node: { id: string; p?: Record<string, unknown>; c?: Array<{ id: string }> }, parent: string) => {
		nodes.set(node.id, { parent, p: node.p });
		for (const child of node.c ?? []) add(child as { id: string }, node.id);
	};
	for (const write of writes) {
		if (!write.startsWith(`${ESC}_tsp;f;`)) continue;
		const body = parseTspMessages(write)[0]?.body as { ops: unknown[][] };
		for (const op of body.ops) {
			if (op[0] === "add") add(op[4] as { id: string }, String(op[2]));
			else if (op[0] === "del") nodes.delete(String(op[1]));
			else if (op[0] === "set") {
				const node = nodes.get(String(op[1]));
				if (node) node.p = { ...node.p, ...(op[2] as Record<string, unknown>) };
			} else if (op[0] === "text") {
				const node = nodes.get(String(op[1]));
				if (node) node.p = { ...node.p, text: `${String(node.p?.text ?? "")}${String(op[3])}` };
			}
		}
	}
	return nodes;
}

const dockChildren = (writes: string[]) =>
	[...replay(writes).entries()].filter(([, node]) => node.parent === "dock").map(([id]) => id);

function makeBridge() {
	const writes: string[] = [];
	const { bus, emitted } = fakeBus();
	const bridge = new PiTernBridge(fakeSession(), { write: (data) => writes.push(data), surfaceId: "pi", credits: 1000, events: bus });
	bridge.start("pi");
	// The extension publishes on the bus the bridge listens to; this is the same call path as a live /btw.
	const publish = (state: BtwState) => bus.emit(BTW_STATE_EVENT, state);
	return { bridge, writes, emitted, publish };
}

describe("/btw in the Tern dock", () => {
	it("replaces the composer with the card, and restores it when the flow closes", () => {
		const { writes, publish } = makeBridge();
		expect(dockChildren(writes)).toEqual(["composer-col"]);

		publish(open({ active: { question: "why?", answer: "" } }));
		expect(dockChildren(writes)).toEqual(["btw-card"]);
		expect(dockChildren(writes)).not.toContain("composer-col");

		publish(open({ active: { question: "why?", answer: "because" } }));
		expect(JSON.stringify(replay(writes).get(BTW_INPUT_ID)?.p)).toContain("Ask a side question");

		publish({ open: false, entries: [] });
		expect(dockChildren(writes)).toEqual(["composer-col"]);
	});

	it("routes typing, Enter and Escape to the card instead of the composer", async () => {
		const { bridge, writes, emitted, publish } = makeBridge();
		publish(open());
		bridge.appendDraft("hi");
		expect(JSON.stringify(replay(writes).get(BTW_INPUT_ID)?.p)).toContain("hi");
		await bridge.submitDraft();
		const submit = emitted.filter((e) => e.channel === BTW_SUBMIT_EVENT).at(-1);
		expect(submit?.data).toEqual({ question: "hi" });
		bridge.escape();
		expect(emitted.at(-1)?.channel).toBe(BTW_CLOSE_EVENT);
	});
});
