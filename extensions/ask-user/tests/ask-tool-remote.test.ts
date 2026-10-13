import assert from "node:assert/strict";
import test from "node:test";
import { runRemoteAskFlow } from "../src/ask-tool.ts";
import {
	createRemoteAskRuntime,
	PI_ASK_COMPLETED_EVENT,
	PI_ASK_STARTED_EVENT,
	PI_ASK_SUBMIT_EVENT,
	PI_ASK_SUBMIT_RESULT_EVENT,
} from "../src/remote-ask.ts";
import { createInitialState } from "../src/state/create.ts";

class Bus {
	readonly events: Array<{ channel: string; data: any }> = [];
	private readonly handlers = new Map<string, Array<(d: unknown) => void>>();
	emit(channel: string, data: unknown) {
		this.events.push({ channel, data });
		for (const h of this.handlers.get(channel) ?? []) h(data);
	}
	on(channel: string, handler: (d: unknown) => void) {
		this.handlers.set(channel, [...(this.handlers.get(channel) ?? []), handler]);
		return () => this.handlers.set(channel, (this.handlers.get(channel) ?? []).filter((h) => h !== handler));
	}
	last(channel: string) {
		return this.events.filter((e) => e.channel === channel).at(-1)?.data;
	}
}

function fixture() {
	const bus = new Bus();
	const runtime = createRemoteAskRuntime(bus);
	const state = createInitialState({
		title: "Plan",
		questions: [{ id: "scope", label: "Scope", prompt: "Which?", type: "single", options: [{ value: "small", label: "Small" }, { value: "large", label: "Large" }] }],
	} as any);
	return { bus, runtime, state };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

test("remote flow resolves only after an explicit answer submit", async () => {
	const { bus, runtime, state } = fixture();
	const pending = runRemoteAskFlow(runtime, state, "t1", undefined, 60_000);
	await tick();
	const started = bus.last(PI_ASK_STARTED_EVENT);
	assert.equal(started.flowId, "tool:t1");
	let settled = false;
	pending.then(() => { settled = true; });
	await tick();
	assert.equal(settled, false, "must not resolve without user action");
	bus.emit(PI_ASK_SUBMIT_EVENT, {
		version: 1,
		flowId: started.flowId,
		requestId: "r1",
		response: { kind: "answer", answers: { scope: { values: ["large"] } }, mode: "submit" },
	});
	const result = await pending;
	assert.notEqual(result.cancelled, true);
	assert.equal(bus.last(PI_ASK_SUBMIT_RESULT_EVENT).ok, true);
	assert.equal(bus.last(PI_ASK_COMPLETED_EVENT).flowId, "tool:t1");
});

test("explicit cancel resolves as cancelled", async () => {
	const { bus, runtime, state } = fixture();
	const pending = runRemoteAskFlow(runtime, state, "t2", undefined, 60_000);
	await tick();
	bus.emit(PI_ASK_SUBMIT_EVENT, { version: 1, flowId: "tool:t2", requestId: "r2", response: { kind: "cancel" } });
	const result = await pending;
	assert.equal(result.cancelled, true);
});

test("abort signal cancels without any user answer", async () => {
	const { bus, runtime, state } = fixture();
	const controller = new AbortController();
	const pending = runRemoteAskFlow(runtime, state, "t3", controller.signal, 60_000);
	await tick();
	controller.abort();
	const result = await pending;
	assert.equal(result.cancelled, true);
	assert.equal(bus.last(PI_ASK_COMPLETED_EVENT).flowId, "tool:t3");
});

test("already-aborted signal resolves cancelled without starting a flow", async () => {
	const { bus, runtime, state } = fixture();
	const controller = new AbortController();
	controller.abort();
	const result = await runRemoteAskFlow(runtime, state, "t4", controller.signal, 60_000);
	assert.equal(result.cancelled, true);
	assert.equal(bus.events.filter((e) => e.channel === PI_ASK_STARTED_EVENT).length, 0);
});

test("timeout cancels the flow and clears the active runtime entry", async () => {
	const { bus, runtime, state } = fixture();
	const result = await runRemoteAskFlow(runtime, state, "t5", undefined, 5);
	assert.equal(result.cancelled, true);
	assert.equal(bus.last(PI_ASK_COMPLETED_EVENT).flowId, "tool:t5");
	bus.emit(PI_ASK_SUBMIT_EVENT, { version: 1, flowId: "tool:t5", requestId: "late", response: { kind: "cancel" } });
	assert.equal(bus.last(PI_ASK_SUBMIT_RESULT_EVENT).error, "flow_not_found");
});

test("invalid submit is rejected and the flow stays open for a valid answer", async () => {
	const { bus, runtime, state } = fixture();
	const pending = runRemoteAskFlow(runtime, state, "t6", undefined, 60_000);
	await tick();
	bus.emit(PI_ASK_SUBMIT_EVENT, { version: 1, flowId: "tool:t6", requestId: "bad", response: { kind: "answer", answers: { scope: { values: ["nope"] } } } });
	assert.equal(bus.last(PI_ASK_SUBMIT_RESULT_EVENT).ok, false);
	bus.emit(PI_ASK_SUBMIT_EVENT, { version: 1, flowId: "tool:t6", requestId: "good", response: { kind: "answer", answers: { scope: { values: ["small"] } } } });
	const result = await pending;
	assert.notEqual(result.cancelled, true);
	runtime.disposeAll();
});
