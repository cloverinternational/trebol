#!/usr/bin/env -S node --experimental-strip-types
// Deterministic native rendering for the phone-width composer and ask dialog. No Pi turn or model
// is started: the same TernInlineSurface and node builders the runner uses feed a real Tern window.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { TernAskDialog } from "../../.pi/lib/tern/ask-dialog.ts";
import { composerNodes } from "../../.pi/lib/tern/composer-view.ts";
import { PI_COMPOSER_CSS } from "../../.pi/lib/tern/composer-style.ts";
import { TernInlineSurface, parseTspMessages } from "../../.pi/lib/tern/tsp.ts";
import { PI_ASK_STARTED_EVENT } from "../../extensions/ask-user/src/remote-ask.ts";

const output = resolve("artifacts/tern-mobile");
mkdirSync(output, { recursive: true });

function bus() {
	const handlers = new Map();
	return {
		emit(channel, data) {
			for (const handler of handlers.get(channel) ?? []) handler(data);
		},
		on(channel, handler) {
			handlers.set(channel, [...(handlers.get(channel) ?? []), handler]);
			return () => handlers.set(channel, (handlers.get(channel) ?? []).filter((h) => h !== handler));
		},
	};
}

const questions = [
	{
		id: "scope",
		label: "Scope",
		prompt: "Which scope should this change cover?",
		type: "single",
		required: true,
		options: [
			{ value: "composer", label: "Composer only", freeform: false },
			{ value: "both", label: "Composer and ask dialog", freeform: false },
		],
	},
	{
		id: "tags",
		label: "Include",
		prompt: "What should the mobile polish include?",
		type: "multi",
		required: false,
		options: [
			{ value: "touch", label: "Touch targets", freeform: false },
			{ value: "keyboard", label: "Keyboard Return", freeform: false },
			{ value: "states", label: "Loading and error states", freeform: false },
		],
	},
];

function askDialog(columns, mutate) {
	const events = bus();
	const dialog = new TernAskDialog(events, () => {});
	dialog.start();
	events.emit(PI_ASK_STARTED_EVENT, {
		version: 1,
		flowId: "fixture",
		toolCallId: "fixture",
		source: "tool",
		title: "Mobile handoff",
		questions,
		createdAt: 0,
	});
	mutate?.(dialog);
	return dialog.nodes(columns);
}

function editorDialog(columns) {
	const events = bus();
	const dialog = new TernAskDialog(events, () => {});
	dialog.start();
	events.emit(PI_ASK_STARTED_EVENT, {
		version: 1,
		flowId: "fixture-editor",
		toolCallId: "fixture-editor",
		source: "tool",
		title: "Explain the change",
		questions: [{
			id: "reason",
			label: "Reason",
			prompt: "Why does this need a mobile-specific treatment?",
			type: "single",
			required: true,
			options: [{ value: "freeform", label: "Type answer", freeform: true }],
		}],
		createdAt: 0,
	});
	dialog.toggle(0, 0);
	dialog.input("Return arrives as CRLF on iOS");
	return dialog.nodes(columns);
}

const transcript = [
	{ id: "msg-a", k: "col", p: { role: "pi.assistant" }, c: [
		{ id: "msg-a-body", k: "md", p: { text: "The mobile composer now has a labelled Send target, and the ask dialog keeps every answer reachable by tap." } },
	] },
];

const composer = composerNodes({
	draft: "Fix the mobile send button",
	busy: false,
	compact: true,
	model: "Haiku 5.5",
	context: { tokens: 36_000, window: 200_000, compactAt: 85 },
	git: { branch: "fix/ask-user-tern-mobile", staged: 0, unstaged: 2, untracked: 1 },
	cost: 0.42,
});

const scenarios = [
	{ name: "composer-mobile", width: 390, height: 844, dock: composer },
	{ name: "ask-question-mobile", width: 390, height: 844, dock: askDialog(48) },
	{ name: "ask-multi-mobile", width: 390, height: 844, dock: askDialog(48, (dialog) => { dialog.toggle(0, 1); dialog.moveTab(1); dialog.toggle(1, 0); }) },
	{ name: "ask-review-mobile", width: 390, height: 844, dock: askDialog(48, (dialog) => { dialog.toggle(0, 1); dialog.moveTab(1); dialog.toggle(1, 0); dialog.moveTab(1); }) },
	{ name: "ask-editor-mobile", width: 390, height: 844, dock: editorDialog(48) },
	{ name: "ask-review-wide", width: 1200, height: 900, dock: askDialog(90, (dialog) => { dialog.toggle(0, 1); dialog.moveTab(1); dialog.toggle(1, 0); dialog.moveTab(1); }) },
];

const dir = mkdtempSync(join(tmpdir(), "tern-mobile-"));
const sock = join(dir, "ctl.sock");
const child = spawn("tern", ["serve", "--control", sock], { cwd: output, stdio: "ignore" });
const ctl = (command) => {
	const reply = JSON.parse(execFileSync("tern", ["ctl", "--control", sock, command], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));
	if (!reply.ok) throw new Error(`${command}: ${reply.error}`);
	return reply;
};

try {
	const deadline = Date.now() + 20_000;
	while (!existsSync(sock)) {
		if (Date.now() > deadline) throw new Error("Tern control timeout");
		await new Promise((r) => setTimeout(r, 50));
	}
	for (const scenario of scenarios) {
		const writes = [];
		const surface = new TernInlineSurface((chunk) => writes.push(chunk), `mobile-${scenario.name}`, 10_000);
		surface.open(scenario.name);
		surface.stylesheet("composer", PI_COMPOSER_CSS);
		surface.render(transcript, scenario.dock);
		const file = join(output, `${scenario.name}.jsonl`);
		writeFileSync(file, writes.flatMap(parseTspMessages).map((message, index) => JSON.stringify({
			t: index * 16,
			dir: "out",
			verb: message.verb,
			body: message.body,
		})).join("\n") + "\n");
		ctl(`resize ${scenario.width} ${scenario.height}`);
		ctl(`surface-play "${file}"`);
		ctl("wait 250");
		// TernInlineSurface opens an inline surface: its transcript and dock live under .sf-main and
		// .sf-dock, not under an overlay. Query both so a missing dock fails loudly.
		const tree = ctl("tree .sf-dock *");
		writeFileSync(join(output, `${scenario.name}.tree.json`), JSON.stringify(tree, null, 2));
		if (!tree.nodes?.length) throw new Error(`No native nodes rendered for ${scenario.name}`);
		console.log(JSON.stringify({ scenario: scenario.name, width: scenario.width, screenshot: ctl(`shot ${scenario.name}`) }));
	}
} finally {
	try { ctl("quit"); } catch {}
	child.kill();
	rmSync(dir, { recursive: true, force: true });
}
