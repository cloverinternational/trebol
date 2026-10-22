/** Tern side of /claw: find the session that holds the Claw tab, open a named worker tab running pi
 *  through a login shell (so LINEAR_TOKEN and the rest of ~/.zshrc reach the worker), and probe liveness. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { LaunchPlan } from "./launch-plan.ts";

const run = promisify(execFile);
export type TernExec = (args: string[]) => Promise<string>;
export const ternExec: TernExec = async (args) => (await run("tern", args, { timeout: 30_000, maxBuffer: 64 * 1024 * 1024 })).stdout;

export const CLAW_TAB = "Claw";
type Inspect = { sessions: { id: number; tabs: { id: number; name: string | null; blocks: { id: number; exited?: unknown; live?: boolean }[] }[] }[] };

export async function inspect(tern: TernExec): Promise<Inspect> { return JSON.parse(await tern(["inspect", "--json"])); }

/** The block this process runs in (Tern sets TERN_PANE in every pane). Undefined outside a Tern pane. */
export function ownPaneBlock(env: NodeJS.ProcessEnv = process.env): number | undefined {
	const raw = env.TERN_PANE?.trim();
	return raw && /^\d+$/.test(raw) ? Number(raw) : undefined;
}

/** Locates a live block in the window Tern answers for; the tab and session it belongs to. */
export async function findBlock(tern: TernExec, block: number): Promise<{ session: number; tab: number; name: string | null } | undefined> {
	const s = await inspect(tern);
	for (const session of s.sessions) for (const tab of session.tabs) {
		if (tab.blocks.some((b) => b.id === block && b.exited == null && b.live !== false)) return { session: session.id, tab: tab.id, name: tab.name };
	}
	return undefined;
}

/** Names the tab that holds this pane "Claw". Renames only that pane's tab (by block id), and confirms the name stuck. */
export async function nameClawTab(tern: TernExec, pane: number): Promise<{ tab: number; renamed: boolean }> {
	const found = await findBlock(tern, pane);
	if (!found) throw new Error(`pane ${pane} (TERN_PANE) is not a live block in this Tern window; no tab renamed`);
	if (found.name === CLAW_TAB) return { tab: found.tab, renamed: false };
	await renameTabOf(tern, pane, CLAW_TAB);
	const after = await findBlock(tern, pane);
	if (after?.tab !== found.tab || after.name !== CLAW_TAB) throw new Error(`rename to "${CLAW_TAB}" did not stick (tab is now "${after?.name ?? "missing"}")`);
	return { tab: found.tab, renamed: true };
}

/** The session that holds the orchestrator pane when known; else the session holding a tab named Claw; else the first session. */
export async function clawSession(tern: TernExec, pane?: number): Promise<number> {
	const s = await inspect(tern);
	const owner = (pane !== undefined ? s.sessions.find((x) => x.tabs.some((t) => t.blocks.some((b) => b.id === pane))) : undefined)
		?? s.sessions.find((x) => x.tabs.some((t) => t.name === CLAW_TAB)) ?? s.sessions[0];
	if (!owner) throw new Error("no Tern session is running");
	return owner.id;
}

/** Block ids that exist and have not exited. */
export async function liveBlocks(tern: TernExec): Promise<Set<number>> {
	const s = await inspect(tern);
	return new Set(s.sessions.flatMap((x) => x.tabs.flatMap((t) => t.blocks.filter((b) => b.exited == null && b.live !== false).map((b) => b.id))));
}

export const shellQuote = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;

export function tabLabel(raw: string): string {
	const name = raw.replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().replace(/^-+/, "").slice(0, 40).trim();
	return name || "claw-worker";
}

export type LaunchSpec = {
	session: number; cwd: string; label: string; runId: string; clawDir: string; prompt: string; provider?: string; model?: string;
	/** Identity-aware extension plan; `discovery` (or absent) keeps Pi's own package resolution. */
	plan?: LaunchPlan;
	/** File that receives the worker's stderr, so a startup failure names its reason instead of only "lost". */
	logPath?: string;
};

/** Pi arguments for a plan. Discovery needs none; an explicit plan replaces Pi's package resolution. */
export function launchArguments(plan: LaunchPlan | undefined): string[] {
	if (!plan || plan.mode === "discovery") return [];
	if (plan.mode === "project-ignored") return ["--no-approve"];
	return [
		"--no-extensions",
		...plan.extensions.flatMap((file) => ["--extension", file]),
		...plan.builtins.flatMap((name) => ["--extension", `builtin:${name}`]),
	];
}

export function workerCommand(spec: LaunchSpec): string[] {
	// PI_TERN_UI=0 is the documented bypass of the Tern shell dispatch (docs/reference/tern-pi-shell-dispatch.md):
	// the worker is a plain terminal pi with its normal tools, not the Tern-native preview.
	// Only stderr is captured: pi's TUI needs stdout to stay a terminal.
	const flags = launchArguments(spec.plan).map((arg) => ` ${shellQuote(arg)}`).join("");
	const log = spec.logPath ? ` 2> >(tee -a ${shellQuote(spec.logPath)} >&2)` : "";
	const line = `exec env PI_TERN_UI=0 PI_CLAW_RUN=${shellQuote(spec.runId)} PI_CLAW_DIR=${shellQuote(spec.clawDir)} pi --name ${shellQuote(spec.label)}${spec.provider ? ` --provider ${shellQuote(spec.provider)}` : ""}${spec.model ? ` --model ${shellQuote(spec.model)}` : ""}${flags} ${shellQuote(spec.prompt)}${log}`;
	return ["/bin/zsh", "-lic", line];
}

export async function launchTab(tern: TernExec, spec: LaunchSpec): Promise<{ tab: number; block: number; named: boolean }> {
	const out = await tern(["new", "tab", String(spec.session), "--cwd", spec.cwd, "--keep-open", "--json", "--", ...workerCommand(spec)]);
	const made = JSON.parse(out) as { tab: number; block: number };
	if (!Number.isInteger(made.block)) throw new Error(`tern new tab answered without a block: ${out.slice(0, 200)}`);
	// The tab exists from here on, so a failed rename must not look like a failed launch.
	const named = await renameTabOf(tern, made.block, spec.label).then(() => true, () => false);
	return { tab: made.tab, block: made.block, named };
}

export async function renameTabOf(tern: TernExec, block: number, name: string): Promise<void> { await tern(["rename", String(block), name, "--json"]); }

/** The block whose launch command carries this run id. A worker tab is named only after it is created, so a failure in
 *  between leaves an unnamed tab; the run id in its command is the only reliable handle. Inspect exposes `args`/`command`. */
export async function findRunBlock(tern: TernExec, runId: string): Promise<{ tab: number; block: number } | undefined> {
	const s = await inspect(tern);
	// Tern records the launch command shell-escaped: PI_CLAW_RUN='\''run-id'\'' so quotes and escapes sit between "=" and the id.
	const carries = new RegExp(`PI_CLAW_RUN=[\\s'\\\\"]*${runId.replace(/[^\w-]/g, "")}(?![\\w-])`);
	for (const session of s.sessions) for (const tab of session.tabs) for (const block of tab.blocks) {
		const b = block as { command?: string | null; args?: string[] };
		const text = `${b.command ?? ""} ${(b.args ?? []).join(" ")}`;
		if (carries.test(text)) return { tab: tab.id, block: block.id };
	}
	return undefined;
}

export async function sendToBlock(tern: TernExec, block: number, text: string): Promise<void> {
	if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(text)) throw new Error("text may contain newlines and tabs but no other control characters");
	await tern(["send", String(block), /[\n\t]/.test(text) ? "paste" : "text", text]);
	await tern(["send", String(block), "keys", "Enter"]);
}

export async function closeBlock(tern: TernExec, block: number): Promise<void> { await tern(["close", String(block), "--json"]); }

/** Tern's answer when the block is already gone. The tab is closed, so this is not a failure. */
export const isBlockGone = (error: unknown): boolean => /no block/i.test((error as Error | undefined)?.message ?? "");
