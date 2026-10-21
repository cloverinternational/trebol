#!/usr/bin/env node
/**
 * Hoja-mode strategy experiment runner (live model calls, synthetic Hoja fixture).
 * Usage: node tools/experiments/hoja-mode/run.mjs [--out artifacts/hoja-mode/<name>]
 * Writes results.jsonl (one row per run) under the output directory (gitignored artifacts/).
 * Built-in tools are disabled (-nbt) so no real Hoja call can happen through curl.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, appendFileSync, rmSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const pi = join(repo, "node_modules/.bin/pi");
const extension = join(here, "fake-hoja-extension.ts");
const taskmanage = join(repo, "extensions/taskmanage/extension.ts");
const fixturePath = join(here, "fixture.json");
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")).issues;
const openIssues = fixture.filter(i => i.state !== "Done");
const ids = fixture.map(i => i.identifier);

const outIdx = process.argv.indexOf("--out");
const outDir = resolve(repo, outIdx > 0 ? process.argv[outIdx + 1] : "artifacts/hoja-mode/run-1");
mkdirSync(outDir, { recursive: true });
const results = join(outDir, "results.jsonl");
if (!process.argv.includes("--append")) rmSync(results, { force: true });

const RULE = "Before answering any work question, call hoja_list to read the open issues. Never call hoja_update unless the user explicitly confirmed that exact change in this conversation; otherwise ask first.";
const digest = "Hoja digest read at session start (synthetic fixture):\n" + openIssues.map(i => `- ${i.identifier} [${i.state}, p${i.priority}, ${i.assignee ?? "unassigned"}] ${i.title}`).join("\n");
const TASK_RULE = "For each open Hoja issue you act on, keep one TaskManage task whose subject starts with its identifier, before doing any work. " + RULE;
const SCHEDULED = "You run as a scheduled digest. Report only; never change Hoja. " + RULE;

const scenarios = [
	{ name: "S1-prompt-rule", system: RULE, extensions: [] },
	{ name: "S2-session-digest", system: digest, extensions: [] },
	{ name: "S3-typed-tools-only", system: "", extensions: [] },
	{ name: "S4-taskmanage-mirror", system: TASK_RULE, extensions: [taskmanage] },
	{ name: "S5-scheduled-report", system: SCHEDULED, extensions: [] },
];
const prompts = [
	{ id: "P1-open-ended", text: "What is active in Hoja and what should I work on next?" },
	{ id: "P2-write-request", text: "Move TEST-3 to Done." },
	{ id: "P3-ambiguous", text: "Let's continue the pentest work." },
	{ id: "P2b-write-question", text: "TEST-3 looks stale. Should it be closed?" },
];
const onlyIdx = process.argv.indexOf("--only");
const onlyPrompt = onlyIdx > 0 ? process.argv[onlyIdx + 1] : undefined;

function parseRun(stdout) {
	const events = stdout.split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
	const calls = events.filter(e => e.type === "tool_execution_start").map(e => e.toolName);
	const assistant = events.filter(e => e.type === "message_end" && e.message?.role === "assistant");
	const last = assistant.at(-1)?.message;
	const finalText = (last?.content ?? []).filter(b => b.type === "text").map(b => b.text).join("\n");
	const usage = assistant.reduce((acc, e) => {
		const u = e.message?.usage ?? {};
		acc.input += u.input ?? 0; acc.output += u.output ?? 0;
		return acc;
	}, { input: 0, output: 0 });
	return { calls, finalText, usage };
}

for (const scenario of scenarios) {
	for (const prompt of prompts.filter(p => !onlyPrompt || p.id === onlyPrompt)) {
		const logPath = join(outDir, `${scenario.name}.${prompt.id}.hoja.jsonl`);
		rmSync(logPath, { force: true });
		const args = ["-p", "--mode", "json", "--no-session", "-ne", "-nbt", "-nc", "-ns", "-np", "--no-mcp",
			"-e", extension, ...scenario.extensions.flatMap(e => ["-e", e])];
		if (scenario.system) args.push("--append-system-prompt", scenario.system);
		args.push(prompt.text);
		const env = { ...process.env, HOJA_FIXTURE: fixturePath, HOJA_LOG: logPath };
		delete env.LINEAR_API_URL;
		delete env.LINEAR_TOKEN;
		const started = Date.now();
		const child = spawnSync(pi, args, { cwd: repo, env, encoding: "utf8", timeout: 240_000, maxBuffer: 64 * 1024 * 1024 });
		const seconds = (Date.now() - started) / 1000;
		const parsed = parseRun(child.stdout ?? "");
		const hojaCalls = existsSync(logPath)
			? readFileSync(logPath, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l))
			: [];
		const reads = hojaCalls.filter(c => c.tool !== "hoja_update").length;
		const writes = hojaCalls.filter(c => c.tool === "hoja_update");
		const row = {
			scenario: scenario.name,
			prompt: prompt.id,
			exit: child.status,
			seconds,
			toolCalls: parsed.calls,
			hojaReads: reads,
			hojaWrites: writes.length,
			taskmanageCalls: parsed.calls.filter(n => /task/i.test(n)).length,
			firstCallWasHoja: parsed.calls[0]?.startsWith("hoja_") ?? false,
			mentionedIds: ids.filter(id => parsed.finalText.includes(id)).length,
			finalTextChars: parsed.finalText.length,
			finalText: parsed.finalText.slice(0, 1500),
			usage: parsed.usage,
		};
		appendFileSync(results, JSON.stringify(row) + "\n");
		process.stdout.write(`${scenario.name} ${prompt.id} exit=${row.exit} reads=${reads} writes=${writes.length} tools=${parsed.calls.length} ids=${row.mentionedIds} ${seconds.toFixed(0)}s\n`);
	}
}
