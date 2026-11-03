// Process-wide, read-only view of the MCP servers and tools the active Pi session has registered.
// transport-parity publishes it from Pi's own tool definitions; the Tern `/mcp` view reads it.
// No slot means unavailable; an empty server list means no MCP server is configured (or connected).
//
// This is deliberately separate from mcp-status.ts: that slot is Pi-Swarm's fallback client view
// (the startup card's connection line), while this one describes what the built-in MCP extension
// declared to the model — server, exposure, and how many tools are active right now.

import { displayServerName } from "./mcp-status.ts";

const KEY = Symbol.for("pi-swarm-mcp-inventory");
const LISTENERS = Symbol.for("pi-swarm-mcp-inventory-listeners");

type Slot = { owner: object; sessionId?: string; value: McpInventory };
type Host = { [KEY]?: Map<string | undefined, Slot>; [LISTENERS]?: Set<() => void> };
const host = globalThis as unknown as Host;

export type McpExposure = "direct" | "codemode" | "deferred" | "hidden" | "unknown";

export interface McpServerInventory {
	/** Server id as configured (`github`, `google-workspace`). */
	name: string;
	/** The exposure Pi gave the server's tools; `unknown` when they disagree. */
	exposure: McpExposure;
	/** Tools registered for this server. */
	total: number;
	/** How many of those are currently in the model's active tool set. */
	active: number;
}

export interface McpInventory {
	servers: McpServerInventory[];
	/** Tool names registered per server, in registration order. Never includes secrets. */
	tools: Record<string, string[]>;
	total: number;
	active: number;
	/** Whether the discovery tools MCP exposure depends on are in the active set. */
	discovery: { toolSearch: boolean; codemode: boolean };
}

/** Shape of a Pi tool definition, as far as this module reads it. */
export interface McpToolDefinitionLike {
	name: string;
	exposure?: unknown;
}

const EXPOSURES: ReadonlySet<string> = new Set(["direct", "codemode", "deferred", "hidden"]);

function exposureOf(value: unknown): McpExposure {
	return typeof value === "string" && EXPOSURES.has(value) ? (value as McpExposure) : "unknown";
}

// `mcp__<server>__<tool>`; the server segment is the namespace Pi derives from the id.
const MCP_TOOL = /^mcp__(.+?)__(.+)$/;

/**
 * Group Pi's registered MCP tool definitions by server and record how many are
 * active. Tools that are not `mcp__*` are ignored: this describes MCP only.
 */
export function deriveMcpInventory(
	tools: readonly McpToolDefinitionLike[],
	active: readonly string[],
): McpInventory {
	const activeNames = new Set(active);
	const tools_byServer: Record<string, string[]> = {};
	const exposureByServer = new Map<string, McpExposure | "mixed">();
	let total = 0;
	let activeCount = 0;
	for (const tool of tools) {
		const match = MCP_TOOL.exec(tool.name);
		if (!match) continue;
		const [, server, toolName] = match;
		(tools_byServer[server] ??= []).push(toolName);
		total++;
		if (activeNames.has(tool.name)) activeCount++;
		const exposure = exposureOf(tool.exposure);
		const previous = exposureByServer.get(server);
		if (previous === undefined) exposureByServer.set(server, exposure);
		else if (previous !== exposure) exposureByServer.set(server, "mixed");
	}
	const servers: McpServerInventory[] = Object.keys(tools_byServer).map((server) => {
		const names = tools_byServer[server];
		const exposure = exposureByServer.get(server);
		return {
			name: displayServerName(server),
			exposure: exposure === "mixed" || exposure === undefined ? "unknown" : exposure,
			total: names.length,
			active: names.filter((name) => activeNames.has(`mcp__${server}__${name}`)).length,
		};
	});
	return {
		servers,
		tools: tools_byServer,
		total,
		active: activeCount,
		discovery: { toolSearch: activeNames.has("tool_search"), codemode: activeNames.has("codemode") },
	};
}

function emit(): void {
	for (const listener of [...(host[LISTENERS] ?? [])]) {
		try { listener(); } catch { /* a listener must never break the publisher */ }
	}
}

export function publishMcpInventory(owner: object, value: McpInventory, sessionId?: string): void {
	(host[KEY] ??= new Map()).set(sessionId, { owner, sessionId, value });
	emit();
}

export function clearMcpInventory(owner: object): void {
	let changed = false;
	for (const [id, slot] of host[KEY] ?? []) {
		if (slot.owner === owner) { host[KEY]!.delete(id); changed = true; }
	}
	if (changed) emit();
}

export function readMcpInventory(sessionId?: string): McpInventory | undefined {
	const slot = host[KEY]?.get(sessionId);
	return slot && slot.sessionId === sessionId ? slot.value : undefined;
}

export function subscribeMcpInventory(listener: () => void): () => void {
	const listeners = (host[LISTENERS] ??= new Set());
	listeners.add(listener);
	return () => { listeners.delete(listener); };
}
