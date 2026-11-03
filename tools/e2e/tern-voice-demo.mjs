#!/usr/bin/env -S node --experimental-strip-types
/**
 * Visual harness for the dictation surface, not an assertion test: it drives the real
 * PiTernBridge with a fake session and paints the same widget lines `extensions/voice`
 * paints while recording, so you can look at where they land in a pane:
 *
 *   tern new tab --cwd "$PWD" --keep-open -- sh -c 'TERN_VOICE_DEMO=1 node tools/e2e/tern-voice-demo.mjs'
 *   tern ctl shot voice-meter     # target/shots/tern/live/voice-meter.png
 *
 * The behaviour it shows is asserted headlessly by .pi/test/tern/voice-surface.test.ts and
 * .pi/test/tern/ext-shortcuts.test.ts; this only renders.
 */
import { PiTernBridge } from "../../.pi/lib/tern/bridge.ts";
import { helloQuery, splitInput } from "../../.pi/lib/tern/tsp.ts";

const listeners = new Set();
const session = {
	subscribe(l) {
		listeners.add(l);
		return () => listeners.delete(l);
	},
	prompt: () => new Promise(() => {}),
	abort: async () => {},
	dispose() {},
	sessionManager: { getSessionId: () => "voice-demo", getEntries: () => [], getBranch: () => [], getCwd: () => process.cwd() },
	model: { provider: "anthropic", id: "opus" },
};
let bridge;
const METER = "pi-voice-meter";
let timer;

// It takes over the terminal it runs in (raw input, TSP surface), so it needs an explicit opt-in
// from the tab you opened for it and gives the terminal back on any exit.
if (process.env.TERN_VOICE_DEMO !== "1") {
	console.error("Visual harness: open it in its own Tern tab, TERN_VOICE_DEMO=1 node tools/e2e/tern-voice-demo.mjs");
	process.exit(2);
}
const restoreTerminal = () => {
	clearInterval(timer);
	try {
		process.stdin.setRawMode(false);
	} catch {
		// not a tty
	}
};
process.on("exit", restoreTerminal);
process.on("SIGTERM", () => {
	restoreTerminal();
	process.exit(0);
});
process.on("SIGINT", () => {
	restoreTerminal();
	process.exit(0);
});

// The meter is one plain-text line: block bands, elapsed time, then state words. Voice paints it
// with theme escapes, which the Tern shim strips, so the demo paints the stripped text directly.
const bands = "████▆▅▃▂▁";
const paint = () => {
	const started = Date.now();
	timer = setInterval(() => {
		const seconds = Math.floor((Date.now() - started) / 1000);
		const elapsed = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
		const line = seconds === 0 ? `${bands}  ${elapsed}  loading model` : `${bands}  ${elapsed}  space stop · esc discard`;
		(bridge?.uiContext()).setWidget?.(METER, [line]);
		if (seconds >= 20) clearInterval(timer);
	}, 250);
};

process.stdin.setRawMode(true);
process.stdin.resume();
let pending = "";
process.stdin.on("data", (chunk) => {
	const parsed = splitInput(pending + chunk.toString());
	pending = parsed.rest;
	for (const msg of parsed.messages) {
		if (!bridge && msg.verb === "r" && Array.isArray(msg.body.kinds)) {
			bridge = new PiTernBridge(session, {
				write: (d) => process.stdout.write(d),
				surfaceId: "pi",
				credits: Number(msg.body.credits) || 2,
				kinds: msg.body.kinds,
			});
			bridge.start("pi");
			paint();
			continue;
		}
		bridge?.handle(msg);
	}
});
process.stdout.write(helloQuery("pi"));
