/** Repository-declared Hoja project: `.pi/config/hoja.json`.
 *
 *  Project identity belongs to the repository, not to a guess. A delegated agent starts a task tree in a fresh
 *  process with no knowledge of the board, and an exact project name (`Hoja`, not the workspace directory `trebol`)
 *  is not something it can derive — so the repository states it once and every chat in that checkout inherits it.
 *  Metadata (`metadata.hojaProject`) still overrides this for a task that genuinely belongs elsewhere.
 */
import { lstatSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

export const HOJA_CONFIG_PATH = ".pi/config/hoja.json";

export type HojaProjectConfig = { project?: string; assignee?: string };

/** Missing, unreadable, non-JSON or wrongly shaped configuration is "not configured", never a crash and never a
 *  guess: publication then falls back to the next source or reports `no_project` honestly. */
export function parseHojaConfig(text: string | undefined | null): HojaProjectConfig {
	if (typeof text !== "string" || !text.trim()) return {};
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return {};
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const record = value as Record<string, unknown>;
	const text_ = (key: string) => {
		const raw = record[key];
		return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
	};
	const project = text_("project");
	const assignee = text_("assignee");
	return { ...(project ? { project } : {}), ...(assignee ? { assignee } : {}) };
}

/** Walk up to the nearest `.git` (directory or worktree file), using real paths so a symlinked session directory
 *  resolves to the checkout that actually owns it. Undefined outside a repository: no mapping is ever written to an
 *  arbitrary working directory. */
export function findHojaRepositoryRoot(start: string = process.cwd()): string | undefined {
	let current: string;
	try {
		const absolute = resolve(start);
		current = statSync(absolute).isDirectory() ? absolute : dirname(absolute);
		current = realpathSync(current);
	} catch {
		return undefined;
	}
	for (;;) {
		try {
			const stat = lstatSync(join(current, ".git"));
			if (stat.isDirectory() || stat.isFile()) return current;
		} catch { /* keep walking */ }
		const parent = dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

export function readHojaConfig(root: string = process.cwd()): HojaProjectConfig {
	try {
		return parseHojaConfig(readFileSync(join(root, HOJA_CONFIG_PATH), "utf8"));
	} catch {
		return {};
	}
}

/** The mapping a session should inherit: the repository's own file, found from any subdirectory. */
export function readHojaConfigForRepository(start: string = process.cwd()): HojaProjectConfig {
	const root = findHojaRepositoryRoot(start);
	return readHojaConfig(root ?? start);
}

export type HojaMappingWrite =
	| { ok: true; path: string }
	| { ok: false; reason: "empty_name" | "no_repository" | "symlinked" | "outside_repository" | "invalid_existing" | "write_failed" };

/** Persist an explicitly confirmed project for this repository.
 *
 *  This never runs on an ordinary `select`: only a host-confirmed "remember" reaches it, because writing the shared
 *  file changes every future chat in the checkout. The existing document is merged as raw JSON so unknown keys
 *  survive; a malformed document is refused rather than replaced. Symlinks (the config file, `.pi` or `config`) are
 *  refused so a write cannot escape the checkout, and the resolved directory must stay inside the repository. */
export function writeHojaProjectMapping(name: string, start: string = process.cwd()): HojaMappingWrite {
	const project = name.trim();
	if (!project) return { ok: false, reason: "empty_name" };
	const root = findHojaRepositoryRoot(start);
	if (!root) return { ok: false, reason: "no_repository" };
	const realRoot = realpathSync(root);
	const configDir = join(realRoot, ".pi", "config");
	const path = join(realRoot, HOJA_CONFIG_PATH);
	// Refuse to traverse or replace a symlink: realpath of the final directory would otherwise land outside the repo.
	for (const candidate of [join(realRoot, ".pi"), configDir, path]) {
		try {
			if (lstatSync(candidate).isSymbolicLink()) return { ok: false, reason: "symlinked" };
		} catch { /* missing is fine */ }
	}
	let document: Record<string, unknown> = {};
	let text = "";
	try {
		text = readFileSync(path, "utf8");
	} catch { /* no file yet */ }
	if (text.trim()) {
		try {
			const parsed: unknown = JSON.parse(text);
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, reason: "invalid_existing" };
			document = parsed as Record<string, unknown>;
		} catch {
			// A malformed file is someone else's data: never replace it, or the fix eats itself on the next read.
			return { ok: false, reason: "invalid_existing" };
		}
	}
	try {
		mkdirSync(configDir, { recursive: true });
		const realDir = realpathSync(configDir);
		if (realDir !== realRoot && !realDir.startsWith(`${realRoot}${sep}`)) return { ok: false, reason: "outside_repository" };
		writeFileSync(path, `${JSON.stringify({ ...document, project }, null, 2)}\n`, "utf8");
		return { ok: true, path };
	} catch {
		return { ok: false, reason: "write_failed" };
	}
}
