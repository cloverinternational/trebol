/** Usage: node --experimental-strip-types .pi/lib/tern/ui-trace-report.ts [TRACE.ui.jsonl]  (default: newest in ~/.pi/agent/tern-trace) */
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { findFlicker, type TraceFrame } from "./ui-trace.ts";

const dir = join(homedir(), ".pi", "agent", "tern-trace");
const file = process.argv[2] ?? join(dir, readdirSync(dir).filter((f) => f.endsWith(".ui.jsonl")).sort().at(-1)!);
const lines = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const frames = lines.filter((l) => l.k === "frame") as TraceFrame[];
const flicker = findFlicker(frames);
console.log(`${file}\n${lines.length - frames.length} events, ${frames.length} distinct frames, ${flicker.length} flicker findings`);
const byKind = new Map<string, number>();
for (const f of flicker) byKind.set(`${f.kind} ${f.role}`, (byKind.get(`${f.kind} ${f.role}`) ?? 0) + 1);
for (const [k, n] of byKind) console.log(`  ${n}× ${k}`);
for (const f of flicker.slice(0, 40)) console.log(`${new Date(f.at).toISOString().slice(11, 23)} ${f.kind.padEnd(18)} ${f.id.padEnd(22)} ${f.detail}`);
