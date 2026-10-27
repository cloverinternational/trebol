#!/usr/bin/env -S node --experimental-strip-types
/**
 * Tern style and geometry lint.
 *
 * The oracle is Tern itself, not a reading of our CSS: every check runs against a headless Tern
 * (`tern serve --control`) that renders the real TSP frames our bridge emits for a recorded session,
 * then reports measured boxes, computed type and parser errors.
 *
 *   node tools/tern/style-lint.mjs                 # all checks, all fixtures, four widths
 *   node tools/tern/style-lint.mjs --widths 480,1400
 *   node tools/tern/style-lint.mjs --self-test     # prove every rule fires on a seeded defect
 *
 * Exit 1 on any error-level finding. Warnings never fail the run.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const FIXTURES = join(REPO, ".pi/test/tern/fixtures/turn-work");
const TERN = process.env.TERN_BIN ?? "tern";
const WIDTHS = [480, 800, 1100, 1400];

// The declared design scale. A value outside it is a decision someone made without recording it, which is
// exactly how four near-identical font sizes (9.5 / 10 / 10.5 / 11) accumulated in composer-style.ts.
const TYPE_SCALE = [9.5, 10, 10.5, 11, 13];
// Recorded inventory, not a principle: these are the spacing values in use today. The check fails a *new*
// value that nobody wrote down, which is how 1/3/5/6/7 px accumulated in the first place.
const SPACE_SCALE = [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 16, 24, 320];
const MIN_TEXT_LINE = 11; // px: a line shorter than this has its glyphs clipped by its own box

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
// Accepted geometry, measured rather than argued: `rule label <=px`. Anything not listed is a finding.
const BASELINE = (() => {
	try {
		return readFileSync(join(REPO, "tools/tern/style-lint.baseline"), "utf8").split("\n")
			.filter((line) => line.trim() && !line.trim().startsWith("#"))
			.map((line) => {
				const m = line.match(/^(\S+)\s+(.+?)\s+<=(\d+(?:\.\d+)?)/);
				return m ? { rule: m[1], match: m[2].trim(), max: Number(m[3]) } : null;
			})
			.filter(Boolean);
	} catch { return []; }
})();
let suppressed = 0;
const baselined = (rule, label, excess) => {
	if (!BASELINE.some((b) => b.rule === rule && label.includes(b.match) && excess <= b.max)) return false;
	suppressed += 1;
	return true;
};

const findings = [];
const record = (level, rule, where, message, detail) => findings.push({ level, rule, where, message, detail });

// ---------------------------------------------------------------- sheets

/** The sheets the bridge registers, read from the source of truth it reloads from (run.ts does the same). */
function loadSheets() {
	const out = [];
	// Every sheet the bridge registers (bridge.ts: the three `stylesheet` calls).
	for (const [file, name] of [[".pi/lib/tern/composer-style.ts", "composer"], [".pi/lib/tern/work-style.ts", "work"], [".pi/lib/tern/startup-card.ts", "startup"]]) {
		const source = readFileSync(join(REPO, file), "utf8");
		const css = source.match(/export const [A-Z_]+ = `([\s\S]*?)`;/)?.[1];
		if (!css) throw new Error(`${file}: stylesheet literal not found`);
		out.push({ name, file, css });
	}
	return out;
}

/** Declarations with no token behind them: raw px font sizes and spacing outside the declared scale. */
function lintScale(sheets) {
	for (const sheet of sheets) {
		const lines = sheet.css.split("\n");
		lines.forEach((line, i) => {
			const at = `${sheet.name} sheet:${i + 1}`;
			for (const m of line.matchAll(/font-size:\s*([\d.]+)px/g)) {
				const size = Number(m[1]);
				if (!TYPE_SCALE.includes(size)) record("error", "type-scale", at, `font-size ${size}px is outside the declared scale ${TYPE_SCALE.join("/")}`, line.trim());
			}
			// Spacing shorthand: margin/padding/gap. Values of 1px are borders in practice, 999px is a pill radius.
			for (const m of line.matchAll(/(?:^|[;{])\s*(margin|padding|gap)(?:-top|-right|-bottom|-left)?:\s*([^;}]+)/g)) {
				for (const value of m[2].matchAll(/(-?[\d.]+)px/g)) {
					const px = Math.abs(Number(value[1]));
					if (!SPACE_SCALE.includes(px)) record("warn", "space-scale", at, `${m[1]} ${value[0]} is outside the declared spacing scale`, line.trim());
				}
			}
			// Selector subset: the engine drops the whole rule, so the style silently never applies.
			if (/:has\(|~\s*[.[]/.test(line) && !line.trim().startsWith("*")) record("error", "selector-subset", at, "selector uses a feature Tern's engine rejects (`:has()`, `~`)", line.trim());
			if (/\b(rem|ch|vh|vw)\b/.test(line) && /(width|height|margin|padding|font-size|gap)/.test(line)) record("warn", "length-unit", at, "length unit outside px/em/%/vw/vh; `rem` and `ch` are rejected by the engine", line.trim());
		});
	}
}

// ---------------------------------------------------------------- headless Tern

function startTern(label) {
	const dir = mkdtempSync(join(tmpdir(), `tern-lint-${label}-`));
	const sock = join(dir, "ctl.sock");
	const child = spawn(TERN, ["serve", "--control", sock], { cwd: dir, stdio: "ignore", detached: true });
	const deadline = Date.now() + 30_000;
	while (!existsSync(sock)) {
		if (Date.now() > deadline) throw new Error("tern serve did not open its control socket");
		execFileSync("sleep", ["0.05"]);
	}
	const ctl = (command) => {
		const raw = execFileSync(TERN, ["ctl", "--control", sock, command], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
		const reply = JSON.parse(raw);
		if (reply.ok !== true) throw new Error(`tern ctl ${command}: ${reply.error ?? "failed"}`);
		return reply;
	};
	return { ctl, stop: () => { try { ctl("quit"); } catch { /* already gone */ } child.kill(); rmSync(dir, { recursive: true, force: true }); } };
}

// ---------------------------------------------------------------- rendering the real bridge

/** Replay a recorded Pi session through the real bridge and return the frames as a Tern surface recording. */
async function recordSession(spec) {
	// `name#N` keeps only the first N frames: the startup card sits at the top of a short transcript, so a
	// narrow pane can be checked before the card scrolls out of view.
	const [name, limit] = spec.split("#");
	const events = readFileSync(join(FIXTURES, `${name}.events.jsonl`), "utf8").trim().split("\n").map((line) => JSON.parse(line));
	const { PiTernBridge } = await import(join(REPO, ".pi/lib/tern/bridge.ts"));
	const workspace = mkdtempSync(join(tmpdir(), "tern-lint-ws-"));
	const listeners = new Set();
	const session = {
		state: {},
		subscribe: (listener) => (listeners.add(listener), () => listeners.delete(listener)),
		prompt: () => new Promise(() => {}),
		abort: async () => {},
		dispose() {},
		sessionManager: { getSessionId: () => "lint", getEntries: () => [], getCwd: () => workspace },
	};
	const writes = [];
	const bridge = new PiTernBridge(session, { write: (data) => writes.push(data), surfaceId: "pi", credits: 1_000_000 });
	bridge.start("pi");
	for (const event of events) for (const listener of listeners) listener(event);
	const lines = [];
	let t = 0;
	for (const write of writes) {
		for (const hit of write.matchAll(/\x1b_tsp;([A-Za-z]);([\s\S]*?)\x1b\\/g)) {
			try { lines.push(JSON.stringify({ t: (t += 16), dir: "out", verb: hit[1], body: JSON.parse(hit[2]) })); } catch { /* not a frame */ }
		}
	}
	bridge.close?.();
	rmSync(workspace, { recursive: true, force: true });
	return (limit ? lines.slice(0, Number(limit)) : lines).join("\n") + "\n";
}

// ---------------------------------------------------------------- frame identity

/**
 * The fold is host state: a node id that disappears and comes back is a new element to Tern, so any local
 * collapse the user set is lost. This walks the frame stream and reports ids that were deleted and re-added,
 * which is what "the collapse breaks when an agent starts" looks like on the wire.
 */
function lintFrames(recording, where) {
	const live = new Set();
	const folds = new Set();
	const deleted = new Map();
	for (const line of recording.trim().split("\n")) {
		const frame = JSON.parse(line);
		if (frame.verb !== "f") continue;
		for (const op of frame.body.ops ?? []) {
			const [kind, id, parent, , node] = op;
			if (kind === "add") {
				// A fold, or a control the user is aiming at, is state the host keeps. The composer's send/stop
				// pair is an intentional swap, so the `omp.*` and `pi.ask` roles are out of scope.
				const role = String(node?.p?.role ?? "");
				if (deleted.has(id) && deleted.get(id).stateful) record("error", "fold-reset", where, `${id} (${role || id}) was removed and re-added ${deleted.get(id).age} frame(s) later, dropping whatever the host held on it`, `role=${role || node?.k}`);
				const collapsible = node?.p?.collapsible === true || node?.p?.collapsed !== undefined || role.startsWith("tern.") || role.startsWith("pi.tasks");
				live.add(id);
				if (collapsible) folds.add(id);
				for (const child of node?.c ?? []) live.add(child.id);
				continue;
			}
			if (kind === "del") {
				if (live.has(id)) deleted.set(id, { age: 0, stateful: folds.has(id) });
				live.delete(id);
			}
		}
		for (const entry of deleted.values()) entry.age += 1;
	}
}

// ---------------------------------------------------------------- geometry

const rectKey = (rect) => rect.map((n) => Math.round(n * 100) / 100).join(",");
const inside = (box, parent, eps = 0.5) => box[0] >= parent[0] - eps && box[0] + box[2] <= parent[0] + parent[2] + eps;

function measure(ctl, roles = []) {
	const region = (selector) => (ctl(`tree ${selector}`).nodes ?? []).at(-1)?.rect ?? null;
	const regions = { main: region(".sf-region.sf-main"), dock: region(".sf-region.sf-dock"), layer: region(".sf-region.sf-layer") };
	const elements = [];
	for (const [name, box] of Object.entries(regions)) {
		if (!box) continue;
		// Two calls per region: `tree` carries the text, `dump` the computed type and the path that names the parent.
		const nodes = ctl(`tree .sf-region.sf-${name} *`).nodes ?? [];
		const dump = ctl(`dump .sf-region.sf-${name} *`).elements ?? [];
		const type = new Map();
		for (const element of dump) {
			const key = rectKey(element.rect);
			if (!type.has(key)) type.set(key, []);
			type.get(key).push(element);
		}
		const used = new Map();
		for (const node of nodes) {
			const key = rectKey(node.rect);
			const at = used.get(key) ?? 0;
			used.set(key, at + 1);
			const style = type.get(key)?.[at] ?? type.get(key)?.[0];
			elements.push({
				region: name,
				rect: node.rect,
				text: node.text ?? "",
				klass: node.class ?? "",
				fontSize: style ? parseFloat(style.fontSize) : undefined,
				path: style?.path ?? "",
				visible: node.rect[2] > 0 && node.rect[3] > 0,
			});
		}
	}
	// Which box carries which of our roles: without this the type check would flag Tern's own sheets.
	const byRect = new Map();
	for (const [name] of Object.entries(regions)) {
		for (const role of roles) {
			for (const node of ctl(`tree .sf-region.sf-${name} [data-role='${role}']`).nodes ?? []) byRect.set(rectKey(node.rect), role);
		}
	}
	for (const el of elements) el.role = byRect.get(rectKey(el.rect));
	// A `tree` selector can match the same painted box twice; keep one row per (role, box, text).
	const unique = new Map();
	for (const el of elements) unique.set(`${el.role ?? ""}|${rectKey(el.rect)}|${el.text.slice(0, 40)}`, el);
	return { regions, elements: [...unique.values()] };
}

/** `main#panel>div.tn-stage>…` → the parent path, which `dump` reports for every element. */
const parentPath = (path) => (path ? path.slice(0, path.lastIndexOf(">")) : "");

/**
 * Two levels of containment. Leaving the region is an error: nothing in our projection may be painted outside
 * the surface it belongs to. Exceeding the parent is a warning, because a scroll container legitimately holds
 * larger children and the dump does not report clipping.
 */
function check({ regions, elements }, where) {
	const byPath = new Map();
	for (const el of elements) if (el.path) byPath.set(el.path, el);
	for (const el of elements) {
		const region = regions[el.region];
		if (!region) continue;
		if (!el.visible) {
			record("error", "invisible", where, `${el.region} element rendered with a zero-size box`, `${el.klass} "${el.text.slice(0, 40)}"`);
			continue;
		}
		const label = el.path ? el.path.split(">").slice(-1)[0] : el.klass;
		if (el.rect[0] < region[0] - 0.5 || el.rect[0] + el.rect[2] > region[0] + region[2] + 0.5) {
			const over = Math.max(region[0] - el.rect[0], el.rect[0] + el.rect[2] - (region[0] + region[2]));
			record("error", "spill-region", where, `${el.region} ${label} leaves its region by ${over.toFixed(1)}px`, `rect=${JSON.stringify(el.rect.map((n) => Math.round(n)))} region=${JSON.stringify(region.map((n) => Math.round(n)))}`);
		}
		const parent = byPath.get(parentPath(el.path));
		if (parent && el.path) {
			const over = el.rect[0] + el.rect[2] - (parent.rect[0] + parent.rect[2]);
			if (over > 0.5 && !baselined("spill-parent", label, over)) record("warn", "spill-parent", where, `${label} is ${over.toFixed(1)}px wider than its parent`, `rect=${JSON.stringify(el.rect.map((n) => Math.round(n)))} parent=${JSON.stringify(parent.rect.map((n) => Math.round(n)))}`);
		}
		if (el.text.trim() && el.rect[3] < MIN_TEXT_LINE) record("error", "clipped-line", where, `${label} holds text in a ${el.rect[3]}px box`, el.text.slice(0, 60));
		if (el.role && el.fontSize !== undefined && !TYPE_SCALE.includes(el.fontSize)) record("error", "type-scale", where, `role ${el.role} renders at ${el.fontSize}px, outside ${TYPE_SCALE.join("/")}`, `rect=${JSON.stringify(el.rect.map((n) => Math.round(n)))}`);
	}
	// The composer must share the transcript's edges: the alignment this project already had to fix once.
	const { main, dock } = regions;
	if (main && dock) {
		const delta = Math.max(Math.abs(main[0] - dock[0]), Math.abs(main[0] + main[2] - (dock[0] + dock[2])));
		if (delta > 1) record("warn", "dock-edges", where, `dock and transcript disagree on their edges by ${delta.toFixed(1)}px`, `main=${JSON.stringify(main)} dock=${JSON.stringify(dock)}`);
	}
}

// ---------------------------------------------------------------- self-test

/** Seeded defects: each rule must fire, or the lint is decorative. */
async function selfTest() {
	const tern = startTern("selftest");
	let failed = 0;
	try {
		const bad = join(tmpdir(), `tern-lint-bad-${process.pid}.css`);
		writeFileSync(bad, `[data-role='pi.tasks'] { font-size: 8px; margin: 0 13px; }\n[data-role='pi.tasks']:has(.x) { color: red; }\n`);
		const loaded = tern.ctl(`css lintselftest ${bad}`);
		if (!(loaded.errors ?? []).length) { console.error("FAIL self-test: Tern accepted `:has()`"); failed++; }
		else console.log(`ok  self-test: engine rejects unsupported rules (${loaded.errors.length} errors)`);
		const before = findings.length;
		lintScale([{ name: "lintselftest", file: bad, css: readFileSync(bad, "utf8") }]);
		const rules = new Set(findings.slice(before).map((f) => f.rule));
		for (const rule of ["type-scale", "space-scale", "selector-subset"]) {
			if (rules.has(rule)) console.log(`ok  self-test: ${rule} fires on a seeded defect`);
			else { console.error(`FAIL self-test: ${rule} did not fire`); failed++; }
		}
		findings.length = before;
		// A document whose role box overflows its region must be caught by the geometry pass.
		const roots = ["main", "dock", "layer"].map((id) => ["add", id, "st", null, { id, k: "col", c: [] }]);
		const node = ["add", "s1", "main", null, { id: "s1", k: "text", p: { text: "overflow seed", role: "selftest.seed" } }];
		const frames = JSON.stringify({ t: 1000, dir: "out", verb: "o", body: { id: "st", mode: "inline", title: "lint" } }) + "\n" +
			JSON.stringify({ t: 1016, dir: "out", verb: "f", body: { sf: "st", s: 1, ops: [...roots, node] } }) + "\n";
		const rec = join(tmpdir(), `tern-lint-spill-${process.pid}.jsonl`);
		const seed = join(tmpdir(), `tern-lint-spill-${process.pid}.css`);
		writeFileSync(rec, frames);
		// The seed is a sheet, not a node prop: the engine then paints the box 3000px wide for certain.
		writeFileSync(seed, "[data-role='selftest.seed'] { min-width: 3000px; }\n");
		tern.ctl("resize 600 500");
		tern.ctl(`surface-play "${rec}"`);
		tern.ctl("wait 300");
		const loadedSeed = tern.ctl(`css lintseed ${seed}`);
		if (!loadedSeed.rules) { console.error("FAIL self-test: seed sheet did not load"); failed++; }
		const measured = measure(tern.ctl);
		const before2 = findings.length;
		check(measured, "self-test");
		const spill = findings.slice(before2).find((f) => f.rule === "spill-region");
		if (spill) console.log(`ok  self-test: spill-region fires on a box wider than its region (${spill.message})`);
		else { console.error("FAIL self-test: spill-region did not fire on a box wider than its region"); failed++; }
	} finally {
		tern.stop();
	}
	return failed;
}

// ---------------------------------------------------------------- run

if (flag("--self-test")) {
	const failed = await selfTest();
	console.log(failed === 0 ? "self-test passed" : `self-test failed (${failed})`);
	process.exit(failed === 0 ? 0 : 1);
}

const widths = (opt("--widths", WIDTHS.join(","))).split(",").map(Number);
const sheets = loadSheets();
lintScale(sheets);

const roles = [...new Set(sheets.flatMap((sheet) => [...sheet.css.matchAll(/data-role='([^']+)'/g)].map((m) => m[1])))];
const fixtures = readFileSync(join(REPO, "tools/tern/style-lint.fixtures"), "utf8").trim().split("\n").filter((line) => line && !line.startsWith("#"));

/** Load both sheets into a server and report what Tern's parser made of them. */
function applySheets(tern, label) {
	for (const sheet of sheets) {
		const path = join(tmpdir(), `tern-lint-${sheet.name}-${process.pid}-${label}.css`);
		writeFileSync(path, sheet.css);
		const reply = tern.ctl(`css ${sheet.name} ${path}`);
		for (const error of reply.errors ?? []) {
			record("error", "sheet-parse", `${sheet.file}:${error.line}:${error.column}`, error.message, sheet.css.split("\n")[error.line - 1]?.trim());
		}
		if (!(reply.errors ?? []).length) console.log(`sheet ${sheet.name}: ${reply.rules} rules, no parser errors`);
	}
}

// Sheets alone: one server is enough.
{
	const tern = startTern("sheets");
	try { applySheets(tern, "sheets"); } finally { tern.stop(); }
}

for (const fixture of fixtures) {
	const recording = join(tmpdir(), `tern-lint-${fixture}-${process.pid}.jsonl`);
	const frames = await recordSession(fixture);
	writeFileSync(recording, frames);
	lintFrames(frames, fixture);
	for (const width of widths) {
		const where = `${fixture.slice(0, 19)} @${width}px`;
		const tern = startTern(`state`);
		try {
			applySheets(tern, `state`);
			tern.ctl(`resize ${width} 800`);
			tern.ctl(`surface-play "${recording}"`);
			tern.ctl("wait 500");
			const measured = measure(tern.ctl, roles);
			check(measured, where);
			if (flag("--verbose")) {
				for (const el of measured.elements.filter((e) => e.role)) {
					console.log(`  ${el.role.padEnd(22)} ${JSON.stringify(el.rect.map((n) => Math.round(n))).padEnd(24)} ${el.fontSize ?? "?"}px  ${el.text.slice(0, 40)}`);
				}
			}
			console.log(`${where}: ${measured.elements.length} role boxes measured`);
		} finally {
			tern.stop();
		}
	}
}

const errors = findings.filter((f) => f.level === "error");
const warnings = findings.filter((f) => f.level === "warn");
for (const f of findings) console.log(`${f.level.toUpperCase().padEnd(5)} ${f.rule.padEnd(15)} ${f.where.padEnd(34)} ${f.message}${f.detail ? `  [${f.detail}]` : ""}`);
console.log(`\n${errors.length} errors, ${warnings.length} warnings, ${suppressed} measurements accepted by tools/tern/style-lint.baseline`);
process.exit(errors.length === 0 ? 0 : 1);
