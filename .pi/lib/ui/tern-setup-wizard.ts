import { access } from "node:fs/promises";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { setupShell, shellSetupState, targetsForSetup, type ShellName } from "./tern-shell-setup.ts";

export function currentShell(env: NodeJS.ProcessEnv): ShellName | undefined {
	const name = basename(env.SHELL ?? "");
	return name === "bash" || name === "zsh" ? name : undefined;
}

export async function ternSetupWizard(ctx: any, repoRoot: string, options: { startup?: boolean; env?: NodeJS.ProcessEnv; platform?: string; home?: string; tty?: boolean } = {}): Promise<string> {
	const env = options.env ?? process.env;
	const platform = options.platform ?? process.platform;
	if (ctx?.mode !== "tui" || !ctx?.hasUI || !(options.tty ?? (process.stdin.isTTY && process.stdout.isTTY))) return "skipped: no interactive UI";
	const shell = currentShell(env);
	if (!shell || !["darwin", "linux"].includes(platform)) return "skipped: unsupported shell or platform";
	const home = options.home ?? homedir();
	const dispatch = join(repoRoot, ".pi", "config", "tern-pi.zsh");
	const runner = join(repoRoot, ".pi", "lib", "tern", "run.ts");
	try { await access(dispatch); await access(runner); }
	catch { return "skipped: Tern UI files are not installed"; }
	const state = await shellSetupState(shell, home, platform, dispatch, env.ZDOTDIR);
	if (state === "conflict") return "conflict: shell block changed; edit manually";
	if (options.startup && state === "installed") return "already installed";
	const targets = await targetsForSetup(shell, home, platform, env.ZDOTDIR);
	const title = "Tern Pi shell setup (optional)";
	const message = state === "installed"
		? `Remove Trebol's Pi/Tern dispatch block from ${targets.join(" and ")}? Other shell settings remain untouched.`
		: `Add Trebol's Pi/Tern dispatch to ${targets.join(" and ")}? Only bare pi in Tern uses the native preview. Confirmations in that preview are unavailable; use PI_TERN_UI=0 pi for full Pi. Reopen your shell afterward.`;
	if (!(await ctx.ui.confirm(title, message))) return "declined";
	const action = state === "installed" ? "uninstall" : "install";
	const result = await setupShell(shell, home, platform, dispatch, action, env.ZDOTDIR);
	return `${action}ed: ${result.changed.join(", ") || "nothing changed"}`;
}
