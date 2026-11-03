// Pi's built-in extensions (MCP, codemode, tool_search, llama.cpp) for the Tern runner.
//
// Pi's own CLI passes `builtInExtensions` to the resource loader; an SDK caller gets none unless it does
// the same, which left Tern panes without Pi's MCP (no `/mcp`, no MCP tools). The list is read from the
// installed package so it follows Pi upgrades. The only change is an observer on the MCP extension:
// the tools it registers (`mcp__<server>__<tool>`, re-registered `hidden` when a server is turned off)
// are published to the process-wide MCP status the Tern startup card reads.
import { createMcpExtension } from "@earendil-works/pi-coding-agent";
import { clearMcpStatus, publishMcpStatus } from "../tools/mcp-status.ts";
import { piDistUrl } from "../tools/pi-dist.ts";

type Factory = (pi: any) => unknown;
export interface BuiltinExtension { name: string; factory: Factory; builtin: true; replaceable?: boolean }

const MCP_TOOL = /^mcp__(.+?)__(.+)$/;

let cached: Promise<BuiltinExtension[]> | undefined;

export function piBuiltinExtensions(): Promise<BuiltinExtension[]> {
	cached ??= (async () => {
		const { builtInExtensions } = (await import(piDistUrl("extensions/index.js"))) as { builtInExtensions: BuiltinExtension[] };
		return builtInExtensions.map((entry) => (entry.name === "mcp" ? { ...entry, factory: withMcpStatus(createMcpExtension() as Factory) } : entry));
	})();
	return cached;
}

// Servers count as connected while they have at least one reachable tool registered.
export function withMcpStatus(factory: Factory): Factory {
	return (pi) => {
		const owner = {};
		const tools = new Map<string, Set<string>>();
		let sessionId: string | undefined;
		const publish = () => publishMcpStatus(owner, [...tools].filter(([, names]) => names.size > 0).map(([server]) => server), sessionId);
		const track = (definition: { name?: unknown; exposure?: unknown }) => {
			const match = typeof definition?.name === "string" ? MCP_TOOL.exec(definition.name) : null;
			if (!match) return;
			const names = tools.get(match[1]!) ?? new Set<string>();
			if (definition.exposure === "hidden") names.delete(definition.name as string);
			else names.add(definition.name as string);
			tools.set(match[1]!, names);
			publish();
		};
		const observed = new Proxy(pi, {
			get(target, key) {
				if (key === "registerTool") return (definition: { name?: unknown; exposure?: unknown }) => { const result = target.registerTool(definition); track(definition); return result; };
				if (key === "on") {
					return (event: string, handler: (e: unknown, ctx: any) => unknown) => target.on(event, async (e: unknown, ctx: any) => {
						if (event === "session_start") {
							sessionId = ctx?.sessionManager?.getSessionId?.();
							tools.clear();
							publish();
						}
						const result = await handler(e, ctx);
						if (event === "session_shutdown") {
							tools.clear();
							clearMcpStatus(owner);
						}
						return result;
					});
				}
				const value = Reflect.get(target, key);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		return factory(observed);
	};
}
