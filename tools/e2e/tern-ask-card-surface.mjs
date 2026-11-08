#!/usr/bin/env -S node --experimental-strip-types
/**
 * Measures the ask dialog's card surface in Tern itself, not by reading our own CSS: the real
 * TernAskDialog's nodes go into a headless `tern serve`, and the report is the computed background of the
 * element Tern actually painted.
 *
 * The oracle is Tern (as with tools/tern/style-lint.mjs). Two renders, both with the ask sheet registered:
 *   - `ask`     the dialog's own card (role `pi.ask`) — must be fully opaque, in light and in dark;
 *   - `control` a card with no role — must keep Tern's glass fill (`--sf-card-bg`, white 55% / 2.8%), which
 *               is what proves the fix is scoped to the ask surface instead of restyling every card.
 *
 *   node tools/e2e/tern-ask-card-surface.mjs [--json] [--no-sheet] [--size=900x760]
 *
 * `--no-sheet` skips registering PI_ASK_CSS, reproducing the pre-fix surface: the ask card measures
 * translucent, which is how this check is shown failing before it passes.
 *
 * Exit 1 if the ask card is translucent, the control card lost its glass, or no card rendered.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TernAskDialog } from "../../.pi/lib/tern/ask-dialog.ts";
import { PI_ASK_CSS } from "../../.pi/lib/tern/ask-style.ts";
import { TernInlineSurface, parseTspMessages } from "../../.pi/lib/tern/tsp.ts";
import { PI_ASK_STARTED_EVENT } from "../../extensions/ask-user/src/remote-ask.ts";

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const noSheet = args.includes("--no-sheet");
const size = (args.find((a) => a.startsWith("--size="))?.slice(7) ?? "900x760").split("x").map(Number);
const TERN = process.env.TERN_BIN ?? "tern";

const events = () => {
	const handlers = new Map();
	return {
		emit(channel, data) { for (const handler of handlers.get(channel) ?? []) handler(data); },
		on(channel, handler) {
			handlers.set(channel, [...(handlers.get(channel) ?? []), handler]);
			return () => handlers.set(channel, (handlers.get(channel) ?? []).filter((h) => h !== handler));
		},
	};
};

const QUESTIONS = [{
	id: "scope",
	label: "Scope",
	prompt: "Which scope should this change cover?",
	type: "single",
	required: true,
	options: [
		{ value: "composer", label: "Composer only", freeform: false },
		{ value: "both", label: "Composer and ask dialog", freeform: false },
	],
}];

// The dialog's own nodes: exactly what the bridge hands the dock when a flow opens.
function askDock() {
	const bus = events();
	const dialog = new TernAskDialog(bus, () => {});
	dialog.start();
	bus.emit(PI_ASK_STARTED_EVENT, {
		version: 1, flowId: "surface-fixture", toolCallId: "surface-fixture", source: "tool",
		title: "Mobile handoff", questions: QUESTIONS, createdAt: 0,
	});
	return dialog.nodes(size[0] < 560 ? 48 : 90);
}

// A role-less card under the same sheet: Tern's glass must survive the ask override.
function controlDock() {
	return [{ id: "control-card", k: "card", p: { head: "Control" }, c: [
		{ id: "control-line", k: "text", p: { text: "A card with no role keeps Tern's glass fill.", wrap: "soft" } },
	] }];
}

const transcript = [{ id: "msg-a", k: "col", p: { role: "pi.assistant" }, c: [
	{ id: "msg-a-body", k: "md", p: { text: "The ask dialog keeps every answer reachable by tap." } },
] }];

/** Alpha of a computed CSS colour. Tern reports `rgb(...)` for opaque fills and `rgba(...)` otherwise. */
const alphaOf = (colour) => {
	const match = /^rgba?\(([^)]+)\)$/.exec(String(colour).trim());
	if (!match) return Number.NaN;
	const parts = match[1].split(/[,/]/).map((part) => part.trim());
	return parts.length === 4 ? Number(parts[3]) : 1;
};

const dir = mkdtempSync(join(tmpdir(), "tern-ask-surface-"));
const sock = join(dir, "ctl.sock");
const child = spawn(TERN, ["serve", "--control", sock], { cwd: dir, stdio: "ignore" });
const ctl = (command) => {
	const reply = JSON.parse(execFileSync(TERN, ["ctl", "--control", sock, command], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));
	if (!reply.ok) throw new Error(`${command}: ${reply.error}`);
	return reply;
};

const findings = [];
const ratio = [];
try {
	const deadline = Date.now() + 20_000;
	while (!existsSync(sock)) {
		if (Date.now() > deadline) throw new Error("Tern control timeout");
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	for (const scenario of [{ name: "ask", dock: askDock }, { name: "control", dock: controlDock }]) {
		for (const theme of ["light", "dark"]) {
			const writes = [];
			const surface = new TernInlineSurface((chunk) => writes.push(chunk), `ask-surface-${scenario.name}`, 10_000);
			surface.open("ask-surface");
			if (!noSheet) surface.stylesheet("ask", PI_ASK_CSS);
			surface.render(transcript, scenario.dock());
			const file = join(dir, `${scenario.name}-${theme}.jsonl`);
			writeFileSync(file, writes.flatMap(parseTspMessages).map((message, index) => JSON.stringify({
				t: index * 16, dir: "out", verb: message.verb, body: message.body,
			})).join("\n") + "\n");
			ctl(`appearance ${theme}`);
			ctl(`resize ${size[0]} ${size[1]}`);
			ctl(`surface-play "${file}"`);
			ctl("wait 300");
			const shot = ctl(`shot ${scenario.name}-${theme}`);
			const layout = JSON.parse(readFileSync(join(dir, shot.layout), "utf8"));
			// The dock's card is the only card in each scenario, so its computed fill is unambiguous.
			const card = layout.elements.find((el) => el.visible && el.path.includes("div.sf.sf-card"));
			if (!card) {
				findings.push({ scenario: scenario.name, theme, ok: false, why: "no card rendered in the dock" });
				continue;
			}
			const alpha = alphaOf(card.backgroundColor);
			const want = scenario.name === "ask" ? 1 : "glass";
			const ok = scenario.name === "ask" ? alpha === 1 : alpha < 1;
			ratio.push({ scenario: scenario.name, theme, background: card.backgroundColor, alpha, ok });
			if (!ok) findings.push({ scenario: scenario.name, theme, ok, why: `expected ${want}, measured alpha ${alpha}`, background: card.backgroundColor });
		}
	}
} finally {
	try { ctl("quit"); } catch { /* already gone */ }
	child.kill();
	if (!process.env.KEEP_SHOTS) rmSync(dir, { recursive: true, force: true });
}

const failed = findings.length > 0;
if (asJson) {
	console.log(JSON.stringify({ sheet: noSheet ? "not registered (pre-fix)" : "PI_ASK_CSS", size, ratio, findings }, null, 2));
} else {
	for (const row of ratio) {
		console.log(`${row.ok ? "ok  " : "FAIL"} ${row.scenario.padEnd(7)} ${row.theme.padEnd(5)} ${row.background}`);
	}
	for (const finding of findings) console.log(`  ${finding.scenario}/${finding.theme}: ${finding.why}`);
	console.log(failed
		? "The ask card is not solid, or the glass of a role-less card was lost."
		: "Ask card is opaque in light and dark; a role-less card is still glass.");
}
process.exit(failed ? 1 : 0);
