#!/usr/bin/env -S node --experimental-strip-types
/**
 * Deep calibration check for the composer waveform, driven by a real spoken-word recording rather
 * than a synthetic sine. It downloads 60 s of a public Commons speech, decodes it to 16 kHz mono,
 * runs the real `SpectrumAnalyzer`, and reports both the level distribution and what Tern actually
 * paints at phone, normal and wide widths.
 *
 *   node --experimental-strip-types tools/e2e/voice-wave-calibration.mjs [--json] [--shot]
 *
 * The source URL and byte range are fixed so the numbers are comparable between runs. Network is
 * needed only for the first run; the decoded /tmp/pi-voice-speech16.wav is reused afterwards.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PiTernBridge } from "../../.pi/lib/tern/bridge.ts";
import { PI_COMPOSER_CSS } from "../../.pi/lib/tern/composer-style.ts";

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const TERN = process.env.TERN_BIN ?? "tern";
const WAV = "/tmp/pi-voice-speech16.wav";
const URL = "https://upload.wikimedia.org/wikipedia/commons/0/0f/Kimberly_Guilfoyle_Fayetteville%2C_NC%2C_Speech.wav";
const RANGE = 44 + 60 * 44100 * 4 - 1; // 60 s of 44.1 kHz stereo PCM after the 44-byte header

function ensureSpeech() {
	if (existsSync(WAV)) return;
	console.error("downloading a public Commons speech sample…");
	const pcm = execFileSync("curl", ["-sL", "--max-time", "180", "-r", `44-${RANGE}`, URL], { maxBuffer: 64 * 1024 * 1024 });
	const frames = Math.floor(pcm.length / 4);
	const outLen = Math.floor((frames * 16000) / 44100);
	const mono = new Float32Array(outLen);
	for (let i = 0; i < outLen; i += 1) {
		const src = (i * 44100) / 16000;
		const i0 = Math.floor(src);
		const i1 = Math.min(frames - 1, i0 + 1);
		const t = src - i0;
		const a = (pcm.readInt16LE(i0 * 4) + pcm.readInt16LE(i0 * 4 + 2)) / 65536;
		const b = (pcm.readInt16LE(i1 * 4) + pcm.readInt16LE(i1 * 4 + 2)) / 65536;
		mono[i] = a + (b - a) * t;
	}
	const data = Buffer.alloc(outLen * 2);
	for (let i = 0; i < outLen; i += 1) data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(mono[i] * 32768))), i * 2);
	const head = Buffer.alloc(44);
	head.write("RIFF", 0); head.writeUInt32LE(36 + data.length, 4); head.write("WAVE", 8);
	head.write("fmt ", 12); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22);
	head.writeUInt32LE(16000, 24); head.writeUInt32LE(32000, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34);
	head.write("data", 36); head.writeUInt32LE(data.length, 40);
	writeFileSync(WAV, Buffer.concat([head, data]));
}

function compileVoice() {
	const build = "/tmp/pi-voice-wave-build";
	// Always rebuild: this tool exists to measure the current source, and a stale cache would lie.
	const require = createRequire(import.meta.url);
	const tsc = join(dirname(require.resolve("typescript/package.json")), "bin", "tsc");
	execFileSync(process.execPath, [tsc, "--noEmit", "false", "--outDir", build, "--declaration", "false"], {
		cwd: join(ROOT, "extensions/voice"),
		stdio: "ignore",
	});
	writeFileSync(join(build, "package.json"), '{"type":"module"}\n');
	return import(join(build, "src/visualizer.js"));
}

function decodeWav16(path) {
	const buffer = readFileSync(path);
	if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") throw new Error("not a WAV");
	let at = 12;
	while (at + 8 <= buffer.length) {
		const id = buffer.toString("ascii", at, at + 4);
		const size = buffer.readUInt32LE(at + 4);
		if (id === "data") {
			const samples = new Float32Array(Math.floor(size / 2));
			for (let i = 0; i < samples.length; i += 1) samples[i] = buffer.readInt16LE(at + 8 + i * 2) / 32768;
			return samples;
		}
		at += 8 + size + (size % 2);
	}
	throw new Error("no data chunk");
}

const percentile = (values, p) => {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor((sorted.length - 1) * p)] ?? 0;
};

ensureSpeech();
const { SpectrumAnalyzer, waveformLevel, WAVE_COLUMNS } = await compileVoice();
const samples = decodeWav16(WAV);
const analyzer = new SpectrumAnalyzer();
const frames = [];
for (let at = 0; at + 512 <= samples.length; at += 512) {
	analyzer.push(samples.subarray(at, at + 512));
	frames.push([...analyzer.levels]);
}
const allLevels = frames.flat();
const saturated = allLevels.filter((level) => level >= 0.999).length / allLevels.length;
const silent = allLevels.filter((level) => level === 0).length / allLevels.length;

// Pick an audible window with real shape and no long flat top: a screenshot of a sustained shout would
// hide the very thing this check is for. The worst plateau is reported separately.
let best = 0;
let bestScore = -1;
let worstFlat = { frame: 0, nearMax: 0 };
let quiet = -1;
let quietMax = Infinity;
for (let index = 0; index + WAVE_COLUMNS <= frames.length; index += 1) {
	const window = frames[index];
	const max = Math.max(...window);
	const mean = window.reduce((sum, value) => sum + value, 0) / window.length;
	const spread = Math.sqrt(window.reduce((sum, value) => sum + (value - mean) ** 2, 0) / window.length);
	const nearMax = window.filter((value) => value >= max * 0.9).length;
	if (nearMax > worstFlat.nearMax) worstFlat = { frame: index, nearMax };
	if (max > 0.3 && nearMax < WAVE_COLUMNS * 0.2 && spread > bestScore) { bestScore = spread; best = index; }
	if (max < quietMax) { quietMax = max; quiet = index; }
}
const loud = frames.findLastIndex((window) => Math.max(...window) >= 0.95);

const stats = {
	seconds: +(samples.length / 16000).toFixed(1),
	chunks: frames.length,
	levelPercentiles: [0, 0.1, 0.25, 0.5, 0.75, 0.9, 0.99, 1].map((p) => +percentile(allLevels, p).toFixed(3)),
	saturatedPercent: +(saturated * 100).toFixed(1),
	silentPercent: +(silent * 100).toFixed(1),
	speechFrame: best,
	quietestFrameMax: +quietMax.toFixed(3),
	worstFlatFrame: worstFlat,
	quietFrame: quiet,
	loudFrame: loud,
};

const dir = mkdtempSync(join(tmpdir(), "voice-calibration-"));
const sock = join(dir, "ctl.sock");
const cssFile = join(dir, "composer.css");
const listeners = new Set();
const session = {
	state: {},
	subscribe: (listener) => (listeners.add(listener), () => listeners.delete(listener)),
	prompt: () => new Promise(() => {}),
	abort: async () => {},
	dispose() {},
	sessionManager: { getSessionId: () => "voice-calibration", getEntries: () => [], getBranch: () => [], getCwd: () => process.cwd() },
};
const writes = [];
const bridge = new PiTernBridge(session, { write: (data) => writes.push(data), surfaceId: "pi", credits: 1_000_000 });
bridge.start("pi");
const ui = bridge.uiContext();

const frameLines = (writes) => {
	const lines = [];
	let t = 0;
	for (const write of writes) {
		for (const hit of write.matchAll(/\x1b_tsp;([A-Za-z]);([\s\S]*?)\x1b\\/g)) {
			try { lines.push(JSON.stringify({ t: (t += 16), dir: "out", verb: hit[1], body: JSON.parse(hit[2]) })); } catch { /* not a frame */ }
		}
	}
	return lines;
};

writeFileSync(cssFile, PI_COMPOSER_CSS);
let child;
const cleanup = () => {
	try { if (existsSync(sock)) ctl("quit"); } catch { /* already gone */ }
	child?.kill();
	rmSync(dir, { recursive: true, force: true });
};
process.on("exit", cleanup);
child = spawn(TERN, ["serve", "--control", sock], { cwd: ROOT, stdio: "ignore", detached: true });
const deadline = Date.now() + 30_000;
while (!existsSync(sock)) {
	if (Date.now() > deadline) throw new Error("tern serve did not open its control socket");
	execFileSync("sleep", ["0.05"]);
}
function ctl(command) {
	const raw = execFileSync(TERN, ["ctl", "--control", sock, command], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
	const reply = JSON.parse(raw);
	if (reply.ok !== true) throw new Error(`tern ctl ${command}: ${reply.error ?? "failed"}`);
	return reply;
}
const nodes = (selector) => ctl(`tree ${selector}`).nodes ?? [];
const box = (selector) => nodes(selector)[0]?.rect ?? null;
let replayAt = 0;
const playNew = (name) => {
	const lines = frameLines(writes.slice(replayAt));
	replayAt = writes.length;
	if (lines.length === 0) return;
	const file = join(dir, `${name}.jsonl`);
	writeFileSync(file, lines.join("\n") + "\n");
	ctl(`surface-play "${file}"`);
};

ctl(`css composer ${cssFile}`);
playNew("initial");

const widths = [
	{ name: "phone", cols: 40, size: "390x760" },
	{ name: "normal", cols: 100, size: "900x760" },
	{ name: "wide", cols: 160, size: "1400x900" },
	{ name: "tiny", cols: 32, size: "320x700" },
];
const shots = {};
const measurements = {};
for (const width of widths) {
	await bridge.handle({ verb: "e", body: { ev: "resize", cols: width.cols } });
	ui.ternMeter({ levels: frames[best], elapsedMs: 7420, modelState: "loading", microphoneStopped: false });
	playNew(`meter-${width.name}`);
	ctl(`resize ${width.size.replace("x", " ")}`);
	ctl("wait 500");
	const [w, h] = width.size.split("x").map(Number);
	const card = box("[data-role='omp.editor']");
	const row = box("[data-role='pi.composer.wave']");
	const chart = box("[data-role='pi.composer.wave.chart']");
	const meta = box("[data-role='pi.composer.wave.meta']");
	const editor = box("[data-role='omp.composer.line']");
	const bars = nodes("[data-role='pi.composer.wave.chart'] .b").map((node) => node.rect);
	const heights = bars.map((rect) => rect?.[3] ?? 0);
	const widthsPx = bars.map((rect) => rect?.[2] ?? 0);
	const maxHeight = heights.length ? Math.max(...heights) : 0;
	const maxWidth = widthsPx.length ? Math.max(...widthsPx) : 0;
	const minWidth = widthsPx.length ? Math.min(...widthsPx) : 0;
	const flat = heights.filter((value) => value >= maxHeight * 0.9).length;
	const stubs = heights.filter((value) => value <= 2).length;
	const out = bars.filter((rect) => rect && chart && card && (rect[0] < card[0] - 1 || rect[0] + rect[2] > card[0] + card[2] + 1));
	const failure = [];
	if (!card || !row || !chart || !meta || !editor) failure.push("a waveform part did not paint");
	if (card && editor && card[0] + card[2] > w + 1) failure.push("the composer card overflows the window");
	if (card && card[1] + card[3] > h + 1) failure.push("the composer card falls below the window");
	if (chart && card && (chart[0] < card[0] - 1 || chart[0] + chart[2] > card[0] + card[2] + 1)) failure.push("the chart breaks out of the card");
	if (meta && card && meta[0] + meta[2] > card[0] + card[2] + 1) failure.push("the facts break out of the card");
	if (chart && editor && chart[1] + chart[3] > editor[1] + 1) failure.push("the waveform is not above the editor");
	if (out.length) failure.push(`${out.length} bar(s) break out of the chart`);
	if (bars.length === 0) failure.push("no bars painted");
	if (minWidth < 2) failure.push(`bars collapse to ${minWidth}px`);
	if (chart && maxHeight > chart[3] + 1) failure.push("a bar is taller than its chart");
	if (width.cols < 56 && bars.length !== 48) failure.push(`phone width drew ${bars.length} bars instead of 48`);
	if (width.cols >= 56 && bars.length !== 96) failure.push(`wide width drew ${bars.length} bars instead of 96`);
	measurements[width.name] = {
		card: card ?? null,
		chart: chart ?? null,
		row: row ?? null,
		meta: meta ?? null,
		bars: bars.length,
		minBarWidth: +minWidth.toFixed(1),
		maxBarWidth: +maxWidth.toFixed(1),
		maxBarHeight: +maxHeight.toFixed(1),
		barsNearMax: flat,
		stubBars: stubs,
		failures: failure,
	};
	if (process.argv.includes("--shot")) {
		shots[width.name] = `voice-wave-${width.name}.png`;
		try { ctl(`shot voice-wave-${width.name}`); } catch (error) { console.error(String(error)); }
	}
}

// Silence is a real state: the gate must draw flat stubs, not normalise room noise into a wave.
await bridge.handle({ verb: "e", body: { ev: "resize", cols: 100 } });
ui.ternMeter({ levels: Array.from({ length: WAVE_COLUMNS }, () => 0), elapsedMs: 1200, modelState: "ready", microphoneStopped: false });
playNew("silence");
ctl("resize 900 760");
ctl("wait 400");
const silenceBars = nodes("[data-role='pi.composer.wave.chart'] .b").map((node) => node.rect?.[3] ?? 0);
const silenceFailures = [];
if (silenceBars.length !== 96) silenceFailures.push(`silent input drew ${silenceBars.length} bars instead of 96`);
if (silenceBars.some((height) => height > 2)) silenceFailures.push("silent input draws taller than a 2px stub");
if (process.argv.includes("--shot")) {
	shots.silence = "voice-wave-silence.png";
	try { ctl("shot voice-wave-silence"); } catch (error) { console.error(String(error)); }
}

// The strip must not leave the composer taller than its idle height once the take ends.
const activeHeight = measurements.normal.card?.[3] ?? null;
ui.ternMeter(undefined);
playNew("cleared");
ctl("wait 400");
const idleHeight = box("[data-role='omp.editor']")?.[3] ?? null;
const cleared = nodes("[data-role='pi.composer.wave']").length;

bridge.close?.();
const failures = [
	...Object.entries(measurements).flatMap(([name, value]) => value.failures.map((failure) => `${name}: ${failure}`)),
	...silenceFailures.map((failure) => `silence: ${failure}`),
	...(cleared !== 0 ? [`the waveform survives with no take (${cleared} node(s))`] : []),
];
const summary = { stats, activeHeight, idleHeight, cleared, silenceBars: silenceBars.length, measurements, shots, failures };
console.log(process.argv.includes("--json") ? JSON.stringify(summary, null, 2) : `voice waveform calibration ${JSON.stringify(summary)}`);
cleanup();
process.exit(failures.length ? 1 : 0);
