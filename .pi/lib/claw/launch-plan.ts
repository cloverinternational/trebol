/** Identity-aware extension planning for a Claw worker launch.
 *
 *  Pi resolves package sources and the cwd-local project package by lexical path
 *  (`DefaultPackageManager.getPackageIdentity`), so one repository registered twice - once as a
 *  configured package and once by the checkout the worker starts in - loads every extension
 *  twice. Pi then reports `Tool "X" conflicts with <other copy>` for every tool and exits.
 *  A linked worktree has its own path, so it never matches the configured source; a symlink to
 *  the same tree can match only because Pi canonicalizes some paths.
 *
 *  This module names a repository by real identity - the shared git common dir, or the realpath
 *  outside git - and returns the extension list to load explicitly (`pi -ne -e ...`) when two
 *  sources name the same repository. The checkout the worker runs in wins, so a worker tests the
 *  branch it was started in. Distinct repositories keep their own extensions. Read-only. */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync, type Dirent } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

/** Built-in extension names of the Pi host. Replaced extensions are omitted by Pi itself. */
export const PI_BUILTIN_EXTENSIONS = ["llama.cpp", "codemode", "tool-search", "mcp"] as const;

export type PlanSettings = {
	packages?: unknown;
	extensions?: unknown;
};

/** How a worker must start. `discovery` is Pi's own resolution, unchanged. */
export type LaunchPlan =
	| { mode: "discovery" }
	| { mode: "explicit"; extensions: string[]; builtins: string[]; kept: string[]; dropped: string[] }
	| { mode: "project-ignored"; kept: string[]; dropped: string[]; reason: string };

type Scope = "user" | "project";
type Source = { source: string; scope: Scope; root: string; filter?: string[] };
type Entry = { path: string; source: Source };

export type PlanInput = {
	cwd: string;
	agentDir: string;
	userSettings: PlanSettings;
	projectSettings: PlanSettings;
	builtins?: readonly string[];
};

const canonical = (path: string): string => {
	try { return realpathSync(path); } catch { return resolve(path); }
};

/** Toplevel and shared common dir of the repository containing `path`; undefined outside git. */
export function gitPaths(path: string): { toplevel: string; commonDir: string } | undefined {
	for (const args of [["--path-format=absolute", "--show-toplevel", "--git-common-dir"], ["--show-toplevel", "--git-common-dir"]]) {
		try {
			const out = execFileSync("git", ["-C", path, "rev-parse", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5_000 }).trim().split("\n");
			if (out.length !== 2 || !out[0] || !out[1]) continue;
			const toplevel = canonical(out[0]);
			const commonDir = canonical(isAbsolute(out[1]) ? out[1] : join(canonical(path), out[1]));
			return { toplevel, commonDir };
		} catch { /* try the next form, then give up */ }
	}
	return undefined;
}

/** A file is named by the repository that holds it. */
const repoDirOf = (real: string): string => (existsSync(real) && statSync(real).isFile() ? dirname(real) : real);

/** The same repository in another checkout - linked worktree, symlink, alternate path - shares this key. */
export function repositoryIdentity(path: string): string {
	const real = canonical(path);
	const git = gitPaths(repoDirOf(real));
	return git ? `git:${git.commonDir}` : `path:${real}`;
}

/** A resource identity that is stable across checkouts of one repository. */
export function entryIdentity(path: string): string {
	const real = canonical(path);
	const git = gitPaths(repoDirOf(real));
	if (git) return `git:${git.commonDir}::${relative(git.toplevel, real)}`;
	return `path:${real}`;
}

const REMOTE_SOURCE = /^(?:git\+|git:|npm:|https?:|ssh:|file:|github:|git@)/i;
const isLocalSource = (source: string): boolean => Boolean(source.trim()) && !REMOTE_SOURCE.test(source.trim());

function readJson<T>(path: string): T | undefined {
	try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch { return undefined; }
}

export function readSettings(path: string): PlanSettings {
	const parsed = readJson<PlanSettings>(path);
	return parsed && typeof parsed === "object" ? parsed : {};
}

function sources(packages: unknown, scope: Scope, baseDir: string): { local: Source[]; remote: string[] } {
	const local: Source[] = [];
	const remote: string[] = [];
	for (const entry of Array.isArray(packages) ? packages : []) {
		const raw = typeof entry === "string" ? entry : (entry as { source?: unknown })?.source;
		if (typeof raw !== "string" || !raw.trim()) continue;
		const filter = typeof entry === "object" && entry !== null && Array.isArray((entry as { extensions?: unknown }).extensions)
			? ((entry as { extensions: unknown[] }).extensions.filter((p): p is string => typeof p === "string"))
			: undefined;
		if (!isLocalSource(raw)) { remote.push(raw); continue; }
		local.push({ source: raw, scope, root: canonical(resolve(baseDir, raw)), filter });
	}
	return { local, remote };
}

function collectFiles(dir: string): string[] {
	let entries: Dirent[];
	try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return []; }
	const files: string[] = [];
	for (const entry of entries) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) files.push(...collectFiles(full));
		else if (/\.(?:ts|js)$/.test(entry.name)) files.push(full);
	}
	return files.sort();
}

/** Extension files a local source contributes: its `pi.extensions` manifest, else its `extensions/` tree. */
export function sourceExtensions(root: string): string[] | undefined {
	let stats;
	try { stats = statSync(root); } catch { return undefined; }
	if (stats.isFile()) return [root];
	if (!stats.isDirectory()) return undefined;
	const manifest = readJson<{ pi?: { extensions?: unknown } }>(join(root, "package.json"));
	const declared = manifest?.pi?.extensions;
	if (Array.isArray(declared) && declared.every((entry) => typeof entry === "string")) {
		return (declared as string[]).map((entry) => resolve(root, entry)).filter((file) => existsSync(file));
	}
	const dir = join(root, "extensions");
	return existsSync(dir) ? collectFiles(dir) : [];
}

/** Pi's `+`/`-`/`!` resource patterns, restricted to literal paths. Glob patterns stay Pi's to resolve. */
function applyFilter(root: string, files: string[], patterns: string[] | undefined): string[] | undefined {
	if (!patterns?.length) return files;
	if (patterns.some((pattern) => /[*?[{]/.test(pattern))) return undefined;
	let enabled = new Set(files.map(canonical));
	for (const raw of patterns) {
		const enable = !raw.startsWith("-") && !raw.startsWith("!");
		const target = canonical(resolve(root, raw.replace(/^[-+!]/, "")));
		if (enable) enabled.add(target); else enabled.delete(target);
	}
	return files.filter((file) => enabled.has(canonical(file)));
}

function userExtensionOverrides(settings: PlanSettings): string[] | undefined {
	if (!Array.isArray(settings.extensions)) return undefined;
	const patterns = settings.extensions.filter((entry): entry is string => typeof entry === "string" && !/^[-+!]?builtin:/.test(entry));
	return patterns.length ? patterns : undefined;
}

function disabledBuiltins(settings: PlanSettings[]): Set<string> {
	const disabled = new Set<string>();
	for (const setting of settings) {
		for (const entry of Array.isArray(setting.extensions) ? setting.extensions : []) {
			if (typeof entry !== "string") continue;
			const match = /^[-!]builtin:(.+)$/.exec(entry.trim());
			if (match) disabled.add(match[1]);
		}
	}
	return disabled;
}

/** Pi loads one copy per distinct resource identity. Two sources contributing the same identity is the defect. */
export function duplicateEntries(entries: Entry[]): Entry[][] {
	const groups = new Map<string, Entry[]>();
	for (const entry of entries) {
		const key = entryIdentity(entry.path);
		groups.set(key, [...(groups.get(key) ?? []), entry]);
	}
	return [...groups.values()].filter((group) => new Set(group.map((entry) => entry.source.root)).size > 1);
}

/** Deterministic preference: the checkout the worker runs in, then a project-local source, then configuration order. */
function preferred(group: Entry[], cwdIdentity: string): Entry {
	return group.find((entry) => repositoryIdentity(entry.source.root) === cwdIdentity)
		?? group.find((entry) => entry.source.scope === "project")
		?? group[0];
}

export function planLaunch(input: PlanInput): LaunchPlan {
	const project = sources(input.projectSettings.packages, "project", join(input.cwd, ".pi"));
	const user = sources(input.userSettings.packages, "user", input.agentDir);
	const all = [...project.local, ...user.local];
	const enumerated = all.map((source) => ({ source, files: applyFilter(source.root, sourceExtensions(source.root) ?? [], source.filter) }));
	const entries: Entry[] = enumerated.flatMap(({ source, files }) => (files ?? []).map((path) => ({ path, source })));
	const duplicates = duplicateEntries(entries);
	if (!duplicates.length) return { mode: "discovery" };

	const cwdIdentity = repositoryIdentity(input.cwd);
	const chosen = new Map<string, string>();
	const keptRoots = new Set<string>();
	const droppedRoots = new Set<string>();
	for (const group of duplicates) {
		const winner = preferred(group, cwdIdentity);
		chosen.set(entryIdentity(winner.path), winner.path);
		keptRoots.add(winner.source.root);
		for (const loser of group) if (loser !== winner) droppedRoots.add(loser.source.root);
	}

	const unsupported = project.remote.length + user.remote.length > 0 || enumerated.some(({ files }) => files === undefined);
	if (unsupported) {
		// Pi alone can suppress the project-local copy; the configured sources then load once.
		if ([...keptRoots, ...droppedRoots].length) {
			const kept = [...keptRoots].filter((root) => !droppedRoots.has(root));
			return {
				mode: "project-ignored", kept, dropped: [...droppedRoots],
				reason: "another package source cannot be enumerated as local extension files, so the project-local copy is ignored instead",
			};
		}
		return { mode: "discovery" };
	}

	const extensions: string[] = [];
	for (const { source, files } of enumerated) {
		if (droppedRoots.has(source.root)) continue;
		for (const file of files ?? []) extensions.push(chosen.get(entryIdentity(file)) ?? file);
	}
	const autodiscovered = [
		{ dir: join(input.agentDir, "extensions"), patterns: userExtensionOverrides(input.userSettings) },
		{ dir: join(input.cwd, ".pi", "extensions"), patterns: userExtensionOverrides(input.projectSettings) },
	];
	for (const { dir, patterns } of autodiscovered) extensions.push(...(applyFilter(dir, collectFiles(dir), patterns) ?? []));
	const unique = [...new Set(extensions.map(canonical))];
	if (!unique.length) return { mode: "discovery" };
	const disabled = disabledBuiltins([input.userSettings, input.projectSettings]);
	return {
		mode: "explicit", extensions: unique, kept: [...keptRoots], dropped: [...droppedRoots],
		builtins: (input.builtins ?? PI_BUILTIN_EXTENSIONS).filter((name) => !disabled.has(name)),
	};
}

/** Production entry point: the worker's own checkout wins over a configured duplicate of it. */
export function workerLaunchPlan(cwd: string, agentDir = process.env.PI_CODING_AGENT_DIR || join(process.env.HOME || process.env.USERPROFILE || "", ".pi", "agent")): LaunchPlan {
	return planLaunch({
		cwd,
		agentDir,
		userSettings: readSettings(join(agentDir, "settings.json")),
		projectSettings: readSettings(join(cwd, ".pi", "settings.json")),
	});
}

/** One-line description of a plan decision, for the run record and status output. */
export function describePlan(plan: LaunchPlan): string | undefined {
	if (plan.mode === "discovery") return undefined;
	if (plan.mode === "project-ignored") return `duplicate registration: project-local copy ignored (${plan.reason}); loaded ${plan.kept.join(", ") || "configured sources"}`;
	return `duplicate registration: loaded ${plan.kept.join(", ")} once; skipped ${plan.dropped.join(", ")}`;
}
