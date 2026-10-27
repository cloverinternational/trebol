#!/usr/bin/env -S node --experimental-strip-types
/**
 * Deterministic diagram/table fixture harness: the real PiTernBridge and TernInlineSurface speak to a
 * real Tern in a headless `tern serve` session, with no model, provider or Pi SDK. Each stage renders one
 * case, waits for Tern's frame ack, then asks Tern for a screenshot and its layout JSON.
 *
 *   node tools/e2e/tern-diagram-fixtures.mjs                 # every stage at 72 and 140 columns
 *   node tools/e2e/tern-diagram-fixtures.mjs --stage mermaid --cols 72
 *
 * Artifacts: target/shots/tern/serve/tern-diagram-<stage>-<cols>.png and .layout.json.
 * Stages: mermaid, stream, streamed, malformed, autograph, svg, svg-unsupported.
 * It never touches an existing Tern window: the driver opens its own `tern --control` window per stage,
 * runs the case in it, shoots it, and closes it.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { planChart, parseMarkdownTables, renderTextChart, toTspChart } from "../../.pi/lib/tern/auto-graph.ts";
import { PiTernBridge } from "../../.pi/lib/tern/bridge.ts";
import { helloQuery, parseTspMessages, splitInput } from "../../.pi/lib/tern/tsp.ts";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const shotDir = join(repo, "target/shots/tern/serve");
const STAGES = ["mermaid", "stream", "streamed", "malformed", "autograph", "svg", "svg-unsupported"];
const COLUMNS = [72, 140];

// ---------------------------------------------------------------- fixtures

const FLOWCHART = [
	"```mermaid",
	"graph TD",
	'  A["User asks for a diagram"] --> B["Pi emits assistant Markdown"]',
	'  B --> C{"Fence closed?"}',
	'  C -->|yes| D["Tern lays out the Mermaid"]',
	'  C -->|no| E["Provisional code block"]',
	'  D --> F["Open shows it large"]',
	"```",
].join("\n");

const SEQUENCE = [
	"```mermaid",
	"sequenceDiagram",
	"  participant U as User",
	"  participant P as Pi",
	"  participant T as Tern",
	"  U->>P: prompt",
	"  P->>T: md node with fence",
	"  T-->>U: diagram",
	"```",
].join("\n");

const TABLE = [
	"| Stage | Owner | Latency | Note |",
	"| :--- | :---: | ---: | :--- |",
	"| Parse | `md` | 12ms | keeps `**markdown**` and `_emphasis_` |",
	"| Layout | Mermaid | 240ms | wide flows scroll sideways |",
	"| Table | Tern | 4ms | values intact |",
].join("\n");

// Deliberately wide: every column must stay reachable instead of being dropped.
const WIDE_TABLE = [
	"| Command | What it does on a very wide terminal transcript | Exit |",
	"| :--- | :--- | ---: |",
	"| `node tools/e2e/tern-diagram-fixtures.mjs --stage mermaid --cols 72` | renders the fixture in its own headless session | 0 |",
	"| `tern ctl shot <name>` | writes a PNG and a layout JSON beside the shots directory | 0 |",
	"| `npm test -- diagram` | runs the focused regression suites for the projection | 1 |",
].join("\n");

const MALFORMED = [
	"Broken diagrams must stay readable:",
	"",
	"```mermaid",
	"sandwich LR",
	'  A["not a diagram kind"] --> B',
	"```",
	"",
	"```mermaid",
	"graph TD",
	"  A -->",
	"```",
	"",
	"The source above is intact.",
].join("\n");

const STREAMING_OPEN = [
	"Here is the flow so far:",
	"",
	"```mermaid",
	"graph TD",
	'  A["Plan approved"] --> B["Bridge projects md"]',
	'  B --> C{"Stream still open?"}',
].join("\n");

const STREAMING_DONE = [
	STREAMING_OPEN,
	'  C -->|yes| D["Provisional code"]',
	'  C -->|no| E["Mermaid figure"]',
	"```",
	"",
	"| Step | State |",
	"| --- | --- |",
	"| fence | closed |",
	"| table | drawn |",
].join("\n");

const SIZE = '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="120" viewBox="0 0 240 120">' +
	'<rect x="0" y="0" width="240" height="120" fill="#eef"/>' +
	'<circle cx="60" cy="60" r="40" fill="#2a7"/>' +
	'<text x="120" y="64" font-size="14">sized root</text></svg>';

// No width/height: only the viewBox carries the aspect ratio.
const VIEWBOX_ONLY = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 120">' +
	'<rect x="0" y="0" width="240" height="120" fill="#fee"/>' +
	'<rect x="20" y="20" width="200" height="80" fill="#c33"/>' +
	'<text x="60" y="70" font-size="14">viewBox only</text></svg>';

// Tern's sanitizer keeps a whitelist; these nodes and attributes are dropped.
const UNSUPPORTED = '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="120" viewBox="0 0 240 120">' +
	'<style>.kept { fill: #0a0; }</style>' +
	'<defs><linearGradient id="g"><stop offset="0" stop-color="#000"/><stop offset="1" stop-color="#fff"/></linearGradient></defs>' +
	'<rect class="kept" x="0" y="0" width="240" height="120" fill="url(#g)"/>' +
	'<use href="#g" x="10" y="10"/>' +
	'<foreignObject x="20" y="40" width="200" height="60"><div xmlns="http://www.w3.org/1999/xhtml">HTML label</div></foreignObject>' +
	'<script>alert(1)</script>' +
	'<text x="30" y="110" font-size="14" onclick="alert(2)">kept text</text></svg>';

function fixtureFiles() {
	const dir = join(repo, "target/shots/tern/fixtures");
	mkdirSync(dir, { recursive: true });
	const files = { sized: join(dir, "sized.svg"), viewbox: join(dir, "viewbox-only.svg"), unsupported: join(dir, "unsupported.svg") };
	writeFileSync(files.sized, SIZE);
	writeFileSync(files.viewbox, VIEWBOX_ONLY);
	writeFileSync(files.unsupported, UNSUPPORTED);
	return files;
}

// ---------------------------------------------------------------- child: one stage in one pane

function child() {
	const stage = process.env.TERN_DIAGRAM_STAGE ?? "mermaid";
	const cols = Number(process.env.TERN_DIAGRAM_COLS ?? 100);
	const rows = 45;
	const name = `tern-diagram-${stage}-${cols}`;
	const files = fixtureFiles();
	const listeners = new Set();
	const session = {
		state: {},
		subscribe(l) { listeners.add(l); return () => listeners.delete(l); },
		prompt: () => new Promise(() => {}),
		abort: async () => {},
		dispose() {},
		sessionManager: { getSessionId: () => "diagram-fixtures", getEntries: () => [], getBranch: () => [], getCwd: () => repo },
		model: { provider: "fixture", id: "none" },
	};
	const emit = (event) => { for (const l of [...listeners]) l(event); };
	const text = (s) => ({ type: "text", text: s });
	const answer = (body) => {
		emit({ type: "message_start", message: { role: "user", content: [text(`fixture ${stage}`)] } });
		emit({ type: "message_start", message: { role: "assistant", content: [] } });
		emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: body } });
		return body;
	};
	const settleAnswer = (body) => {
		emit({ type: "message_end", message: { role: "assistant", content: [text(body)], stopReason: "stop" } });
		emit({ type: "agent_end" });
	};

	let bridge;
	let acked = 0;
	let lastFrame = 0;
	let pending = "";
	let sawHello = false;
	let failure = "";
	const scripts = {
		mermaid() {
			const body = ["Diagrams and a table, all from one assistant answer.", "", FLOWCHART, "", SEQUENCE, "", TABLE, "", WIDE_TABLE].join("\n");
			settleAnswer(answer(body));
		},
		stream() {
			answer(STREAMING_OPEN); // no message_end: the md node stays `stream: true`
		},
		streamed() {
			answer(STREAMING_OPEN);
			settleAnswer(STREAMING_DONE);
		},
		malformed() {
			settleAnswer(answer(MALFORMED));
		},
		autograph() {
			const body = ["| Model | Pass rate | Latency |", "| --- | ---: | --- |", "| alpha | 91% | 1.2s |", "| beta | 78% | 2.4s |", "| gamma | 85% | 0.9s |"].join("\n");
			settleAnswer(answer(`Measured:\n\n${body}\n\nThose numbers come from the fixture.`));
			// Exactly what extensions/auto-graph/extension.ts sends for the first plannable table.
			const plan = planChart(parseMarkdownTables(body)[0]);
			if (!plan) return;
			const message = { role: "custom", customType: "pi-swarm-auto-graph", content: renderTextChart(plan), display: true, details: { plan, tsp: toTspChart(plan, "auto-graph-0") }, timestamp: Date.now() };
			emit({ type: "message_start", message });
			emit({ type: "message_end", message });
		},
		svg() {
			const body = answer("The generated diagram is below.");
			settleAnswer(body);
			emit({ type: "tool_execution_start", toolCallId: "svg-sized", toolName: "Read", args: { file_path: files.sized } });
			emit({ type: "tool_execution_end", toolCallId: "svg-sized", toolName: "Read", result: { content: [text(SIZE)], details: {} }, isError: false });
			emit({ type: "tool_execution_start", toolCallId: "svg-viewbox", toolName: "Read", args: { file_path: files.viewbox } });
			emit({ type: "tool_execution_end", toolCallId: "svg-viewbox", toolName: "Read", result: { content: [text(VIEWBOX_ONLY)], details: {} }, isError: false });
		},
		"svg-unsupported"() {
			const body = answer("This SVG uses features Tern's sanitizer drops.");
			settleAnswer(body);
			emit({ type: "tool_execution_start", toolCallId: "svg-unsupported", toolName: "Read", args: { file_path: files.unsupported } });
			emit({ type: "tool_execution_end", toolCallId: "svg-unsupported", toolName: "Read", result: { content: [text(UNSUPPORTED)], details: {} }, isError: false });
		},
	};

	const delay = (ms) => new Promise((r) => setTimeout(r, ms));
	// Tern acks a frame once it applied and drew it; that is the only honest "this is on screen" signal.
	async function settle(timeoutMs = 8000) {
		const target = lastFrame;
		const deadline = Date.now() + timeoutMs;
		while (acked < target && Date.now() < deadline) await delay(50);
		await delay(250); // let the ack's own paint land before the shot
		return acked >= target;
	}

	process.stdout.write(helloQuery("pi"));
	process.stdin.setRawMode(true);
	process.stdin.resume();
	process.stdin.on("data", (chunk) => {
		const parsed = splitInput(pending + chunk.toString());
		pending = parsed.rest;
		for (const msg of parsed.messages) {
			if (msg.verb === "r" && Array.isArray(msg.body.kinds) && !sawHello) {
				sawHello = true;
				ctl("resize", String(cols), String(rows));
				bridge = new PiTernBridge(session, {
					write: (data) => {
						for (const out of parseTspMessages(data)) if (out.verb === "f" && typeof out.body.s === "number") lastFrame = out.body.s;
						process.stdout.write(data);
					},
					surfaceId: "pi",
					credits: Number(msg.body.credits) || 2,
					kinds: msg.body.kinds,
				});
				bridge.start("pi");
				void (async () => {
					try {
						scripts[stage]();
						// Artifact previews are read from disk asynchronously; give them a bounded chance.
						for (let i = 0; i < 40 && bridge.items.some((item) => item.role === "tool" && !item.artifacts); i += 1) await delay(50);
						await settle();
						// The driver owns the capture: it answers `shot` once it wrote the PNG and the layout.
						writeFileSync(join(shotDir, `${name}.ready`), JSON.stringify({ stage, cols, settled: acked >= lastFrame }));
						const shotBy = Date.now() + 20_000;
						while (!existsSync(join(shotDir, `${name}.shot`)) && Date.now() < shotBy) await delay(100);
						if (!existsSync(join(shotDir, `${name}.shot`))) failure = "driver never confirmed the shot";
					} catch (error) {
						failure = error instanceof Error ? error.message : String(error);
						writeFileSync(join(shotDir, `${name}.done.json`), JSON.stringify({ stage, cols, error: failure }, null, 2));
					}
				})();
				continue;
			}
			if (msg.verb === "e" && msg.body.ev === "ack" && typeof msg.body.s === "number") acked = Math.max(acked, msg.body.s);
			bridge?.handle(msg);
		}
	});
	const stop = () => { try { process.stdin.setRawMode(false); } catch { /* not a tty */ } process.exit(failure ? 1 : 0); };
	process.on("SIGTERM", stop);
	process.on("SIGINT", stop);
	process.on("exit", () => { try { process.stdin.setRawMode(false); } catch { /* not a tty */ } });
	// Bounded lifetime: a forgotten window must not linger.
	setTimeout(stop, Number(process.env.TERN_DIAGRAM_LIFETIME_MS ?? 60_000));
	setInterval(() => {}, 1_000);
}

// ---------------------------------------------------------------- driver: one window per stage

async function driver(onlyStage, onlyCols) {
	mkdirSync(shotDir, { recursive: true });
	const stages = onlyStage ? [onlyStage] : STAGES;
	const columns = onlyCols ? [onlyCols] : COLUMNS;
	const manifest = [];
	const delay = (ms) => new Promise((r) => setTimeout(r, ms));
	for (const stage of stages) {
		for (const cols of columns) {
			const name = `tern-diagram-${stage}-${cols}`;
			const socket = `/tmp/tern-diagram-${process.pid}-${stage}-${cols}.sock`;
			const ready = join(shotDir, `${name}.ready`);
			const shotMark = join(shotDir, `${name}.shot`);
			for (const stale of [socket, ready, shotMark, join(shotDir, `${name}.done.json`)]) rmSync(stale, { force: true });
			const windowProcess = spawn("tern", ["--control", socket, "--dir", repo], {
				cwd: repo,
				env: { ...process.env },
				stdio: ["ignore", "ignore", "pipe"],
			});
			let stderr = "";
			windowProcess.stderr.on("data", (data) => { stderr += data.toString(); });
			const ctl = (...args) => spawnSync("tern", ["ctl", "--control", socket, ...args], { encoding: "utf8" });
			const openBy = Date.now() + 20_000;
			let opened = false;
			while (Date.now() < openBy) {
				const state = ctl("state");
				if (state.status === 0 && state.stdout.includes("\"ok\":true")) { opened = true; break; }
				await delay(200);
			}
			let entry = { stage, cols, name, opened };
			if (opened) {
				ctl("resize", String(cols), "45");
				const command = `TERN_DIAGRAM_CHILD=1 TERN_DIAGRAM_STAGE=${stage} TERN_DIAGRAM_COLS=${cols} ${JSON.stringify(process.execPath)} --experimental-strip-types ${JSON.stringify(fileURLToPath(import.meta.url))}`;
				const started = ctl("run", JSON.stringify(command));
				entry.run = started.stdout?.trim();
				const deadline = Date.now() + 30_000;
				while (!existsSync(ready) && Date.now() < deadline) await delay(200);
				if (existsSync(ready)) {
					const shot = ctl("shot", name);
					writeFileSync(shotMark, JSON.stringify({ at: Date.now() }));
					try { entry = { ...entry, ...JSON.parse(await readFile(ready, "utf8")), shot: JSON.parse(shot.stdout) }; }
					catch { entry.error = `shot failed: ${shot.stdout.trim().slice(0, 400)}`; }
				} else {
					entry.error = "stage never became ready";
				}
				entry.png = join(shotDir, `${name}.png`);
				entry.layout = join(shotDir, `${name}.layout.json`);
			} else {
				entry.error = `window did not open: ${stderr.trim().slice(0, 400)}`;
			}
			windowProcess.kill("SIGTERM");
			await delay(300);
			rmSync(socket, { force: true });
			manifest.push(entry);
			console.log(JSON.stringify(entry));
		}
	}
	writeFileSync(join(shotDir, "tern-diagram-manifest.json"), JSON.stringify(manifest, null, 2));
	return manifest.some((entry) => entry.error !== undefined);
}

if (process.env.TERN_DIAGRAM_CHILD === "1") child();
else {
	const argv = process.argv.slice(2);
	const argOf = (flag) => { const at = argv.indexOf(flag); return at < 0 ? undefined : argv[at + 1]; };
	const failed = await driver(argOf("--stage"), argOf("--cols") ? Number(argOf("--cols")) : undefined);
	process.exit(failed ? 1 : 0);
}
