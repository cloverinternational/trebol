/**
 * Which pane runtime is actually available?
 *
 * The `tern` tool used to be advertised unconditionally and then fail every call with
 * `spawn tern ENOENT`. Two separate problems hid behind that message:
 *
 *  1. `execFile("tern", …)` resolves through the *pane's* inherited PATH, which is not the
 *     PATH a user's shell sees. A binary that is plainly installed can still be invisible.
 *  2. Nothing ever checked, so "not installed" and "installed but unreachable" produced the
 *     same opaque failure and no install path was offered.
 *
 * This module resolves each runtime to an absolute path, proves it runs, and reports what
 * the resulting backend can do. It never throws: a probe that cannot answer is a probe that
 * says "absent", not a session that dies at startup.
 */
import { execFile } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

export type RuntimeInfo = { path: string; version: string };

/** What a backend can do. Browser operations exist only in the native Tern runtime. */
export type PaneCapabilities = { panes: boolean; browser: boolean };

export type PaneBackendName = "tern" | "herdr" | "none";

export type PaneRuntimeProbe = {
	backend: PaneBackendName;
	capabilities: PaneCapabilities;
	tern?: RuntimeInfo;
	herdr?: RuntimeInfo & { serverRunning: boolean };
	/** Every directory consulted, in order. Lets an error say where we looked. */
	searched: string[];
};

export type ProbeOptions = {
	env?: NodeJS.ProcessEnv;
	home?: string;
	platform?: NodeJS.Platform;
	/** Injected for tests; the default spawns the binary with `--version`. */
	versionOf?: (path: string, signal?: AbortSignal) => Promise<string | undefined>;
	/** Injected for tests; the default runs `herdr status` and reads the server block. */
	herdrStatusOf?: (path: string, signal?: AbortSignal) => Promise<string | undefined>;
	signal?: AbortSignal;
};

/** Well-known install locations, consulted after PATH. `~/.local/bin` is where both official
 *  installers put their binary, and it is frequently missing from a non-login shell's PATH. */
export function wellKnownDirs(home: string, platform: NodeJS.Platform = process.platform): string[] {
	const dirs = [join(home, ".local", "bin")];
	if (platform === "darwin") dirs.push("/opt/homebrew/bin", "/usr/local/bin");
	else dirs.push("/usr/local/bin", "/usr/bin", "/opt/homebrew/bin");
	return dirs;
}

/** Ordered, de-duplicated search path: PATH entries first, then the well-known directories. */
export function searchDirs(env: NodeJS.ProcessEnv, home: string, platform: NodeJS.Platform = process.platform): string[] {
	const fromPath = (env.PATH ?? "").split(delimiter).filter(Boolean);
	const seen = new Set<string>();
	const ordered: string[] = [];
	for (const dir of [...fromPath, ...wellKnownDirs(home, platform)]) {
		if (!isAbsolute(dir) || seen.has(dir)) continue;
		seen.add(dir);
		ordered.push(dir);
	}

	return ordered;
}

/** An executable file at `path`, or undefined. Directories and non-executables do not count. */
export function isExecutable(path: string): boolean {
	try {
		if (!statSync(path).isFile()) return false;
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/**
 * Resolve `names` to the first executable found.
 *
 * An explicit override (`<PREFIX>_BIN`) wins outright when it names an executable file, so a
 * user can pin a specific build; a non-executable override is ignored rather than trusted.
 */
export function resolveBinary(names: string[], options: { env: NodeJS.ProcessEnv; home: string; platform?: NodeJS.Platform; override?: string }): string | undefined {
	const override = options.override?.trim();
	if (override && isAbsolute(override) && isExecutable(override)) return override;
	for (const dir of searchDirs(options.env, options.home, options.platform)) {
		for (const name of names) {
			const candidate = join(dir, name);
			if (isExecutable(candidate)) return candidate;
		}
	}

	return undefined;
}

/** `1.2.3` out of "tern 0.9.12 (e498b49)" or "herdr 0.9.5". */
export function parseVersion(text: string): string | undefined {
	return /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/.exec(text)?.[1];
}

async function defaultVersionOf(path: string, signal?: AbortSignal): Promise<string | undefined> {
	const stdout = await new Promise<string>((resolvePromise, reject) => {
		execFile(path, ["--version"], { timeout: 5_000, signal, maxBuffer: 1024 * 1024 }, (error, out) => {
			if (error) reject(error);
			else resolvePromise(String(out));
		});
	});

	return parseVersion(stdout);
}

async function defaultHerdrStatusOf(path: string, signal?: AbortSignal): Promise<string | undefined> {
	return await new Promise<string>((resolvePromise, reject) => {
		execFile(path, ["status"], { timeout: 5_000, signal, maxBuffer: 1024 * 1024 }, (error, out) => {
			if (error) reject(error);
			else resolvePromise(String(out));
		});
	});
}

/**
 * Whether a `herdr status` report says the server is up.
 *
 * The output is a small indented report with a `client:` block and a `server:` block, and only
 * the server block carries a `status:` line. Reading the whole text would also match a client
 * line in a future version, so the server block is sliced out first.
 */
export function herdrServerRunning(statusText: string | undefined): boolean {
	if (!statusText) return false;
	const lines = statusText.split("\n");
	const start = lines.findIndex((line) => /^server:\s*$/.test(line));
	if (start === -1) return false;
	let end = lines.length;
	for (let i = start + 1; i < lines.length; i += 1) {
		if (/^\S/.test(lines[i])) {
			end = i;
			break;
		}
	}
	const block = lines.slice(start + 1, end).join("\n");
	return /^\s*status:\s*running\s*$/m.test(block);
}

/** Tern is the only backend that carries a browser surface. */
export function capabilitiesFor(backend: PaneBackendName): PaneCapabilities {
	if (backend === "tern") return { panes: true, browser: true };
	if (backend === "herdr") return { panes: true, browser: false };
	return { panes: false, browser: false };
}

async function probeOne(
	names: string[],
	options: { env: NodeJS.ProcessEnv; home: string; platform?: NodeJS.Platform; override?: string; signal?: AbortSignal; run: (path: string, signal?: AbortSignal) => Promise<string | undefined> },
): Promise<RuntimeInfo | undefined> {
	const path = resolveBinary(names, options);
	if (!path) return undefined;
	try {
		const version = await options.run(path, options.signal);
		// A binary that will not answer `--version` is installed but unusable. Report it as
		// absent so the caller offers the install path rather than a mystery failure.
		return version ? { path, version } : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Detect the pane runtime. Tern wins when both are present: it is the native surface and the
 * only one with browser operations. Herdr is the fallback, never the preferred path.
 */
export async function probePaneRuntime(options: ProbeOptions = {}): Promise<PaneRuntimeProbe> {
	const env = options.env ?? process.env;
	const home = options.home ?? homedir();
	const platform = options.platform ?? process.platform;
	const searched = searchDirs(env, home, platform);
	const shared = { env, home, platform, signal: options.signal };
	const versionOf = options.versionOf ?? defaultVersionOf;
	const statusOf = options.herdrStatusOf ?? defaultHerdrStatusOf;

	const tern = await probeOne(["tern"], { ...shared, override: env.PI_SWARM_TERN_BIN, run: versionOf });
	const herdrInfo = await probeOne(["herdr"], { ...shared, override: env.PI_SWARM_HERDR_BIN, run: versionOf });
	let herdr: (RuntimeInfo & { serverRunning: boolean }) | undefined;
	if (herdrInfo) {
		let statusText: string | undefined;
		try {
			statusText = await statusOf(herdrInfo.path, options.signal);
		} catch {
			statusText = undefined;
		}
		herdr = { ...herdrInfo, serverRunning: herdrServerRunning(statusText) };
	}

	const backend: PaneBackendName = tern ? "tern" : herdr ? "herdr" : "none";
	return { backend, capabilities: capabilitiesFor(backend), tern, herdr, searched };
}

/**
 * Registration-time detection.
 *
 * The tool schema has to be built synchronously at extension load, so this answers only
 * "which binary is reachable" — no `--version` spawn, no server status. The async probe is
 * still what reports versions and the server state to the user.
 */
export function detectBackendSync(options: { env?: NodeJS.ProcessEnv; home?: string; platform?: NodeJS.Platform } = {}): {
	backend: PaneBackendName;
	capabilities: PaneCapabilities;
	ternPath?: string;
	herdrPath?: string;
	searched: string[];
} {
	const env = options.env ?? process.env;
	const home = options.home ?? homedir();
	const platform = options.platform ?? process.platform;
	const searched = searchDirs(env, home, platform);
	const ternPath = resolveBinary(["tern"], { env, home, platform, override: env.PI_SWARM_TERN_BIN });
	const herdrPath = ternPath ? undefined : resolveBinary(["herdr"], { env, home, platform, override: env.PI_SWARM_HERDR_BIN });
	const backend: PaneBackendName = ternPath ? "tern" : herdrPath ? "herdr" : "none";
	return { backend, capabilities: capabilitiesFor(backend), ternPath, herdrPath, searched };
}
