import { describe, expect, it } from "vitest";
import { ASK_SUBMIT_TAB_ID, TernAskDialog, type AskEventBus } from "../../lib/tern/ask-dialog.ts";
import { PI_ASK_STARTED_EVENT, PI_ASK_SUBMIT_EVENT } from "../../../extensions/ask-user/src/remote-ask.ts";

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

function setup() {
	const events = bus();
	const dialog = new TernAskDialog(events, () => {});
	dialog.start();
	events.emit(PI_ASK_STARTED_EVENT, { version: 1, flowId: "tool:ptr", toolCallId: "1", source: "tool", title: "Plan", questions: QUESTIONS, createdAt: 0 });
	return { events, dialog };
}

// Tern sends a list-item tap as `select` (double tap as `activate`), with the list id and item id.
const option = (qi: number, oi: number) => `ask-opt:${qi}:${oi}`;

describe("TernAskDialog pointer input", () => {
	it("tap on a question tab moves to that question and to the Submit tab", () => {
		const { dialog } = setup();
		expect(dialog.handleAction("ask-tab-1")).toBe(true);
		expect(JSON.stringify(dialog.nodes())).toContain("Which tags?");
		expect(dialog.handleAction(ASK_SUBMIT_TAB_ID)).toBe(true);
		expect(JSON.stringify(dialog.nodes())).toContain("Submit");
	});

	it("tab tap ignores out-of-range indexes", () => {
		const { dialog } = setup();
		expect(dialog.handleAction("ask-tab-9")).toBe(true);
		expect(JSON.stringify(dialog.nodes())).toContain("Which scope?");
	});

	it("tap on a single-choice option selects it without advancing", () => {
		const { events, dialog } = setup();
		expect(dialog.handleSelect(option(0, 1), false)).toBe(true);
		expect(JSON.stringify(dialog.nodes())).toContain("Which scope?");
		expect(JSON.stringify(dialog.nodes())).toContain("(•) Large");
		expect(events.sent.some((e) => e.channel === PI_ASK_SUBMIT_EVENT)).toBe(false);
	});

	it("tap on a multi-choice option toggles it on, then off", () => {
		const { dialog } = setup();
		dialog.handleSelect(option(0, 0), true);
		dialog.handleSelect(option(1, 0), false);
		expect(JSON.stringify(dialog.nodes())).toContain("[x] A");
		dialog.handleSelect(option(1, 0), false);
		expect(JSON.stringify(dialog.nodes())).toContain("[ ] A");
	});

	it("double tap (activate) on a single-choice option confirms it and advances", () => {
		const { dialog } = setup();
		expect(dialog.handleSelect(option(0, 0), true)).toBe(true);
		expect(JSON.stringify(dialog.nodes())).toContain("Which tags?");
	});

	it("tap routes ignore unknown items and out-of-range option indexes", () => {
		const { dialog } = setup();
		expect(dialog.handleSelect("row-other", false)).toBe(false);
		expect(dialog.handleSelect(option(0, 7), false)).toBe(false);
		expect(dialog.handleSelect("ask-opt:x:y", false)).toBe(false);
	});

	it("keyboard still works after taps: digit selects, Enter confirms and advances", () => {
		const { dialog } = setup();
		dialog.handleSelect(option(0, 1), false);
		expect(dialog.selectNumber(1)).toBe(true);
		// A digit on a single-choice question answers and advances, as before the pointer change.
		expect(JSON.stringify(dialog.nodes())).toContain("Which tags?");
		dialog.moveTab(-1);
		expect(JSON.stringify(dialog.nodes())).toContain("(•) Small");
	});

	it("tap-selected answers submit through the same event as keyboard answers", () => {
		const { events, dialog } = setup();
		dialog.handleSelect(option(0, 1), true);
		dialog.handleAction(ASK_SUBMIT_TAB_ID);
		dialog.submit();
		expect(events.sent.find((e) => e.channel === PI_ASK_SUBMIT_EVENT)?.data.response).toEqual({
			kind: "answer",
			answers: { scope: { values: ["large"] } },
			mode: "submit",
		});
	});
});
