// Process-wide, read-only view of the MCP servers connected by the active Pi session.
// mcp-fallback publishes it; the Tern startup card reads it. No slot means unavailable, an empty list means none connected.
const KEY = Symbol.for("pi-swarm-mcp-status");
const LISTENERS = Symbol.for("pi-swarm-mcp-status-listeners");

type Slot = { owner: object; sessionId?: string; connected: string[] };
type Host = { [KEY]?: Map<string | undefined, Slot>; [LISTENERS]?: Set<() => void> };
const host = globalThis as unknown as Host;

export interface McpStatus { connected: string[] }

const MAX_NAME_LENGTH = 64;

// Server ids are validated upstream; this keeps the displayed value to plain identifier characters.
export function displayServerName(id: string): string {
	return /^[A-Za-z0-9_-]{1,128}$/.test(id) ? id.slice(0, MAX_NAME_LENGTH) : "MCP server";
}

function emit(): void {
	for (const listener of [...(host[LISTENERS] ?? [])]) {
		try { listener(); } catch { /* a listener must never break the publisher */ }
	}
}

// Each session has its own slot; owner checks protect shutdown from stale registrations.
export function publishMcpStatus(owner: object, connected: readonly string[], sessionId?: string): void {
	const slots = host[KEY] ??= new Map();
	slots.set(sessionId, { owner, sessionId, connected: [...new Set(connected.map(displayServerName).filter(Boolean))] });
	emit();
}

export function clearMcpStatus(owner: object): void {
	let changed = false;
	for (const [id, slot] of host[KEY] ?? []) if (slot.owner === owner) { host[KEY]!.delete(id); changed = true; }
	if (!changed) return;
	emit();
}

export function readMcpStatus(sessionId?: string): McpStatus | undefined {
	const slot = host[KEY]?.get(sessionId);
	return slot && slot.sessionId === sessionId ? { connected: [...slot.connected] } : undefined;
}

export function subscribeMcpStatus(listener: () => void): () => void {
	const listeners = (host[LISTENERS] ??= new Set());
	listeners.add(listener);
	return () => { listeners.delete(listener); };
}
