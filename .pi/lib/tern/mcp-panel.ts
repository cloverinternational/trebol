import type { TspNode } from "./tsp.ts";
import { McpController, mcpLabel, type McpServerRow } from "./mcp-controller.ts";

const n = (id: string, k: string, p: Record<string, unknown> = {}, c?: TspNode[]): TspNode => ({ id, k, p, ...(c ? { c } : {}) });
const text = (id: string, value: string, tone = "neutral") => n(id, "text", { text: value, tone });
const button = (id: string, label: string, act: string, variant = "quiet", disabled = false) => n(id, "button", { text: label, variant, disabled, size: "sm", actions: { click: act } });
const spans = (value: string) => [{ t: value }];
const kv = (id: string, rows: [string, string][]) => n(id, "kv", { items: rows.map(([k, v]) => ({ k: spans(k), v: spans(v) })) });
const empty = (id: string, title: string, description: string) => n(id, "empty", { title, description });

function state(row: McpServerRow): string {
	if (row.config?.enabled === false) return "Disabled";
	if (row.observed) return "Tools observed";
	if (row.tools.length) return "Registered";
	return "Not observed";
}

function reach(row: McpServerRow, manager: McpController): string {
	const exposure = new Set(row.tools.map((t) => String(t.exposure ?? "unknown")));
	if (!row.tools.length) return "No registered tools. This does not establish connection health.";
	const parts: string[] = [];
	if (exposure.has("direct")) parts.push(`${row.active} tools declared directly to the model`);
	if (exposure.has("deferred")) parts.push(manager.snapshot.active.includes("tool_search") ? "Deferred tools are discoverable through tool_search" : "Deferred tools need tool_search, which is inactive");
	if (exposure.has("codemode")) parts.push(manager.snapshot.active.includes("codemode") ? "Codemode tools are callable from scripts" : "Codemode tools need codemode, which is inactive");
	if (exposure.has("hidden")) parts.push("Hidden tools are unreachable by design");
	return parts.join(". ") || "Exposure information unavailable.";
}

function serverView(m: McpController, narrow: boolean): TspNode {
	const selected = m.server;
	const list = n("mcp-server-scroll", "scroll", { max: { h: "22lines" }, grow: 1 }, [n("mcp-servers", "table", {
		selectable: true, selected: selected?.id,
		cols: [{ id: "name", head: "Server", grow: 1 }, { id: "state", head: "Observation", priority: 2 }, { id: "tools", head: "Tools", priority: 1 }, { id: "scope", head: "Scope", priority: 3 }],
		rows: m.filtered.map((r) => ({ id: r.id, cells: { name: spans(mcpLabel(r.id)), state: spans(state(r)), tools: spans(String(r.tools.length)), scope: spans(r.config?.scope ?? "session") } })),
	})]);
	if (!m.rows.length) return empty("mcp-empty", "No MCP servers observed", "Add a server, or refresh after Pi finishes loading. A missing tool registry does not mean no configuration exists.");
	if (!m.filtered.length) return empty("mcp-no-match", "No matching servers", "Try a different server name, scope or transport.");
	const config = selected?.config;
	const detail = selected ? n("mcp-inspector", "card", { head: mcpLabel(selected.id), meta: config ? `${config.scope} · ${config.transport}` : "Session registration", grow: 1 }, [
		kv("mcp-facts", [["Observation", state(selected)], ["Exposure", config?.exposure ?? "See tool details"], ["Registered", String(selected.tools.length)], ["Model-declared", String(selected.active)]]),
		text("mcp-reach", reach(selected, m), "muted"),
		text("mcp-observation-note", "Last observed registration, not a continuous connection health check.", "muted"),
		...(config?.override ? [text("mcp-override", "A project override applies to this definition.", "warning")] : []),
		n("mcp-server-actions", "row", { gap: "sm", wrap: true }, [
			button("mcp-reconnect", "Reconnect", "mcp.reconnect", "primary", !config?.enabled || Boolean(m.busy)),
			...(config?.oauth ? [button("mcp-login", "Sign in", "mcp.login", "quiet", !config.enabled || Boolean(m.busy)), button("mcp-logout", "Sign out", "mcp.logout", "quiet", !config.enabled || Boolean(m.busy))] : []),
			...(config && config.scope !== "extension" ? [button("mcp-remove", "Remove…", "mcp.remove", "danger", Boolean(m.busy))] : []),
		]),
	]) : empty("mcp-select-empty", "Select a server", "Its tools and session availability appear here.");
	return n("mcp-server-view", narrow ? "col" : "row", { gap: "lg", align: "stretch" }, [n("mcp-server-master", "col", { grow: 1, basis: 0 }, [list]), n("mcp-server-detail", "col", { grow: 1, basis: 0 }, [detail])]);
}

function toolView(m: McpController, narrow: boolean): TspNode {
	const tool = m.tool;
	if (!m.tools.length) return empty("mcp-tools-empty", "No matching tools", "Tools appear after Pi registers them. Clear the search or refresh the session view.");
	let schema = "Schema unavailable";
	try { schema = JSON.stringify(tool?.parameters ?? {}, null, 2).slice(0, 24000); } catch { /* optional schema */ }
	return n("mcp-tool-view", narrow ? "col" : "row", { gap: "lg", align: "stretch" }, [
		n("mcp-tools-scroll", "scroll", { grow: 1, basis: 0, max: { h: "24lines" } }, [n("mcp-tools", "table", {
			selectable: true, selected: tool?.name,
			cols: [{ id: "name", head: "Tool", grow: 1 }, { id: "exposure", head: "Exposure", priority: 2 }],
			rows: m.tools.map((t) => ({ id: t.name, cells: { name: spans(mcpLabel(t.name)), exposure: spans(String(t.exposure ?? "unknown")) } })),
		})]),
		n("mcp-tool-detail", "col", { grow: 1, basis: 0, gap: "sm" }, [
			n("mcp-tool-card", "card", { head: mcpLabel(tool?.name ?? "Tool"), meta: "Read-only inspection · never executes a tool" }, [text("mcp-tool-description", mcpLabel(tool?.description ?? "No description provided.", 2400)), kv("mcp-tool-facts", [["Exposure", String(tool?.exposure ?? "unknown")], ["Model-declared", m.snapshot.active.includes(tool?.name ?? "") ? "Yes" : "No — may be callable via discovery"]])]),
			n("mcp-schema-scroll", "scroll", { max: { h: "16lines" } }, [n("mcp-schema", "code", { text: schema, lang: "json" })]),
		]),
	]);
}

function formView(m: McpController): TspNode[] {
	if (m.form === "remove") return [
		n("mcp-remove-confirm", "card", { head: `Remove ${mcpLabel(m.removeTarget?.name ?? "server")}?`, tone: "warning" }, [
			text("mcp-remove-scope", `This changes ${m.removeTarget?.scope} configuration. Existing connections remain until reload. Removing an override may reveal a lower-priority definition.`),
		]),
		n("mcp-confirm-actions", "row", { gap: "sm", justify: "end" }, [button("mcp-remove-cancel", "Cancel", "mcp.close"), button("mcp-remove-apply", "Remove configuration", "mcp.confirm-remove", "danger", Boolean(m.busy))]),
	];
	if (m.form === "preview") {
		const p = m.preview;
		const valid = p && !("error" in p) ? p : undefined;
		return [
			n("mcp-preview-card", "card", { head: "Review configuration change", tone: p && "error" in p ? "error" : "neutral" }, [
				...(p && "error" in p ? [text("mcp-preview-error", p.error, "error")] : [
					text("mcp-preview-names", valid?.requests.map((r) => mcpLabel(r.name)).join(" · ") ?? ""),
					text("mcp-preview-scope", `Save to ${m.project ? "project" : "global"} configuration. Existing entries with the same IDs will be replaced. Reload is required.`),
					text("mcp-preview-warning", `${valid?.warnings.length ?? 0} unsupported field warning(s). Pi validates the final configuration.`, "muted"),
					...(valid?.secrets.length ? [text("mcp-secret-warning", "Literal credentials detected. Confirming saves them in plain text. Prefer ${ENV_VAR} or !command references. Values are not displayed in this preview.", "warning")] : []),
				]),
			]),
			n("mcp-preview-actions", "row", { gap: "sm", justify: "end" }, [button("mcp-preview-back", "Back", "mcp.back"), button("mcp-preview-save", p && !("error" in p) && p.secrets.length ? "Confirm plaintext save" : "Save configuration", "mcp.save", "primary", !p || "error" in p || Boolean(m.busy))]),
		];
	}
	return [
		text("mcp-add-help", "Paste server JSON, an HTTP URL, or name -- command arguments. Configuration stays in Pi; secrets never appear in the review summary.", "muted"),
		n("mcp-scope", "tabs", { variant: "segmented", active: m.project ? "project" : "global", items: [{ id: "global", label: "Global" }, { id: "project", label: "This project" }] }),
		...(m.project && !m.config?.trusted ? [text("mcp-trust-note", "This project is not trusted. Pi will not load project servers until you trust it.", "warning")] : []),
		n("mcp-add-field", "field", { label: "Server definition", hint: "Prefer credential references over literal tokens." }, [n("mcp-add-input", "editor", { text: m.input.text, cursor: m.input.cursor, anchor: m.input.anchor, placeholder: '{"mcpServers": {…}}', min: { h: "6lines" }, aria: "MCP server definition" })]),
		n("mcp-add-actions", "row", { gap: "sm", justify: "end" }, [button("mcp-add-cancel", "Cancel", "mcp.close"), button("mcp-add-preview", "Review change", "mcp.preview", "primary", !m.input.text.trim())]),
	];
}

export function mcpPanelNodes(m: McpController, columns = 100): TspNode[] {
	if (!m.open) return [];
	const rows = m.rows;
	const controls = n("mcp-head-actions", "row", { gap: "sm" }, [
		button("mcp-refresh", "Refresh", "mcp.refresh", "quiet", m.loading || Boolean(m.busy) || Boolean(m.form)),
		button("mcp-add", "Add server", "mcp.add", "quiet", !m.source.host() || Boolean(m.busy) || Boolean(m.form)),
		button("mcp-close", m.form ? "Back" : "Close", "mcp.close", "quiet", Boolean(m.busy) && Boolean(m.form)),
	]);
	const body: TspNode[] = [];
	if (m.busy) body.push(n("mcp-busy", "spinner", { label: spans(m.busy), tone: "pending" }));
	if (m.notice) body.push(n("mcp-notice", "card", { head: m.notice.ok ? "Request completed" : "Needs attention", tone: m.notice.ok ? "success" : "error" }, [text("mcp-notice-text", m.notice.message), button("mcp-reload", "Reload session", "mcp.reload", "quiet", Boolean(m.busy))]));
	if (m.error) body.push(text("mcp-error", m.error, "warning"));
	if (m.form) body.push(...formView(m));
	else {
		body.push(n("mcp-stats", "stats", { items: [
			{ label: "Configured", value: m.config ? String(m.config.servers.length) : "—" },
			{ label: "Tools registered", value: String(rows.reduce((n, r) => n + r.tools.length, 0)) },
			{ label: "Model-declared", value: String(rows.reduce((n, r) => n + r.active, 0)) },
			{ label: "Disabled", value: m.config ? String(rows.filter((r) => r.config?.enabled === false).length) : "—" },
		] }));
		body.push(n("mcp-tabs", "tabs", { active: m.tab, items: [{ id: "servers", label: "Servers" }, { id: "tools", label: "Tools" }, { id: "diagnostics", label: "Diagnostics" }] }));
		if (m.tab !== "diagnostics") body.push(n("mcp-search", "input", { text: m.search.text, cursor: m.search.cursor, anchor: m.search.anchor, icon: "search", placeholder: m.tab === "tools" ? "Search tools and descriptions…" : "Search servers, scope or transport…", aria: "Search MCP inventory" }));
		if (m.loading && !m.config && !rows.length) body.push(n("mcp-loading", "skeleton", { kind: "rows", count: 4 }));
		else if (m.tab === "servers") body.push(serverView(m, columns < 100));
		else if (m.tab === "tools") body.push(toolView(m, columns < 100));
		else body.push(kv("mcp-diagnostics", [
			["Source of truth", "Current Pi session registry + Pi trusted configuration loader"],
			["tool_search", m.snapshot.active.includes("tool_search") ? "Active — deferred discovery available" : "Inactive"],
			["codemode", m.snapshot.active.includes("codemode") ? "Active — script discovery available" : "Inactive"],
			["Project trust", m.config ? m.config.trusted ? "Trusted" : "Untrusted — project config is ignored" : "Unavailable"],
			["Configuration errors", m.config ? String(m.config.errors) : "Unavailable"],
			["Connection health", "Not continuously probed. Registered tools are not proof of current transport health."],
			["Refresh", "Reads session state; does not open duplicate connections or start model turns."],
		]));
	}
	return [n("mcp-overlay", "overlay", { head: m.form ? "MCP · Configuration" : "MCP · Control center", meta: "This Pi session", size: "lg", modal: true, role: "pi.mcp.overlay", end: "mcp-head-actions", foot: "mcp-footer" }, [
		controls,
		n("mcp-body", "col", { gap: "md" }, body),
		n("mcp-footer", "row", { justify: "between", gap: "md" }, [text("mcp-keys", "Esc Back / close · Tab Switch view · ↑↓ Select", "muted"), text("mcp-live", "Live registry · no health probes", "muted")]),
	])];
}
