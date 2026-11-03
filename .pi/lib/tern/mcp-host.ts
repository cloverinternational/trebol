// Session-owned adapter to Pi's builtin MCP. Never opens its own connections.
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { piDistUrl } from "../tools/pi-dist.ts";
import { parseAddInput, type ParsedAdd } from "../tools/mcp-add.ts";

export interface McpConfiguredServer {
	name: string;
	namespace: string;
	scope: "global" | "project" | "extension";
	enabled: boolean;
	exposure: string;
	transport: "stdio" | "http";
	oauth: boolean;
	override: boolean;
}
export interface McpConfiguration { servers: McpConfiguredServer[]; errors: number; trusted: boolean }
export interface McpOperationResult { ok: boolean; message: string }
export interface McpHost {
	configuration(): Promise<McpConfiguration>;
	command(action: "reconnect" | "login" | "logout", name: string): Promise<McpOperationResult>;
	add(input: string, project: boolean): Promise<McpOperationResult>;
	remove(name: string, scope: "global" | "project"): Promise<McpOperationResult>;
}
const KEY = Symbol.for("trebol-tern-mcp-hosts");
const global = globalThis as typeof globalThis & { [KEY]?: Map<string, { owner: object; host: McpHost }> };
export function readMcpHost(id: string): McpHost | undefined { return global[KEY]?.get(id)?.host; }
export function clearMcpHost(owner: object): void {
	for (const [id, slot] of global[KEY] ?? []) if (slot.owner === owner) global[KEY]!.delete(id);
}

/** Strict UI add dialect: scope and command verbs belong to the form, never pasted flags. */
export function previewMcpAdd(input: string): ParsedAdd {
	const result = parseAddInput(input);
	if ("error" in result) return { error: "Enter valid server JSON, an HTTP URL, or name -- command arguments." };
	for (const request of result.requests) {
		if (!/^[\w.-]+$/.test(request.name)) return { error: "Server IDs may contain letters, numbers, dots, underscores and hyphens." };
		const end = request.args.indexOf("--");
		if (end < 0 && !request.args.includes("--url")) return { error: "Provide an HTTP URL or separate a stdio command with --." };
		const flags = request.args.slice(1, end < 0 ? undefined : end);
		if (flags.some((v) => /^(?:-l|--local|--help|-h)$/.test(v))) return { error: "Choose scope in the form; omit local/help flags from the pasted command." };
		const accepted = new Set(["--url", "--env", "--header", "--cwd", "--exposure", "--description"]);
		for (let i = 0; i < flags.length; i += 2) {
			if (!accepted.has(flags[i]!) || flags[i + 1] === undefined) return { error: "Unsupported or incomplete option. Use server JSON or URL/command with env, header, cwd, exposure and description options." };
		}
	}
	return result;
}

export function publishMcpHost(owner: object, id: string, pi: any, ctx: any, handler: (args: string, ctx: any) => Promise<unknown>): void {
	let busy = false;
	const alive = () => global[KEY]?.get(id)?.host === host && ctx.sessionManager?.getSessionId?.() === id;
	const guard = async (fn: () => Promise<McpOperationResult>) => {
		if (!alive()) return { ok: false, message: "This MCP session has been replaced. Reopen the manager." };
		if (busy) return { ok: false, message: "Another MCP operation is still running." };
		busy = true;
		try { return await fn(); }
		catch { return { ok: false, message: "Pi could not complete this operation. Check configuration and credentials, then retry." }; }
		finally { busy = false; }
	};
	const configuration = async (): Promise<McpConfiguration> => {
		if (!alive()) throw new Error("Session replaced");
		const { loadMcpConfig } = await import(piDistUrl("extensions/mcp/config.js"));
		const { mcpNamespace } = await import(piDistUrl("core/mcp-servers.js"));
		const trusted = ctx.isProjectTrusted?.() === true;
		const loaded = loadMcpConfig({ agentDir: getAgentDir(), cwd: ctx.cwd, projectTrusted: trusted });
		const entries = [...loaded.servers];
		for (const entry of pi.getMcpServers?.() ?? []) {
			if (!entries.some((e: any) => mcpNamespace(e.name) === mcpNamespace(entry.name))) entries.push({ ...entry, scope: "extension" });
		}
		return {
			trusted, errors: loaded.errors.length,
			servers: entries.map((e: any) => ({
				name: e.name, namespace: mcpNamespace(e.name), scope: e.scope ?? "global",
				enabled: e.config.enabled !== false, exposure: e.config.exposure ?? "codemode",
				transport: "url" in e.config ? "http" : "stdio", override: Boolean(e.override),
				oauth: "url" in e.config && !e.config.auth && !Object.keys(e.config.headers ?? {}).some((k) => k.toLowerCase() === "authorization"),
			})),
		};
	};
	const cli = async (args: string[]): Promise<boolean> => {
		const { runMcpCommand } = await import(piDistUrl("extensions/mcp/cli.js"));
		if (!alive()) throw new Error("Session replaced");
		// CLI diagnostics may include raw input/credentials; never forward them into the UI.
		return (await runMcpCommand(args, { cwd: ctx.cwd, agentDir: getAgentDir(), log() {}, error() {} })) === 0;
	};
	const host: McpHost = {
		configuration,
		command: (action, name) => guard(async () => {
			if (!/^[\w.-]+$/.test(name)) return { ok: false, message: "This server ID cannot be addressed by Pi's command parser." };
			let failed = false;
			// rpc mode uses select/input/notify instead of the terminal-only custom manager.
			await handler(`${action} ${name}`, { ...ctx, mode: "rpc", hasUI: true, ui: {
				...ctx.ui,
				notify(_message: string, level: string) { if (level === "error" || level === "warning") failed = true; },
			} });
			return { ok: !failed, message: failed ? "Pi could not complete the request. Check credentials/configuration and retry." : `${action === "login" ? "Sign-in flow finished" : action === "logout" ? "Sign-out finished" : "Reconnect finished"} for ${name}. Refresh to inspect registered tools.` };
		}),
		add: (input, project) => guard(async () => {
			const parsed = previewMcpAdd(input);
			if ("error" in parsed) return { ok: false, message: parsed.error };
			let added = 0;
			for (const request of parsed.requests) {
				if (!alive()) break;
				const [name, ...args] = request.args;
				if (!(await cli(["add", name!, ...(project ? ["--local"] : []), ...args]))) return { ok: false, message: `${added} server(s) saved before Pi rejected an entry. Review configuration before retrying; reload to apply saved entries.` };
				added++;
			}
			return { ok: added === parsed.requests.length, message: `${added} server(s) saved. Reload this session to apply configuration.` };
		}),
		remove: (name, scope) => guard(async () => {
			const found = (await configuration()).servers.find((s) => s.name === name && s.scope === scope);
			if (!found) return { ok: false, message: "Server scope changed. Refresh before removing." };
			const ok = await cli(["remove", name, ...(scope === "project" ? ["--local"] : [])]);
			return { ok, message: ok ? `Removed ${name} from ${scope} configuration. Reload to apply; a lower-priority definition may become visible.` : "Pi did not remove this server. Refresh and check its scope." };
		}),
	};
	(global[KEY] ??= new Map()).set(id, { owner, host });
}
