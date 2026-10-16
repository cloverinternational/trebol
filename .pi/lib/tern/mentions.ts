// @-mention semantics for the Tern composer: parse `@path` tokens (OMP's grammar), resolve them inside the
// workspace, and build the prompt block Pi receives. Pure file-system logic; no TUI types.
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const MENTION_REGEX = /@(?:"([^"]+)"|'([^']+)'|([^\s@]+))/g;
const LEADING_PUNCTUATION = /^[`"'([{<]+/;
const TRAILING_PUNCTUATION = /[)\]}>.,;:!?"'`]+$/;
const BOUNDARY = /[\s([{<"'`]/;

export const MENTION_LIMITS = { maxMentions: 20, maxFileBytes: 200 * 1024, maxDirEntries: 500 } as const;
const SKIPPED_DIRS = new Set([".git", "node_modules", "dist", "build", ".next", "coverage"]);
const MAX_SCAN_ENTRIES = 5000;
const MAX_SCAN_DEPTH = 8;
const MAX_SUGGESTIONS = 50;

// The `@` token being typed at the end of the draft: a bare word or an open quoted path. Null otherwise.
export function mentionToken(text: string): string | null {
	const match = /(?:^|\s)(@(?:"[^"]*|[^\s"]*))$/.exec(text);
	return match ? match[1] : null;
}

// Workspace-relative paths for `@` completion. Directories end in "/". Bounded, skips VCS and dependency
// trees, and does not follow symlinks, so the list cannot leave the workspace.
export function workspacePaths(cwd: string): string[] {
	const out: string[] = [];
	const walk = (dir: string, rel: string, depth: number): void => {
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		entries.sort((a, b) => a.name.localeCompare(b.name));
		for (const entry of entries) {
			if (out.length >= MAX_SCAN_ENTRIES) return;
			if (entry.isDirectory() && SKIPPED_DIRS.has(entry.name)) continue;
			const path = `${rel}${entry.name}${entry.isDirectory() ? "/" : ""}`;
			out.push(path);
			if (entry.isDirectory() && depth < MAX_SCAN_DEPTH) walk(join(dir, entry.name), `${path}`, depth + 1);
		}
	};
	walk(cwd, "", 0);
	return out;
}

// Suggestions for a typed `@` token; the value is what replaces the token (quoted when it has spaces).
export function suggestMentions(token: string, cwd: string): Array<{ value: string; label: string }> {
	const query = token.slice(1).replace(/^"/, "").toLowerCase();
	return workspacePaths(cwd)
		.filter((path) => path.toLowerCase().includes(query))
		.sort((a, b) => Number(!a.toLowerCase().startsWith(query)) - Number(!b.toLowerCase().startsWith(query)))
		.slice(0, MAX_SUGGESTIONS)
		.map((path) => ({ value: `@${/\s/.test(path) ? `"${path}"` : path}`, label: path }));
}

export type ResolvedMention =
	| { kind: "file"; absolute: string }
	| { kind: "directory"; absolute: string }
	| { kind: "missing" }
	| { kind: "outside" };

export interface MentionExpansion {
	prompt: string;
	notices: string[];
}

// A mention starts at the beginning or after a boundary character, so `user@host` is not a mention.
// Quoted forms may contain spaces; bare forms stop at whitespace or another `@`.
export function extractMentions(text: string): string[] {
	const found = new Set<string>();
	for (const match of text.matchAll(MENTION_REGEX)) {
		const index = match.index ?? 0;
		if (index > 0 && !BOUNDARY.test(text[index - 1])) continue;
		const quoted = match[1] ?? match[2];
		const path = quoted !== undefined
			? quoted.trim()
			: (match[3] ?? "").replace(LEADING_PUNCTUATION, "").replace(TRAILING_PUNCTUATION, "").trim();
		if (path) found.add(path);
	}
	return [...found];
}

// Exact resolution against the workspace root. Both the root and the target are realpath'd so that
// `..` segments and symlinks that leave the root classify as `outside`.
export function resolveMention(path: string, cwd: string): ResolvedMention {
	const root = realpathSync(cwd);
	let real: string;
	try {
		real = realpathSync(resolve(root, path));
	} catch {
		return { kind: "missing" };
	}
	const rel = relative(root, real);
	if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return { kind: "outside" };
	return statSync(real).isDirectory() ? { kind: "directory", absolute: real } : { kind: "file", absolute: real };
}

function escapeAttribute(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function readTextFile(absolute: string): { text: string } | { skipped: string } {
	const size = statSync(absolute).size;
	if (size > MENTION_LIMITS.maxFileBytes) return { skipped: `too large (${size} bytes)` };
	const buffer = readFileSync(absolute);
	if (buffer.subarray(0, 8192).includes(0)) return { skipped: "binary file" };
	return { text: buffer.toString("utf8") };
}

function listDirectory(absolute: string): string {
	const entries = readdirSync(absolute, { withFileTypes: true })
		.map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
		.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
	const shown = entries.slice(0, MENTION_LIMITS.maxDirEntries);
	const more = entries.length > shown.length ? `\n[${entries.length - shown.length} more entries not shown]` : "";
	return `${shown.join("\n")}${more}`;
}

// Returns the prompt Pi should receive. Unresolved mentions stay as plain prose; outside-workspace
// targets are never read. `notices` is the user-facing account of what was attached or skipped.
export function expandMentions(text: string, cwd: string): MentionExpansion {
	const notices: string[] = [];
	const blocks: string[] = [];
	const mentions = extractMentions(text);
	for (const [index, path] of mentions.entries()) {
		if (index >= MENTION_LIMITS.maxMentions) {
			notices.push(`@${path}: skipped (more than ${MENTION_LIMITS.maxMentions} mentions)`);
			continue;
		}
		const resolved = resolveMention(path, cwd);
		if (resolved.kind === "missing") {
			notices.push(`@${path}: not found, sent as text`);
			continue;
		}
		if (resolved.kind === "outside") {
			notices.push(`@${path}: outside the workspace, not attached`);
			continue;
		}
		if (resolved.kind === "directory") {
			blocks.push(`<directory path="${escapeAttribute(path)}">\n${listDirectory(resolved.absolute)}\n</directory>`);
			notices.push(`@${path}: directory listing attached`);
			continue;
		}
		const read = readTextFile(resolved.absolute);
		if ("skipped" in read) {
			notices.push(`@${path}: ${read.skipped}, not attached`);
			continue;
		}
		blocks.push(`<file path="${escapeAttribute(path)}">\n${read.text}\n</file>`);
		notices.push(`@${path}: attached`);
	}
	if (!blocks.length) return { prompt: text, notices };
	return { prompt: `${text}\n\n<mentions>\n${blocks.join("\n")}\n</mentions>`, notices };
}
