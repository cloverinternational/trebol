// Tern replacement for `pi -r`: /tern-resume opens a native picker of this project's sessions and switches the
// live session through the command context. Candidate logic and the switch-and-verify step live in
// .pi/lib/tern/session-resume.ts; this file owns the picker and its lazy loading. The picker opens from the
// newest sessions only (SessionManager.list parses every file, which is slow on large histories); the full list
// loads only when the user asks for older sessions.
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resumeCandidates, resumeSession, type ResumeCandidate, type ResumeSessionRecord } from "../../.pi/lib/tern/session-resume.ts";

const FIRST_PAGE = 10;
const SHOW_ALL = "Show all sessions (slower)…";

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((b) => (b && typeof b === "object" && (b as { type?: unknown }).type === "text" ? String((b as { text?: unknown }).text ?? "") : "")).join(" ");
}

function recordOf(manager: SessionManager, modified: Date): ResumeSessionRecord {
	const entries = manager.getEntries();
	const messages = entries.filter((e) => e.type === "message");
	const firstUser = messages.find((e) => e.type === "message" && e.message.role === "user");
	return {
		path: manager.getSessionFile() ?? "",
		id: manager.getSessionId(),
		cwd: manager.getCwd(),
		name: manager.getSessionName(),
		modified,
		messageCount: messages.length,
		firstMessage: firstUser && firstUser.type === "message" ? textOf(firstUser.message.content) : "",
	};
}

// Opens the newest sessions for this cwd, skipping the current one. Cost is bounded by the page size.
async function firstPage(sessionDir: string, cwd: string, currentPath: string | undefined): Promise<{ records: ResumeSessionRecord[]; hasMore: boolean }> {
	const names = (await readdir(sessionDir)).filter((f) => f.endsWith(".jsonl"));
	const files = await Promise.all(names.map(async (f) => {
		const path = join(sessionDir, f);
		return { path, modified: (await stat(path)).mtime };
	}));
	files.sort((a, b) => b.modified.getTime() - a.modified.getTime());
	const records: ResumeSessionRecord[] = [];
	let scanned = 0;
	for (const file of files) {
		if (records.length >= FIRST_PAGE) break;
		scanned++;
		if (file.path === currentPath) continue;
		const manager = SessionManager.open(file.path, sessionDir);
		if (manager.getCwd() !== cwd) continue;
		records.push(recordOf(manager, file.modified));
	}
	return { records, hasMore: scanned < files.length };
}

function labelsOf(candidates: ResumeCandidate[]): string[] {
	return candidates.map((c, i) => `${i + 1}. ${c.title} (${c.messageCount} messages, ${new Date(c.modified).toLocaleString()})`);
}

export default function ternResume(pi: ExtensionAPI): void {
	pi.registerCommand("tern-resume", {
		description: "Resume another session from this project",
		handler: async (_args, ctx) => {
			const { ui, sessionManager } = ctx;
			const cwd = sessionManager.getCwd();
			const sessionDir = sessionManager.getSessionDir();
			const currentPath = sessionManager.getSessionFile();

			const first = await firstPage(sessionDir, cwd, currentPath);
			let candidates = resumeCandidates(first.records, currentPath);
			let hasMore = first.hasMore;
			let choice: string | undefined;
			let selected: ResumeCandidate | undefined;
			for (;;) {
				if (candidates.length === 0 && !hasMore) return void ui.notify("No other sessions in this project", "info");
				const labels = labelsOf(candidates);
				const options = hasMore ? [...labels, SHOW_ALL] : labels;
				choice = await ui.select("Resume session", options);
				if (choice === undefined) return void ui.notify("Resume cancelled", "info");
				if (choice !== SHOW_ALL) {
					selected = candidates[labels.indexOf(choice)];
					break;
				}
				ui.notify("Loading all sessions…", "info");
				candidates = resumeCandidates(await SessionManager.list(cwd, sessionDir), currentPath);
				hasMore = false;
			}
			if (!selected) return;
			const outcome = await resumeSession(ctx, selected.path, async (next) => {
				next.ui.notify(`Resumed: ${selected.title}`, "info");
			});
			if (outcome.status === "not-applied") ui.notify("Session was not switched", "error");
		},
	});
}
