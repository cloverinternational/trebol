import { describe, expect, it } from "vitest";
import { TernAskDialog, type AskEventBus, ASK_SUBMIT_ID, ASK_CANCEL_ID } from "../../lib/tern/ask-dialog.ts";
import { createRemoteAskRuntime, PI_ASK_STARTED_EVENT, PI_ASK_SUBMIT_EVENT, PI_ASK_SUBMIT_RESULT_EVENT, PI_ASK_COMPLETED_EVENT } from "../../../extensions/ask-user/src/remote-ask.ts";

function bus(): AskEventBus & { sent: Array<{ channel: string; data: any }> } {
	const handlers = new Map<string, Array<(d: unknown) => void>>();
	const sent: Array<{ channel: string; data: any }> = [];
	return {
		sent,
		emit(channel, data) {
			sent.push({ channel, data });
			for (const h of handlers.get(channel) ?? []) h(data);
		},
		on(channel, handler) {
			handlers.set(channel, [...(handlers.get(channel) ?? []), handler]);
			return () => handlers.set(channel, (handlers.get(channel) ?? []).filter((h) => h !== handler));
		},
	};
}

const QUESTIONS = [
	{
		id: "scope",
		label: "Scope",
		prompt: "Which scope?",
		type: "single",
		required: true,
		options: [
			{ value: "small", label: "Small", freeform: false },
			{ value: "large", label: "Large", freeform: false },
		],
	},
	{
		id: "tags",
		label: "Tags",
		prompt: "Which tags?",
		type: "multi",
		required: false,
		options: [
			{ value: "a", label: "A", freeform: false },
			{ value: "b", label: "B", freeform: false },
		],
	},
];

function started(flowId = "tool:1", questions = QUESTIONS) {
	return { version: 1, flowId, toolCallId: "1", source: "tool", title: "Plan", questions, createdAt: 0 };
}

function setup() {
	const events = bus();
	let changes = 0;
	const dialog = new TernAskDialog(events, () => changes++);
	dialog.start();
	return { events, dialog, changes: () => changes };
}

describe("TernAskDialog", () => {
	it("stays inactive until a flow starts and renders nothing", () => {
		const { dialog } = setup();
		expect(dialog.active).toBe(false);
		expect(dialog.nodes()).toEqual([]);
	});

	it("shows a started flow as an inline card without selecting anything", () => {
		const { events, dialog } = setup();
		events.emit(PI_ASK_STARTED_EVENT, started());
		expect(dialog.active).toBe(true);
		const [card] = dialog.nodes();
		expect(card).toMatchObject({ id: "ask-dialog", k: "card", p: { head: "Plan" } });
		const options = JSON.stringify(card);
		expect(options).toContain("( ) Small");
		expect(options).not.toContain("(•)");
	});

	it("does not submit without explicit selection for a required question", () => {
		const { events, dialog, changes } = setup();
		events.emit(PI_ASK_STARTED_EVENT, started());
		expect(dialog.submit()).toBe(false);
		expect(events.sent.filter((e) => e.channel === PI_ASK_SUBMIT_EVENT)).toHaveLength(0);
		expect(JSON.stringify(dialog.nodes())).toContain("Answer required: Scope");
		expect(changes()).toBeGreaterThan(0);
	});

	it("supports numeric keyboard choice without submitting by itself", () => {
		const { events, dialog } = setup();
		events.emit(PI_ASK_STARTED_EVENT, started());
		expect(dialog.selectNumber(2)).toBe(true);
		// A single-choice digit picks the option and advances to the next tab, like the native flow.
		expect(JSON.stringify(dialog.nodes())).toContain("✓ Scope");
		expect(JSON.stringify(dialog.nodes())).toContain("Which tags? (optional)");
		expect(events.sent.filter(e => e.channel === PI_ASK_SUBMIT_EVENT)).toHaveLength(0);
		expect(dialog.selectNumber(9)).toBe(false);
	});

	it("Enter confirms the cursor option and advances; Space toggles without advancing", () => {
		const { events, dialog } = setup();
		events.emit(PI_ASK_STARTED_EVENT, started());
		dialog.moveOption(1);
		dialog.toggleCurrent();
		expect(JSON.stringify(dialog.nodes())).toContain("(•) Large");
		expect(JSON.stringify(dialog.nodes())).toContain("Scope");
		dialog.confirmCurrent();
		expect(JSON.stringify(dialog.nodes())).toContain("Which tags? (optional)");
		expect(events.sent.filter((e) => e.channel === PI_ASK_SUBMIT_EVENT)).toHaveLength(0);
	});

	it("left/right move between question tabs and the Submit review tab", () => {
		const { events, dialog } = setup();
		events.emit(PI_ASK_STARTED_EVENT, started());
		dialog.moveTab(1);
		expect(JSON.stringify(dialog.nodes())).toContain("Which tags?");
		dialog.moveTab(1);
		expect(JSON.stringify(dialog.nodes())).toContain("Scope: (unanswered)");
		expect(JSON.stringify(dialog.nodes())).toContain("1. Submit");
		dialog.moveTab(5);
		expect(JSON.stringify(dialog.nodes())).toContain("2. Cancel");
		dialog.moveTab(-9);
		expect(JSON.stringify(dialog.nodes())).toContain("Which scope?");
	});

	it("Submit on the review tab jumps to the first unanswered required question", () => {
		const { events, dialog } = setup();
		events.emit(PI_ASK_STARTED_EVENT, started());
		dialog.moveTab(1);
		dialog.moveTab(1);
		expect(dialog.confirmCurrent()).toBe(false);
		expect(JSON.stringify(dialog.nodes())).toContain("Answer required: Scope");
		expect(JSON.stringify(dialog.nodes())).toContain("Which scope?");
		expect(events.sent.filter((e) => e.channel === PI_ASK_SUBMIT_EVENT)).toHaveLength(0);
	});

	it("review tab Cancel action sends a cancel response", () => {
		const { events, dialog } = setup();
		events.emit(PI_ASK_STARTED_EVENT, started());
		dialog.selectNumber(1);
		dialog.selectNumber(2);
		dialog.moveTab(1);
		dialog.moveTab(1);
		expect(JSON.stringify(dialog.nodes())).toContain("Scope: Small");
		dialog.moveOption(1);
		expect(dialog.confirmCurrent()).toBe(true);
		expect(events.sent.find((e) => e.channel === PI_ASK_SUBMIT_EVENT)?.data.response).toEqual({ kind: "cancel" });
	});

	it("review tab Submit action sends the collected answers", () => {
		const { events, dialog } = setup();
		events.emit(PI_ASK_STARTED_EVENT, started());
		dialog.selectNumber(1);
		dialog.selectNumber(2);
		dialog.moveTab(2);
		expect(dialog.confirmCurrent()).toBe(true);
		expect(events.sent.find((e) => e.channel === PI_ASK_SUBMIT_EVENT)?.data.response).toEqual({
			kind: "answer",
			answers: { scope: { values: ["small"] }, tags: { values: ["b"] } },
			mode: "submit",
		});
	});

	it("submits only the explicit clicks the user made", () => {
		const { events, dialog } = setup();
		events.emit(PI_ASK_STARTED_EVENT, started());
		expect(dialog.handleAction("ask-opt:0:1")).toBe(true);
		expect(dialog.handleAction("ask-opt:1:0")).toBe(true);
		expect(dialog.handleAction(ASK_SUBMIT_ID)).toBe(true);
		const submit = events.sent.find((e) => e.channel === PI_ASK_SUBMIT_EVENT);
		expect(submit?.data.response).toEqual({ kind: "answer", answers: { scope: { values: ["large"] }, tags: { values: ["a"] } }, mode: "submit" });
		expect(submit?.data.flowId).toBe("tool:1");
	});

	it("single choice replaces the previous selection; multi toggles", () => {
		const { events, dialog } = setup();
		events.emit(PI_ASK_STARTED_EVENT, started());
		dialog.toggle(0, 0);
		dialog.toggle(0, 1);
		dialog.toggle(1, 0);
		dialog.toggle(1, 0);
		dialog.toggle(1, 1);
		dialog.submit();
		const response = events.sent.find((e) => e.channel === PI_ASK_SUBMIT_EVENT)?.data.response;
		expect(response.answers).toEqual({ scope: { values: ["large"] }, tags: { values: ["b"] } });
	});

	it("cancel emits only a cancel response for the head flow", () => {
		const { events, dialog } = setup();
		events.emit(PI_ASK_STARTED_EVENT, started());
		expect(dialog.cancel()).toBe(true);
		expect(dialog.handleAction(ASK_CANCEL_ID)).toBe(true);
		const sent = events.sent.filter((e) => e.channel === PI_ASK_SUBMIT_EVENT);
		expect(sent).toHaveLength(1);
		expect(sent[0].data.response).toEqual({ kind: "cancel" });
	});

	it("ignores actions on non-ask nodes and malformed started events", () => {
		const { events, dialog } = setup();
		expect(dialog.handleAction("composer")).toBe(false);
		events.emit(PI_ASK_STARTED_EVENT, { version: 2, flowId: "x", questions: QUESTIONS });
		events.emit(PI_ASK_STARTED_EVENT, { version: 1, flowId: "y", questions: [{ id: "q" }] });
		expect(dialog.active).toBe(false);
	});

	it("does not re-emit on a repeated click while a submit is in flight", () => {
		const { events, dialog } = setup();
		events.emit(PI_ASK_STARTED_EVENT, started());
		dialog.toggle(0, 0);
		dialog.submit();
		dialog.submit();
		dialog.cancel();
		expect(events.sent.filter((e) => e.channel === PI_ASK_SUBMIT_EVENT)).toHaveLength(1);
	});

	it("removes the flow when the runtime completes it", () => {
		const { events, dialog } = setup();
		events.emit(PI_ASK_STARTED_EVENT, started());
		events.emit(PI_ASK_COMPLETED_EVENT, { version: 1, flowId: "tool:1", result: {}, completedAt: 0, source: "tool" });
		expect(dialog.active).toBe(false);
	});

	it("reopens for a retry when the runtime rejects the submit", () => {
		const { events, dialog } = setup();
		events.emit(PI_ASK_STARTED_EVENT, started());
		dialog.toggle(0, 0);
		dialog.submit();
		const requestId = events.sent.find((e) => e.channel === PI_ASK_SUBMIT_EVENT)!.data.requestId;
		events.emit(PI_ASK_SUBMIT_RESULT_EVENT, { version: 1, flowId: "tool:1", requestId, ok: false, error: "invalid_answer", message: "bad" });
		expect(dialog.active).toBe(true);
		expect(JSON.stringify(dialog.nodes())).toContain("bad");
		expect(dialog.submit()).toBe(true);
	});

	it("dispose cancels open flows so a closed pane never strands a tool call", () => {
		const { events, dialog } = setup();
		events.emit(PI_ASK_STARTED_EVENT, started());
		dialog.dispose();
		expect(events.sent.filter((e) => e.channel === PI_ASK_SUBMIT_EVENT).at(-1)?.data.response).toEqual({ kind: "cancel" });
	});

	it("round-trips through the real remote-ask runtime and resolves the tool flow", () => {
		const events = bus();
		const runtime = createRemoteAskRuntime(events);
		const dialog = new TernAskDialog(events, () => {});
		dialog.start();
		const handle = runtime.startFlow({
			source: "tool",
			toolCallId: "9",
			title: "Plan",
			questions: [{ id: "scope", label: "Scope", prompt: "Which?", type: "single", required: true, options: [{ value: "small", label: "Small", freeform: false }] }] as any,
			onSubmit: () => ({ ok: true }),
		});
		return new Promise<void>((resolve) => queueMicrotask(() => {
			expect(dialog.active).toBe(true);
			dialog.toggle(0, 0);
			dialog.submit();
			expect(events.sent.some((e) => e.channel === PI_ASK_SUBMIT_RESULT_EVENT && e.data.ok === true)).toBe(true);
			runtime.disposeAll();
			handle.dispose();
			resolve();
		}));
	});
	it("freeform option opens an editor; typed text saves on enter and advances", () => {
		const { events, dialog } = setup();
		events.emit(PI_ASK_STARTED_EVENT, started("tool:free", [
			{ id: "reason", label: "Reason", prompt: "Why?", type: "single", required: true, options: [{ value: "freeform", label: "Type answer", freeform: true }] },
			{ id: "scope", label: "Scope", prompt: "Which?", type: "single", required: true, options: [{ value: "s", label: "S", freeform: false }] },
		] as any));
		dialog.selectNumber(1);
		expect(JSON.stringify(dialog.nodes())).toContain("Type your answer: ▏");
		dialog.input("I");
		dialog.input(" ");
		dialog.input("want");
		dialog.backspace();
		dialog.input("t");
		expect(JSON.stringify(dialog.nodes())).toContain("Type your answer: I want▏");
		expect(dialog.confirmCurrent()).toBe(true);
		expect(JSON.stringify(dialog.nodes())).toContain("Which?");
		dialog.selectNumber(1);
		dialog.moveTab(1);
		dialog.moveTab(1);
		expect(JSON.stringify(dialog.nodes())).toContain("Reason: I want");
		dialog.confirmCurrent();
		expect(events.sent.find((e) => e.channel === PI_ASK_SUBMIT_EVENT)?.data.response).toEqual({
			kind: "answer",
			answers: { reason: { customText: "I want" }, scope: { values: ["s"] } },
			mode: "submit",
		});
	});

	it("esc closes the freeform editor and keeps the draft; empty save is rejected", () => {
		const { events, dialog } = setup();
		events.emit(PI_ASK_STARTED_EVENT, started("tool:esc", [
			{ id: "reason", label: "Reason", prompt: "Why?", type: "single", required: true, options: [{ value: "freeform", label: "Type answer", freeform: true }] },
		] as any));
		dialog.selectNumber(1);
		expect(dialog.confirmCurrent()).toBe(false);
		expect(JSON.stringify(dialog.nodes())).toContain("Type an answer, or press esc to close.");
		dialog.input("draft");
		expect(dialog.cancel()).toBe(true);
		expect(events.sent.filter((e) => e.channel === PI_ASK_SUBMIT_EVENT)).toHaveLength(0);
		expect(JSON.stringify(dialog.nodes())).toContain("Type your answer: draft");
		dialog.selectNumber(1);
		dialog.input(" ");
		expect(JSON.stringify(dialog.nodes())).toContain("Type your answer: draft ▏");
	});

	it("required freeform answer counts as answered on the review tab", () => {
		const { events, dialog } = setup();
		events.emit(PI_ASK_STARTED_EVENT, started("tool:req", [
			{ id: "reason", label: "Reason", prompt: "Why?", type: "single", required: true, options: [{ value: "freeform", label: "Type answer", freeform: true }] },
		] as any));
		dialog.moveTab(1);
		expect(dialog.confirmCurrent()).toBe(false);
		expect(JSON.stringify(dialog.nodes())).toContain("Answer required: Reason");
		dialog.selectNumber(1);
		dialog.input("ok");
		dialog.confirmCurrent();
		expect(JSON.stringify(dialog.nodes())).toContain("Reason: ok");
		expect(events.sent.filter((e) => e.channel === PI_ASK_SUBMIT_EVENT)).toHaveLength(0);
	});

	it("choice questions get a trailing Type something row; single saves replace the choice", () => {
		const { events, dialog } = setup();
		events.emit(PI_ASK_STARTED_EVENT, started("tool:custom"));
		expect(dialog.selectNumber(3)).toBe(true);
		expect(JSON.stringify(dialog.nodes())).toContain("Type something: ▏");
		dialog.input("mine");
		dialog.confirmCurrent();
		// Scope now holds only the typed text; the choice it replaced is gone.
		expect(JSON.stringify(dialog.nodes())).toContain("Tags");
		dialog.selectNumber(1);
		dialog.moveTab(1);
		expect(JSON.stringify(dialog.nodes())).toContain("Scope: mine");
		expect(JSON.stringify(dialog.nodes())).toContain("Tags: A");
		dialog.confirmCurrent();
		expect(events.sent.find((e) => e.channel === PI_ASK_SUBMIT_EVENT)?.data.response).toEqual({
			kind: "answer",
			answers: { scope: { customText: "mine" }, tags: { values: ["a"] } },
			mode: "submit",
		});
	});
});
