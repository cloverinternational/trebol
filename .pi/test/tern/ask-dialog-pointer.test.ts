import { describe, expect, it } from "vitest";
import {
	ASK_BACK_ID,
	ASK_CANCEL_ID,
	ASK_EDITOR_CLOSE_ID,
	ASK_EDITOR_SAVE_ID,
	ASK_NEXT_ID,
	ASK_OPTIONS_ID,
	ASK_SUBMIT_ID,
	ASK_SUBMIT_TAB_ID,
	NARROW_COLUMNS,
	TernAskDialog,
	type AskEventBus,
} from "../../lib/tern/ask-dialog.ts";
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

function setupWith(questions: unknown[]) {
	const events = bus();
	const dialog = new TernAskDialog(events, () => {});
	dialog.start();
	events.emit(PI_ASK_STARTED_EVENT, { version: 1, flowId: "tool:ptr2", toolCallId: "2", source: "tool", title: "Plan", questions, createdAt: 0 });
	return { events, dialog };
}

// A row's own click action is its id, so `handleAction` and `handleSelect` take the same string.
const option = (qi: number, oi: number) => `ask-opt:${qi}:${oi}`;

// The option rows as rendered, so the assertions read the real click action Tern is told about.
function rows(dialog: TernAskDialog, columns?: number) {
	const [card] = dialog.nodes(columns);
	const find = (node: any): any => {
		if (node?.id === ASK_OPTIONS_ID) return node;
		for (const child of node?.c ?? []) {
			const hit = find(child);
			if (hit) return hit;
		}
		return undefined;
	};
	return (find(card)?.c ?? []) as Array<{ id: string; p: Record<string, any> }>;
}

function rendered(dialog: TernAskDialog, columns?: number): string {
	return JSON.stringify(dialog.nodes(columns));
}

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

	it("every option row emits a click action carrying its own id", () => {
		const { dialog } = setup();
		expect(rows(dialog).map((row) => [row.id, row.p?.actions])).toEqual([
			[option(0, 0), { click: option(0, 0) }],
			[option(0, 1), { click: option(0, 1) }],
			// The trailing "Type something" row is tappable too: it opens the editor.
			[option(0, 2), { click: option(0, 2) }],
		]);
	});

	it("a single tap on a single-choice row selects it and advances like a digit", () => {
		const { events, dialog } = setup();
		// A plain list `select` (what Tern sends without a row action) advances a single-choice row.
		expect(dialog.handleSelect(option(0, 1), false)).toBe(true);
		expect(rendered(dialog)).toContain("Which tags?");
		dialog.moveTab(-1);
		expect(rendered(dialog)).toContain("(•) Large");
		// So does the row's own click action, which is what a phone tap runs.
		expect(dialog.handleAction(option(0, 0))).toBe(true);
		expect(rendered(dialog)).toContain("Which tags?");
		dialog.moveTab(-1);
		expect(rendered(dialog)).toContain("(•) Small");
		expect(events.sent.some((e) => e.channel === PI_ASK_SUBMIT_EVENT)).toBe(false);
	});

	it("a tap on the last question advances to the review tab", () => {
		const { dialog } = setupWith([
			QUESTIONS[0],
			{ id: "size", label: "Size", prompt: "Which size?", type: "single", required: false, options: [{ value: "s", label: "S", freeform: false }, { value: "m", label: "M", freeform: false }] },
		]);
		dialog.handleAction("ask-tab-1");
		expect(dialog.handleAction(option(1, 1))).toBe(true);
		expect(rendered(dialog)).toContain("Size: M");
	});

	it("tap on a multi-choice option toggles it on, then off", () => {
		const { dialog } = setup();
		dialog.handleSelect(option(0, 0), true);
		expect(dialog.handleSelect(option(1, 0), false)).toBe(true);
		expect(rendered(dialog)).toContain("[x] A");
		// A multi-choice tap never advances; it only toggles.
		expect(rendered(dialog)).toContain("Which tags?");
		expect(dialog.handleAction(option(1, 0))).toBe(true);
		expect(rendered(dialog)).toContain("[ ] A");
		expect(dialog.handleAction(option(1, 1))).toBe(true);
		expect(rendered(dialog)).toContain("[x] B");
		expect(rendered(dialog)).toContain("Which tags?");
	});

	it("narrow layout keeps the options tappable behind the progress line (<60 columns)", () => {
		const { dialog } = setup();
		const narrow = dialog.nodes(NARROW_COLUMNS - 1);
		const text = JSON.stringify(narrow);
		expect(text).toContain("ask-progress");
		expect(text).not.toContain("ask-tab-0");
		// No dead keyboard hints: the narrow layout offers real Back/Next/Cancel controls.
		expect(text).not.toContain("ask-hint-enter");
		expect(text).not.toContain("ask-hint-esc");
		expect(text).toContain(ASK_NEXT_ID);
		expect(text).toContain(ASK_CANCEL_ID);
		expect(rows(dialog, NARROW_COLUMNS - 1).map((row) => row.p?.actions)).toEqual([
			{ click: option(0, 0) },
			{ click: option(0, 1) },
			{ click: option(0, 2) },
		]);
		expect(rendered(dialog, NARROW_COLUMNS - 1)).toContain("Question 1 of 2");
		expect(dialog.handleAction(option(0, 1))).toBe(true);
		// The tap advanced to the second question, still behind the progress line, and
		// that question's rows are tappable too.
		expect(rendered(dialog, NARROW_COLUMNS - 1)).toContain("Question 2 of 2 · Tags");
		expect(rows(dialog, NARROW_COLUMNS - 1)[1]?.p?.actions).toEqual({ click: option(1, 1) });
		expect(dialog.handleAction(option(1, 1))).toBe(true);
		expect(rendered(dialog, NARROW_COLUMNS - 1)).toContain("[x] B");
		// The wide layout is unaffected: the tab strip is back.
		expect(rendered(dialog, NARROW_COLUMNS)).toContain("ask-tab-0");
	});

	it("narrow Next reaches Review without answering, and Review still submits explicitly", () => {
		const { events, dialog } = setup();
		// A multi-choice question has no row that advances by itself. Next is the only way forward
		// on a phone, so it must exist and only move the cursor.
		expect(dialog.handleAction(ASK_NEXT_ID)).toBe(true);
		expect(rendered(dialog, NARROW_COLUMNS - 1)).toContain("Which tags?");
		expect(dialog.handleAction(ASK_NEXT_ID)).toBe(true);
		expect(rendered(dialog, NARROW_COLUMNS - 1)).toContain("Scope: (unanswered)");
		expect(rendered(dialog, NARROW_COLUMNS - 1)).toContain("Submit");
		expect(events.sent.some((e) => e.channel === PI_ASK_SUBMIT_EVENT)).toBe(false);
		// Back moves one step without losing the unanswered state.
		expect(dialog.handleAction(ASK_BACK_ID)).toBe(true);
		expect(rendered(dialog, NARROW_COLUMNS - 1)).toContain("Which tags?");
		expect(dialog.handleAction(ASK_NEXT_ID)).toBe(true);
		// Required answers still block an explicit Submit.
		expect(dialog.handleAction(ASK_SUBMIT_ID)).toBe(true);
		expect(rendered(dialog, NARROW_COLUMNS - 1)).toContain("Answer required: Scope");
	});

	it("narrow freeform editor has tappable Save and Close targets", () => {
		const { events, dialog } = setupWith([
			{
				id: "reason",
				label: "Reason",
				prompt: "Why?",
				type: "single",
				required: true,
				options: [{ value: "freeform", label: "Type answer", freeform: true }],
			},
		]);
		expect(dialog.handleAction(option(0, 0))).toBe(true);
		expect(rendered(dialog, NARROW_COLUMNS - 1)).toContain("Save answer");
		expect(rendered(dialog, NARROW_COLUMNS - 1)).toContain("Close editor");
		dialog.input("because");
		expect(dialog.handleAction(ASK_EDITOR_SAVE_ID)).toBe(true);
		expect(rendered(dialog, NARROW_COLUMNS - 1)).toContain("Reason: because");
		expect(events.sent.some((e) => e.channel === PI_ASK_SUBMIT_EVENT)).toBe(false);
		// Reopen, type, and close: the draft survives and nothing is submitted.
		expect(dialog.handleAction(ASK_BACK_ID)).toBe(true);
		expect(dialog.handleAction(option(0, 0))).toBe(true);
		dialog.input(" more");
		expect(dialog.handleAction(ASK_EDITOR_CLOSE_ID)).toBe(true);
		expect(rendered(dialog, NARROW_COLUMNS - 1)).toContain("because more");
		expect(events.sent.some((e) => e.channel === PI_ASK_SUBMIT_EVENT)).toBe(false);
	});

	it("double tap (activate) on a single-choice option confirms it and advances", () => {
		const { dialog } = setup();
		expect(dialog.handleSelect(option(0, 0), true)).toBe(true);
		expect(rendered(dialog)).toContain("Which tags?");
		// Activate confirms the row it lands on rather than clearing an earlier answer.
		expect(dialog.handleSelect(option(0, 1), true)).toBe(true);
		dialog.moveTab(-1);
		expect(rendered(dialog)).toContain("(•) Large");
	});

	it("tap routes reject unknown ids and out-of-range indexes without changing state", () => {
		const { dialog } = setup();
		expect(dialog.handleSelect("row-other", false)).toBe(false);
		expect(dialog.handleSelect(option(0, 7), false)).toBe(false);
		expect(dialog.handleSelect("ask-opt:x:y", false)).toBe(false);
		expect(dialog.handleSelect("ask-opt:9:0", false)).toBe(false);
		expect(dialog.handleAction("ask-opt:0:9")).toBe(true);
		expect(dialog.handleAction("ask-opt::-1")).toBe(true);
		expect(rendered(dialog)).toContain("Which scope?");
		expect(rendered(dialog)).not.toContain("(•)");
	});

	it("a tap on the freeform row opens the editor instead of advancing", () => {
		const { dialog } = setup();
		expect(dialog.handleAction(option(0, 2))).toBe(true);
		expect(rendered(dialog)).toContain("\"text\":\"Editing: ▏\"");
		expect(rendered(dialog)).toContain("Which scope?");
	});

	it("keyboard still works after taps: digit selects, Enter confirms and advances", () => {
		const { dialog } = setup();
		// The tap answers Scope and lands on Tags.
		dialog.handleSelect(option(0, 1), false);
		// A digit on the multi-choice question toggles and stays put, as before the pointer change.
		expect(dialog.selectNumber(1)).toBe(true);
		expect(rendered(dialog)).toContain("Which tags?");
		expect(rendered(dialog)).toContain("[x] A");
		// Space still toggles the row without advancing.
		expect(dialog.toggleCurrent()).toBe(true);
		expect(rendered(dialog)).toContain("[ ] A");
		// A digit on a single-choice question answers and advances, as before.
		dialog.moveTab(-1);
		expect(dialog.selectNumber(1)).toBe(true);
		expect(rendered(dialog)).toContain("Which tags?");
		dialog.moveTab(-1);
		expect(rendered(dialog)).toContain("(•) Small");
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
