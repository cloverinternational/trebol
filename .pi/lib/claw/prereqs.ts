/** The executables a Claw session cannot work without — `pi`, `tern`, `rg` — what each one is for, and the two things
 *  `/claw` can do about a missing one: name it with the fix a human needs, or install it when this machine can.
 *
 *  Why this exists: the launcher spawned `tern` directly, so a machine without the Tern CLI turned the first tab
 *  rename into `spawn tern ENOENT`, which `/claw on` reported as a tab-naming problem. The real fault is a missing
 *  mandatory executable, and everything Claw does with tabs fails without it.
 *
 *  Presence follows pi's own tools-manager rule: only a failed spawn (ENOENT) means "not installed"; a tool that exists
 *  but rejects `--version` is present. Nothing here spawns a real binary in tests: the runner, env, platform, home and
 *  the off-PATH existence check are injected. */
import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

export type PrereqId = "pi" | "tern" | "rg";

/** Commands and arguments only: no shell string is built anywhere, so a path with a space or a quote cannot change the
 *  command that runs. */
export type CommandRunner = (command: string, args: string[]) => Promise<string>;

const exec = promisify(execFile);
export const defaultRunner: CommandRunner = async (command, args) =>
	(await exec(command, args, { timeout: 15_000, maxBuffer: 8 * 1024 * 1024 })).stdout;
/** Installs are network and permission heavy: `npm install -g` and `apt-get` need their own budget. */
export const INSTALL_TIMEOUT_MS = 300_000;
const installRunner: CommandRunner = async (command, args) =>
	(await exec(command, args, { timeout: INSTALL_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 })).stdout;

export type Prereq = {
	id: PrereqId;
	/** Why Claw needs it, in the words the warning uses. */
	why: string;
	/** Absolute candidates tried before PATH: an explicit override, or where pi keeps its own copy. */
	extraPaths?: (env: NodeJS.ProcessEnv, home: string) => string[];
	/** Install commands, best first. Empty when this repository cannot install it. */
	installs?: (platform: NodeJS.Platform) => string[][];
	/** The step a human takes when no install command applies. */
	manual: string;
};

/** Where the Tern app installs its own CLI. That install puts a `tern` symlink in the user bin dir and the real binary
 *  under the app's data dir, and nothing adds that bin dir to the PATH of the process pi runs in — which is exactly a
 *  machine where Tern is running the pane and Claw still reported `spawn tern ENOENT`. `XDG_DATA_HOME` is honoured so a
 *  relocated data dir finds the app's own copy rather than a stale `~/.local/share` path. */
export const ternAppPaths = (env: NodeJS.ProcessEnv, home: string): string[] => {
	const data = env.XDG_DATA_HOME?.trim() || join(home, ".local", "share");
	return [join(home, ".local", "bin", "tern"), join(data, "tern", "build", "tern")];
};

export const PREREQS: readonly Prereq[] = [
	{
		id: "pi",
		why: "runs the Claw daemon and every worker tab",
		installs: () => [["npm", "install", "-g", "@earendil-works/pi-coding-agent"]],
		manual: "npm install -g @earendil-works/pi-coding-agent",
	},
	{
		id: "tern",
		why: "opens, names and inspects worker tabs",
		// tools/tern/style-lint.mjs already treats TERN_BIN as the Tern to use; the launcher must agree with it. After the
		// override comes the app's own install, then PATH (`probe` falls back to running `tern` by name).
		extraPaths: (env, home) => [env.TERN_BIN?.trim() ?? "", ...ternAppPaths(env, home)],
		// The CLI ships with the Tern app; this repository has no installer for it, and inventing one would be a lie.
		installs: () => [],
		manual: "install the Tern app (https://docs.stencil.so/tern); Claw looks for its CLI on PATH and in the app's own install locations, so a binary kept anywhere else must be named with TERN_BIN",
	},
	{
		id: "rg",
		why: "is the search every agent is told to use",
		// pi downloads its own ripgrep into its bin dir; that copy counts as installed.
		extraPaths: (env, home) => [join(env.PI_CODING_AGENT_DIR?.trim() || join(home, ".pi", "agent"), "bin", "rg")],
		installs: (platform) =>
			platform === "darwin" ? [["brew", "install", "ripgrep"]]
				: platform === "linux" ? [["apt-get", "install", "-y", "ripgrep"]]
				: platform === "android" ? [["pkg", "install", "ripgrep"]] : [],
		manual: "install ripgrep: `brew install ripgrep` (macOS), `apt-get install ripgrep` (Debian/Ubuntu), `pkg install ripgrep` (Termux), `cargo install ripgrep`",
	},
];

export const prereqById = (id: PrereqId): Prereq => {
	const found = PREREQS.find((prereq) => prereq.id === id);
	if (!found) throw new Error(`unknown prerequisite: ${id}`);
	return found;
};

export const installCommands = (id: PrereqId, platform: NodeJS.Platform = process.platform): string[][] =>
	prereqById(id).installs?.(platform) ?? [];

export type ToolState = { id: PrereqId; ok: boolean; path?: string; version?: string; error?: string };

export type PrereqDeps = {
	run?: CommandRunner;
	env?: NodeJS.ProcessEnv;
	platform?: NodeJS.Platform;
	home?: string;
	/** Existence probe for the off-PATH candidates. Defaults to an executable check. */
	exists?: (path: string) => boolean;
};

const firstLine = (text: string) => text.split("\n").map((line) => line.trim()).find(Boolean) ?? "";
export const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Only a failed spawn means "not installed": Node reports it as ENOENT with no exit status. Any other failure (a usage
 *  error, a missing socket) comes from a binary that is present. */
export const isMissingExecutable = (error: unknown): boolean =>
	(typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT") || /ENOENT/.test(messageOf(error));

/** The off-PATH existence probe: present *and* executable, because a file named like the CLI that cannot be spawned is
 *  not an installed tool. */
export const isExecutable = (path: string): boolean => {
	try {
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
};

async function probe(prereq: Prereq, deps: PrereqDeps): Promise<ToolState> {
	const run = deps.run ?? defaultRunner;
	const env = deps.env ?? process.env;
	const home = deps.home ?? homedir();
	const exists = deps.exists ?? isExecutable;
	for (const path of (prereq.extraPaths?.(env, home) ?? []).filter(Boolean)) {
		if (!exists(path)) continue;
		try {
			return { id: prereq.id, ok: true, path, version: firstLine(await run(path, ["--version"])) || undefined };
		} catch (error) {
			if (isMissingExecutable(error)) continue;
			return { id: prereq.id, ok: true, path };
		}
	}
	try {
		return { id: prereq.id, ok: true, path: prereq.id, version: firstLine(await run(prereq.id, ["--version"])) || undefined };
	} catch (error) {
		return isMissingExecutable(error)
			? { id: prereq.id, ok: false, error: messageOf(error).split("\n")[0] }
			: { id: prereq.id, ok: true, path: prereq.id };
	}
}

export type PrereqReport = { ok: boolean; present: ToolState[]; missing: ToolState[] };

/** Probes the mandatory executables together. All of them run, so one slow tool does not hide another's answer. */
export async function checkPrereqs(ids: readonly PrereqId[] = PREREQS.map((prereq) => prereq.id), deps: PrereqDeps = {}): Promise<PrereqReport> {
	const states = await Promise.all(PREREQS.filter((prereq) => ids.includes(prereq.id)).map((prereq) => probe(prereq, deps)));
	const missing = states.filter((state) => !state.ok);
	return { ok: missing.length === 0, present: states.filter((state) => state.ok), missing };
}

/** One message a human can act on: which tool is missing, why Claw needs it, and the exact step. Never says "name the
 *  tab yourself": a missing executable is not a tab problem. */
export function missingPrereqsMessage(report: PrereqReport, platform: NodeJS.Platform = process.platform): string {
	const ids = report.missing.map((state) => state.id);
	const head = ids.length === 1
		? `Claw needs \`${ids[0]}\` and it is not installed.`
		: `Claw needs ${ids.map((id) => `\`${id}\``).join(" and ")} and they are not installed.`;
	const lines = report.missing.map((state) => {
		const [command] = installCommands(state.id, platform);
		const fix = command ? `install it with \`${command.join(" ")}\`` : prereqById(state.id).manual;
		const reason = state.error ? ` (${state.error})` : "";
		return `- ${state.id}: ${prereqById(state.id).why}${reason}. Fix: ${fix}.`;
	});
	return [head, ...lines].join("\n");
}

export type InstallOutcome = { installed: PrereqId[]; failed: { id: PrereqId; error: string }[] };

/** Installs what this machine can install, one command per tool. A failure keeps the tool's own first output line: an
 *  `apt-get` without root and an offline `npm` fail for different reasons and neither is a Claw bug. */
export async function installPrereqs(states: readonly ToolState[], deps: PrereqDeps = {}): Promise<InstallOutcome> {
	const run = deps.run ?? installRunner;
	const platform = deps.platform ?? process.platform;
	const outcome: InstallOutcome = { installed: [], failed: [] };
	for (const state of states) {
		const [command] = installCommands(state.id, platform);
		if (!command) {
			outcome.failed.push({ id: state.id, error: `this repository cannot install it: ${prereqById(state.id).manual}` });
			continue;
		}
		try {
			await run(command[0], command.slice(1));
			outcome.installed.push(state.id);
		} catch (error) {
			outcome.failed.push({ id: state.id, error: `\`${command.join(" ")}\` failed: ${messageOf(error).split("\n")[0]}` });
		}
	}
	return outcome;
}

export function describeInstall(outcome: InstallOutcome): string {
	const parts: string[] = [];
	if (outcome.installed.length) parts.push(`installed ${outcome.installed.join(", ")}`);
	for (const failure of outcome.failed) parts.push(`${failure.id} not installed: ${failure.error}`);
	return parts.length ? `${parts.join("; ")}.` : "";
}

/** The launch-side gate: a worker tab is opened with the Tern CLI, so a run must not create its Hoja issue without it. */
export async function ternUsable(deps: PrereqDeps = {}): Promise<{ ok: boolean; error?: string }> {
	const report = await checkPrereqs(["tern"], deps);
	return report.ok ? { ok: true } : { ok: false, error: `tern is not installed (${report.missing[0]?.error ?? "not found"})` };
}
