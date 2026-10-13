// Standalone Tern smoke: probes TSP, opens one inline surface, renders a transcript
// (including an oversized message to exercise chunking), and falls back to plain text.
// Not wired into Pi. Run inside a Tern pane: node --experimental-strip-types .pi/lib/tern/smoke.ts
import {
	TernInlineSurface,
	detectTern,
	helloQuery,
	projectTranscript,
	shouldProbe,
	splitInput,
	type TspMessage,
} from "./tsp.ts";

const PROBE_MS = 1000;
const transcript = [
	{ id: "1", role: "user" as const, text: "smoke: hello" },
	{ id: "2", role: "assistant" as const, text: "x".repeat(70_000) },
	{ id: "3", role: "assistant" as const, text: "done" },
];

const stdin = process.stdin;
const stdout = process.stdout;
const isTty = Boolean(stdin.isTTY);

function plainFallback(reason: string): void {
	stdout.write(`[tsp: ${reason}; plain renderer]\n`);
	for (const m of transcript) stdout.write(`${m.role}: ${m.text.slice(0, 80)}\n`);
	process.exit(0);
}

if (!shouldProbe(process.env)) plainFallback("probe disabled");
if (!isTty) plainFallback("stdin is not a tty");

let raw = "";
let surface: TernInlineSurface | null = null;
let caps: ReturnType<typeof detectTern> = null;
let probeTimer: NodeJS.Timeout | undefined;
let restored = false;
let pending = "";

function restoreTty(): void {
	if (restored) return;
	restored = true;
	if (surface) surface.close(false);
	stdin.setRawMode(false);
	stdin.pause();
}

process.on("exit", restoreTty);
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
	process.on(sig, () => {
		restoreTty();
		process.exit(128);
	});
}

function onMessage(msg: TspMessage): void {
	if (msg.verb === "r") return;
	if (msg.verb === "e" && msg.body.ev === "error") stdout.write(`[tsp error] ${JSON.stringify(msg.body)}\n`);
	surface?.handleEvent(msg);
}

function onData(chunk: Buffer): void {
	const text = chunk.toString("utf8");
	if (!caps) {
		raw += text;
		const found = detectTern(raw);
		if (found) return onDetected(found);
		if (/\x1b\[\?[\d;]*c/.test(raw)) {
			restoreTty();
			return plainFallback("DA1 without TSP hello");
		}
		return;
	}
	const parsed = splitInput(pending + text);
	pending = parsed.rest;
	for (const msg of parsed.messages) onMessage(msg);
	if (parsed.keys.includes("q") || parsed.keys.includes("\x03")) process.exit(0);
}

function onDetected(found: NonNullable<ReturnType<typeof detectTern>>): void {
	caps = found;
	clearTimeout(probeTimer);
	surface = new TernInlineSurface(
		(d) => stdout.write(d),
		"smoke",
		found.credits,
		found.apc,
	);
	surface.open("tsp smoke");
	surface.render(projectTranscript(transcript));
	stdout.write(`\r\n[tsp: ${found.term} ${found.ver}; q to quit]\r\n`);
}

stdin.setRawMode(true);
stdin.resume();
stdin.on("data", onData);
stdout.write(`${helloQuery("pi", ["send"])}`);
probeTimer = setTimeout(() => {
	if (!caps) {
		restoreTty();
		plainFallback("no hello reply within 1s");
	}
}, PROBE_MS);
