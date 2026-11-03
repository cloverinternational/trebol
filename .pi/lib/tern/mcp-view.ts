// Text for Tern's `/mcp` route. Pi's own `/mcp` opens a TUI component
// (`ctx.ui.custom`), which this frontend cannot render: it disposes the panel and
// prints "needs Pi's terminal UI". Tern instead prints the same inventory as
// transcript lines, from the snapshot transport-parity publishes.
//
// Pure and dependency-free so the wording can be asserted in tests.

import type { McpInventory, McpServerInventory } from "../tools/mcp-inventory.ts";

export const MCP_COMMAND_HINT = "  next: /mcp reconnect <server> · /mcp login <server> · /mcp logout <server> · /mcp <command> --help for Pi's own handler";

const UNKNOWN =
	"MCP inventory unavailable: no session has published it yet. It appears once the MCP extension has loaded a server for this session in Tern.";

const NONE = "No MCP servers are configured for this session.";

/** How a server's tools reach the model, stated as a fact about this session. */
function reachLine(server: McpServerInventory, reachable: boolean): string {
	const counts = `${server.active}/${server.total} active`;
	switch (server.exposure) {
		case "direct":
			return server.active === server.total ? `${counts}` : `${counts} · direct exposure, some tools inactive`;
		case "deferred":
			return reachable
				? `${counts} · deferred: loaded on demand by tool_search`
				: `${counts} · deferred: needs tool_search, which is not active`;
		case "codemode":
			return reachable
				? `${counts} · codemode: callable from codemode scripts`
				: `${counts} · codemode: needs codemode, which is not active`;
		case "hidden":
			return `${counts} · hidden: unreachable by design`;
		default:
			return counts;
	}
}

/**
 * Lines for `/mcp`. `reachable` reports whether the discovery surface a
 * deferred/codemode server needs survived tool gating, so the user can tell
 * "the server is fine" apart from "the harness hid its way in".
 */
export function mcpInventoryLines(inventory: McpInventory | undefined): string[] {
	if (!inventory) return [UNKNOWN];
	if (inventory.servers.length === 0) return [NONE, MCP_COMMAND_HINT];
	const reachable = inventory.discovery;
	const lines = [
		`MCP servers (${inventory.servers.length}) · ${inventory.active}/${inventory.total} tools active in this session`,
	];
	for (const server of inventory.servers) {
		// A server is reachable when the surface its exposure asks for is active.
		const reachableForServer =
			server.exposure === "direct" ||
			server.exposure === "hidden" ||
			(server.exposure === "deferred" && reachable.toolSearch) ||
			(server.exposure === "codemode" && reachable.codemode) ||
			server.exposure === "unknown";
		lines.push(`  ${server.name} · ${reachLine(server, reachableForServer)}`);
	}
	lines.push(MCP_COMMAND_HINT);
	return lines;
}
