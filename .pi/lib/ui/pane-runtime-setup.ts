/**
 * One dismissible nudge at session start when the preferred pane runtime is missing.
 *
 * Rules this encodes, in order of importance:
 *
 *  - Ask, never install silently. The exact command is shown before anything runs.
 *  - Never guess an install command. Herdr publishes a verified installer; Tern publishes a
 *    manual download, so for Tern we point at the docs instead of inventing a URL.
 *  - Never nag. A decline is remembered per workspace in the machine-local state store, so the
 *    same workspace is asked once, not every session.
 *  - Never block a session. Every path returns a short status string; none of them throws.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { workspaceStateDir } from "../state/workspace-state.ts";
import { probePaneRuntime, type PaneRuntimeProbe } from "../panes/install-probe.ts";

const HERDR_INSTALL = "curl -fsSL https://herdr.dev/install.sh | sh";
const TERN_DOWNLOAD_PAGE = "https://docs.stencil.so/tern/";

export type PaneSetupState = { declined?: boolean; declinedAt?: string; backend?: string };

/** What the session-start prompt should do, decided without touching the UI or the disk. */
export type PaneSetupDecision = {
	ask: boolean;
	/** Why no prompt is needed, or what is missing. */
	reason: string;
	installHerdr: boolean;
	needsTern: boolean;
};

export function decidePaneSetup(probe: PaneRuntimeProbe, state: PaneSetupState): PaneSetupDecision {
	if (probe.backend === "tern") {
		return { ask: false, reason: `available: tern ${probe.tern?.version ?? "unknown"}`, installHerdr: false, needsTern: false };
	}
	if (state.declined) {
		return { ask: false, reason: "declined earlier in this workspace", installHerdr: false, needsTern: true };
	}
	// Tern is the only surface with browsers, so its absence is the thing worth mentioning even
	// when herdr is already installed and serving panes.
	return {
		ask: true,
		reason: probe.backend === "herdr"
			? `tern is not installed; herdr ${probe.herdr?.version ?? ""} is serving panes without a browser surface`
			: "no pane runtime is installed",
		installHerdr: !probe.herdr,
		needsTern: true,
	};
}

export function paneSetupStatePath(workspace: string): string {
	return workspaceStateDir(workspace, "pane-runtime.json");
}

export async function readPaneSetupState(workspace: string): Promise<PaneSetupState> {
	try {
		const raw = await readFile(paneSetupStatePath(workspace), "utf8");
		const parsed = JSON.parse(raw) as PaneSetupState;
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}

export async function writePaneSetupState(workspace: string, state: PaneSetupState): Promise<void> {
	const path = paneSetupStatePath(workspace);
	await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
	await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

/** The prompt body. States what is missing, what will be installed, and what changes if it is not. */
export function paneSetupMessage(decision: PaneSetupDecision, probe: PaneRuntimeProbe): string {
	const lines = [`Pane runtime: ${decision.reason}.`];
	if (decision.installHerdr) lines.push(`Installing runs: ${HERDR_INSTALL}`);
	lines.push(`Tern (the browser-capable runtime) is installed from ${TERN_DOWNLOAD_PAGE} — that one stays a manual download, so this prompt will only open the page.`);
	if (probe.backend === "none") lines.push("Until one is installed no pane, tab or terminal tool is offered.");
	else lines.push("Panes and tabs keep working; browser operations stay unavailable.");
	return lines.join("\n\n");
}

export type PaneSetupOptions = {
	workspace: string;
	env?: NodeJS.ProcessEnv;
	home?: string;
	platform?: string;
	tty?: boolean;
	probe?: () => Promise<PaneRuntimeProbe>;
	/** Runs the verified herdr installer. Injected so tests never touch the network. */
	installHerdr?: () => Promise<string>;
	openPage?: (url: string) => Promise<void>;
};

async function defaultInstallHerdr(): Promise<string> {
	const { execFile } = await import("node:child_process");
	await new Promise<void>((resolvePromise, reject) => {
		execFile("sh", ["-c", HERDR_INSTALL], { timeout: 180_000, maxBuffer: 1024 * 1024 }, (error) => {
			if (error) reject(error);
			else resolvePromise();
		});
	});
	return "herdr installed";
}

/**
 * Session-start setup. Returns a short human status; never throws.
 *
 * Skipped entirely when there is no interactive UI, which is the common case for subagents and
 * scripted runs: an unattended process must not sit on a confirm prompt.
 */
export async function paneRuntimeSetupWizard(ctx: any, options: PaneSetupOptions): Promise<string> {
	const interactive = options.tty ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
	if (ctx?.mode !== "tui" || !ctx?.hasUI || !interactive) return "skipped: no interactive UI";
	const probe = await (options.probe ?? (() => probePaneRuntime({ env: options.env, home: options.home ?? homedir() })))();
	const state = await readPaneSetupState(options.workspace);
	const decision = decidePaneSetup(probe, state);
	if (!decision.ask) return decision.reason;
	const accepted = await ctx.ui.confirm("Pane runtime not installed", paneSetupMessage(decision, probe));
	if (!accepted) {
		await writePaneSetupState(options.workspace, { declined: true, declinedAt: new Date().toISOString(), backend: probe.backend });
		return "declined (remembered for this workspace)";
	}
	const done: string[] = [];
	if (decision.installHerdr) {
		try {
			done.push(await (options.installHerdr ?? defaultInstallHerdr)());
		} catch (error) {
			done.push(`herdr install failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	if (decision.needsTern) {
		try {
			if (options.openPage) await options.openPage(TERN_DOWNLOAD_PAGE);
			done.push(`tern: download from ${TERN_DOWNLOAD_PAGE}`);
		} catch {
			done.push(`tern: download from ${TERN_DOWNLOAD_PAGE}`);
		}
	}
	return done.join("; ") || "nothing to do";
}
