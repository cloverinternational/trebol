// Adding MCP servers through Pi's own `pi mcp add`.
//
// Pi validates and writes the config (`runMcpCommand(["add", ...])`, the code behind the CLI); this module only
// turns what people actually have in hand into that command's arguments:
//   - a JSON snippet from a server's README: `{"mcpServers": {...}}`, VS Code's `{"servers": {...}}`, a bare
//     `{"name": {...}}` map, or a `"name": {...}` fragment;
//   - `pi mcp add` arguments, with or without the `pi mcp add` prefix;
//   - `name https://url` or just a URL (the name comes from its host).
// Literal secrets in headers or env are reported so the caller can ask before they land in mcp.json.
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { piDistUrl } from "./pi-dist.ts";

export interface AddRequest { name: string; args: string[] }
export type ParsedAdd = { requests: AddRequest[]; warnings: string[]; secrets: string[] } | { error: string };

const KNOWN = new Set(["type", "command", "args", "url", "env", "headers", "cwd", "exposure", "description"]);
const SECRETISH = /token|secret|password|passwd|api[-_]?key|auth|bearer|credential/i;

// Shell-like split: quotes group, backslash escapes outside single quotes.
export function tokenize(text: string): string[] {
	const out: string[] = [];
	let current = "";
	let started = false;
	let quote: "'" | '"' | undefined;
	for (let i = 0; i < text.length; i++) {
		const c = text[i]!;
		if (quote) {
			if (c === quote) quote = undefined;
			else if (c === "\\" && quote === '"' && i + 1 < text.length) current += text[++i];
			else current += c;
		} else if (c === "'" || c === '"') { quote = c; started = true; }
		else if (c === "\\" && i + 1 < text.length) { current += text[++i]; started = true; }
		else if (/\s/.test(c)) { if (started) out.push(current); current = ""; started = false; }
		else { current += c; started = true; }
	}
	if (started) out.push(current);
	return out;
}

// `https://mcp.sentry.dev/mcp` -> "sentry"; `https://api.githubcopilot.com/mcp/` -> "githubcopilot".
export function nameFromUrl(url: string): string | undefined {
	let host: string;
	try { host = new URL(url).hostname; } catch { return undefined; }
	const labels = host.split(".").filter((l) => !["www", "mcp", "api", "app", "server"].includes(l));
	const name = (labels.length > 1 ? labels.slice(0, -1) : labels).at(-1);
	return name?.replace(/[^A-Za-z0-9_-]/g, "-") || undefined;
}

function literalSecret(key: string, value: string): boolean {
	if (value.startsWith("!") || /\$\{?[A-Za-z_]/.test(value)) return false;
	return SECRETISH.test(key) || /^(Bearer|Basic|token)\s+\S{8,}/i.test(value) || /^[A-Za-z0-9_\-.]{24,}$/.test(value);
}

function fromConfig(name: string, config: unknown, warnings: string[], secrets: string[]): AddRequest | string {
	if (!config || typeof config !== "object" || Array.isArray(config)) return `server "${name}" must be an object`;
	const c = config as Record<string, unknown>;
	const args: string[] = [name];
	const pairs = (flag: string, map: unknown) => {
		if (map === undefined) return;
		if (!map || typeof map !== "object" || Array.isArray(map)) throw new Error(`server "${name}": ${flag.slice(2)} must be an object`);
		for (const [k, v] of Object.entries(map)) {
			const value = String(v);
			if (literalSecret(k, value)) secrets.push(`${name}: ${flag === "--env" ? "env" : "header"} ${k}`);
			args.push(flag, `${k}=${value}`);
		}
	};
	try {
		for (const key of Object.keys(c)) if (!KNOWN.has(key)) warnings.push(`${name}: ignored "${key}" (Pi's mcp.json has no such field)`);
		if (typeof c.exposure === "string") args.push("--exposure", c.exposure);
		if (typeof c.description === "string") args.push("--description", c.description);
		if (typeof c.url === "string") {
			args.push("--url", c.url);
			pairs("--header", c.headers);
		} else if (typeof c.command === "string") {
			pairs("--env", c.env);
			if (typeof c.cwd === "string") args.push("--cwd", c.cwd);
			const rest = Array.isArray(c.args) ? c.args.map(String) : [];
			args.push("--", c.command, ...rest);
		} else return `server "${name}" needs "url" or "command"`;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	return { name, args };
}

function parseJson(text: string): unknown {
	try { return JSON.parse(text); } catch { /* a `"name": {...}` fragment parses once wrapped */ }
	return JSON.parse(`{${text.replace(/,\s*$/, "")}}`);
}

export function parseAddInput(input: string): ParsedAdd {
	const text = input.trim();
	if (!text) return { error: "Nothing to add. Paste a server's JSON, a URL, or `name -- command args`." };
	const warnings: string[] = [];
	const secrets: string[] = [];
	if (text.startsWith("{") || text.startsWith('"')) {
		let root: unknown;
		try { root = parseJson(text); } catch (error) { return { error: `Not valid JSON: ${error instanceof Error ? error.message : String(error)}` }; }
		const r = root as Record<string, unknown>;
		const servers = (r?.mcpServers ?? r?.servers ?? r) as Record<string, unknown>;
		if (!servers || typeof servers !== "object" || Array.isArray(servers)) return { error: "Expected an object of servers." };
		// A single server object without a name: `{"command": ...}`.
		if ("command" in servers || "url" in servers) return { error: 'This is one server without a name; wrap it as {"name": {...}}.' };
		const requests: AddRequest[] = [];
		for (const [name, config] of Object.entries(servers)) {
			const request = fromConfig(name, config, warnings, secrets);
			if (typeof request === "string") return { error: request };
			requests.push(request);
		}
		return requests.length ? { requests, warnings, secrets } : { error: "The JSON lists no servers." };
	}
	let tokens = tokenize(text);
	if (tokens[0] === "pi" && tokens[1] === "mcp") tokens = tokens.slice(2);
	if (tokens[0] === "add") tokens = tokens.slice(1);
	if (tokens.length === 1 && /^https?:\/\//.test(tokens[0]!)) {
		const name = nameFromUrl(tokens[0]!);
		if (!name) return { error: `Cannot name a server from ${tokens[0]}; write "name ${tokens[0]}".` };
		return { requests: [{ name, args: [name, "--url", tokens[0]!] }], warnings, secrets };
	}
	if (tokens.length === 2 && !tokens[0]!.startsWith("-") && /^https?:\/\//.test(tokens[1]!)) return { requests: [{ name: tokens[0]!, args: [tokens[0]!, "--url", tokens[1]!] }], warnings, secrets };
	const name = tokens[0];
	if (!name || name.startsWith("-")) return { error: "Start with the server name, e.g. `docs https://example.com/mcp`." };
	for (let i = 0; i < tokens.length; i++) {
		if (tokens[i] === "--") break;
		if ((tokens[i] === "--env" || tokens[i] === "--header") && tokens[i + 1]) {
			const [k, ...v] = tokens[i + 1]!.split("=");
			if (literalSecret(k!, v.join("="))) secrets.push(`${name}: ${tokens[i] === "--env" ? "env" : "header"} ${k}`);
		}
	}
	return { requests: [{ name, args: tokens }], warnings, secrets };
}

export interface AddResult { ok: boolean; lines: string[] }

// Runs Pi's own `pi mcp add`, in process, with its output captured.
export async function piMcpAdd(args: readonly string[], options: { cwd: string; project?: boolean; agentDir?: string }): Promise<AddResult> {
	const { runMcpCommand } = (await import(piDistUrl("extensions/mcp/cli.js"))) as {
		runMcpCommand(args: string[], options: { cwd: string; agentDir: string; log(line: string): void; error(line: string): void }): Promise<number>;
	};
	const lines: string[] = [];
	const [name, ...rest] = args;
	const argv = ["add", name ?? "", ...(options.project && !rest.includes("-l") && !rest.includes("--local") ? ["--local"] : []), ...rest];
	const code = await runMcpCommand(argv, { cwd: options.cwd, agentDir: options.agentDir ?? getAgentDir(), log: (l) => lines.push(l), error: (l) => lines.push(l) });
	return { ok: code === 0, lines: lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, "")) };
}
