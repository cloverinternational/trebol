// Presentation only: these parsers never decide runtime success or execute output.
import { closeSync, openSync, readSync, fstatSync } from "node:fs";
import { createHash } from "node:crypto";

const OUTPUT_BYTES = 64 * 1024;
export interface FormattedOutput { raw: string; text: string; kind: "plain" | "ansi" | "json"; note?: string; diagnostics: Array<{ text: string; tone: "error" | "warning" }> }

export function safeWorkText(value: string, sgr = false): string {
	// Remove OSC/APC/DCS payloads, including unfinished control strings at the tail.
	const clean = value.replace(/\x1b(?:\]|P|_|\^)[\s\S]*?(?:\x07|\x1b\\|$)/g, "")
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, (s) => sgr && /^\x1b\[[\d;]*m$/.test(s) ? s : "")
		.replace(/\x1b\[[\d;?]*$/g, "")
		.replace(/\x1b(?!\[)[\s\S]?/g, "").replace(/[\x00-\x08\x0b\x0c\x0e-\x1a\x1c-\x1f\x7f-\x9f]/g, "");
	return clean
		.replace(/((?:api[_-]?key|token|password|secret|authorization)["']?\s*[:=]\s*)(["'])(?:\\.|(?!\2)[^\r\n])*?\2/gi, "$1\"[redacted]\"")
		.replace(/\b(Bearer|Basic)\s+[^\s"',;]+/gi, "$1 [redacted]")
		.replace(/((?:api[_-]?key|token|password|secret|authorization)\s*["']?\s*[:=]\s*["']?)[^\s"',;}]+/gi, "$1[redacted]")
		.replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[redacted]@");
}

export function formatBackgroundOutput(value: string): FormattedOutput {
	// Bound before parsing and regex passes; report loss rather than treating a tail as full JSON.
	const truncated = value.length > OUTPUT_BYTES;
	const bounded = truncated ? value.slice(-OUTPUT_BYTES) : value;
	const raw = safeWorkText(bounded);
	const ansi = safeWorkText(bounded, true).replace(/\r\n/g, "\n").split("\n").map((line) => line.split("\r").at(-1) ?? "").join("\n");
	const plain = safeWorkText(ansi);
	const lines = plain.split("\n");
	const notes: string[] = truncated ? ["Earlier output omitted; showing the last 64 Ki characters."] : [];
	let kind: FormattedOutput["kind"] = /\x1b\[[\d;]*m/.test(ansi) ? "ansi" : "plain";
	let text = kind === "ansi" ? ansi : plain;
	if (!truncated && /^[\s]*[\[{]/.test(plain)) {
		try {
			const value = JSON.parse(plain);
			// Traverse only to check depth; stringify a bounded input, never arbitrary objects.
			const pending: Array<[unknown, number]> = [[value, 0]];
			while (pending.length) {
				const [entry, depth] = pending.pop()!;
				if (depth > 24) throw new Error("depth");
				if (entry && typeof entry === "object") for (const child of Object.values(entry)) pending.push([child, depth + 1]);
			}
			text = JSON.stringify(value, null, 2); kind = "json";
		} catch { notes.push("Not a complete supported JSON value; showing text."); }
	}
	if (text.length > OUTPUT_BYTES) { text = text.slice(0, OUTPUT_BYTES); notes.push("Formatted output clipped to 64 Ki characters."); }
	const diagnostics = lines.filter((line) => /^(?:\[[^\]]{1,40}\]\s*)?(?:error|fatal|warning|warn|FAIL|ERROR)\b[:\s]/i.test(line.trim())).slice(-8).map((line) => ({ text: line.slice(0, 400), tone: /\bwarn(?:ing)?\b/i.test(line) ? "warning" as const : "error" as const }));
	return { raw, text, kind, note: notes.join(" ") || undefined, diagnostics };
}

export interface AgentTimelineStep { id: string; role: "user" | "assistant" | "tool"; title: string; text: string; error?: boolean }
export interface AgentTimeline { steps: AgentTimelineStep[]; unavailable?: boolean; truncated?: boolean }

export function parseAgentTimeline(lines: readonly string[]): AgentTimelineStep[] {
	const steps: AgentTimelineStep[] = [];
	for (const line of lines.slice(-200)) {
		if (line.length > OUTPUT_BYTES * 2) continue;
		let record: any; try { record = JSON.parse(line); } catch { continue; }
		const m = record?.message;
		if (record.type !== "message" || !m || !["user", "assistant", "toolResult"].includes(m.role)) continue;
		const parts = typeof m.content === "string" ? [{ type: "text", text: m.content }] : Array.isArray(m.content) ? m.content : [];
		const texts = parts.filter((p: any) => p?.type === "text" && typeof p.text === "string").map((p: any) => p.text).filter((s: string) => !/^\s*(?:<system-reminder|\[SCHEDULED\]|## MCP Context|## Current Tasks)/.test(s));
		const calls = parts.filter((p: any) => p?.type === "toolCall" && typeof p.name === "string").map((p: any) => safeWorkText(p.name).slice(0, 100));
		const body = texts.join("\n").trim();
		if (!body && !calls.length) continue;
		const role = m.role === "toolResult" ? "tool" : m.role;
		const id = String(record.id ?? createHash("sha256").update(line).digest("hex").slice(0, 16));
		const text = safeWorkText(body.slice(0, 12000)) + (body.length > 12000 ? "\n\n… message truncated …" : "");
		steps.push({ id, role, title: role === "tool" ? safeWorkText(String(m.toolName ?? "Tool result")) : role === "user" ? "Assignment" : calls.length ? `Assistant · ${calls.join(", ")}` : "Assistant", text: text || `Called ${calls.join(", ")}`, error: m.isError === true });
	}
	return steps.slice(-60);
}

const cache = new Map<string, { signature: string; value: AgentTimeline }>();
export function readAgentTimeline(path: string): AgentTimeline {
	let fd: number | undefined;
	try {
		fd = openSync(path, "r"); const stat = fstatSync(fd);
		if (!stat.isFile()) return { steps: [], unavailable: true };
		const signature = `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
		if (cache.get(path)?.signature === signature) return cache.get(path)!.value;
		const length = Math.min(stat.size, 512 * 1024); const buffer = Buffer.alloc(length);
		const read = readSync(fd, buffer, 0, length, stat.size - length);
		const lines = buffer.subarray(0, read).toString("utf8").split("\n");
		if (stat.size > length) lines.shift();
		const steps = parseAgentTimeline(lines);
		const value = { steps, truncated: stat.size > length || lines.length > 60 || lines.some((l) => l.length > OUTPUT_BYTES * 2) };
		if (cache.size >= 32) cache.delete(cache.keys().next().value!);
		cache.set(path, { signature, value }); return value;
	} catch { return { steps: [], unavailable: true }; }
	finally { if (fd !== undefined) closeSync(fd); }
}
