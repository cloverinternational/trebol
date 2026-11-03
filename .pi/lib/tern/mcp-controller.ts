import { DraftEditor, type HostEdit } from "./draft-edit.ts";
import type { KeyEffect } from "./keys.ts";
import { previewMcpAdd, type McpConfiguration, type McpConfiguredServer, type McpHost, type McpOperationResult } from "./mcp-host.ts";

export interface McpTool { name: string; description?: string; parameters?: unknown; exposure?: unknown }
export interface McpSnapshot { tools: McpTool[]; active: string[]; connected?: string[] }
export interface McpServerRow {
	id: string; namespace: string; config?: McpConfiguredServer; tools: McpTool[];
	observed: boolean; active: number;
}
export interface McpManagerSource {
	host(): McpHost | undefined;
	snapshot(): McpSnapshot;
	reload(): Promise<void>;
}
export type McpTab = "servers" | "tools" | "diagnostics";

/** Strip terminal controls from externally supplied names/descriptions (never config secrets). */
export function mcpLabel(value: string, max = 300): string {
	return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x1f\x7f]/g, " ").slice(0, max);
}

export function mcpServerRows(config: McpConfiguration | undefined, snapshot: McpSnapshot): McpServerRow[] {
	const rows: McpServerRow[] = (config?.servers ?? []).map((s) => ({ id: s.name, namespace: s.namespace, config: s, tools: [], observed: false, active: 0 }));
	for (const tool of snapshot.tools) {
		const match = /^(mcp__.+?)__(.+)$/.exec(tool.name);
		if (!match) continue;
		let row = rows.find((r) => r.namespace === match[1]);
		if (!row) { row = { id: match[1]!.slice(5), namespace: match[1]!, tools: [], observed: false, active: 0 }; rows.push(row); }
		row.tools.push(tool);
		if (snapshot.active.includes(tool.name)) row.active++;
	}
	for (const row of rows) row.observed = snapshot.connected?.includes(row.namespace.slice(5)) === true;
	return rows;
}

export class McpController {
	open = false;
	tab: McpTab = "servers";
	config?: McpConfiguration;
	loading = false;
	error?: string;
	busy?: string;
	notice?: McpOperationResult;
	selected?: string;
	selectedTool?: string;
	form?: "add" | "preview" | "remove";
	project = false;
	removeTarget?: { name: string; scope: "global" | "project" };
	preview?: ReturnType<typeof previewMcpAdd>;
	readonly search = new DraftEditor();
	input = new DraftEditor({ multiline: true });
	focus: "search" | "input" | "list" = "search";
	#generation = 0;
	#timer?: ReturnType<typeof setInterval>;
	#fingerprint = "";
	readonly source: McpManagerSource;
	readonly changed: () => void;
	constructor(source: McpManagerSource, changed: () => void) { this.source = source; this.changed = changed; }
	get snapshot(): McpSnapshot { return this.source.snapshot(); }
	get rows(): McpServerRow[] { return mcpServerRows(this.config, this.snapshot); }
	get filtered(): McpServerRow[] {
		const query = this.search.text.toLowerCase();
		return this.rows.filter((r) => `${r.id} ${r.config?.scope ?? ""} ${r.config?.transport ?? ""}`.toLowerCase().includes(query));
	}
	get server(): McpServerRow | undefined { return this.rows.find((s) => s.id === this.selected) ?? this.filtered[0]; }
	get tools(): McpTool[] {
		const query = this.search.text.toLowerCase();
		return this.snapshot.tools.filter((t) => t.name.startsWith("mcp__") && `${t.name} ${t.description ?? ""}`.toLowerCase().includes(query));
	}
	get tool(): McpTool | undefined { return this.tools.find((t) => t.name === this.selectedTool) ?? this.tools[0]; }
	get focusId(): string { return this.form === "add" ? "mcp-add-input" : this.focus === "list" ? (this.tab === "tools" ? "mcp-tools" : "mcp-servers") : "mcp-search"; }
	async show(): Promise<void> {
		if (!this.open) {
			this.open = true;
			// Registry-only observations; no network requests or configuration reads on this timer.
			this.#timer = setInterval(() => {
				const next = JSON.stringify(this.snapshot);
				if (next !== this.#fingerprint) { this.#fingerprint = next; this.changed(); }
			}, 1000);
			this.#timer.unref?.();
		}
		await this.refresh();
	}
	close(): void {
		this.open = false;
		this.#generation++;
		clearInterval(this.#timer);
		this.#timer = undefined;
		this.loading = false;
		this.form = undefined;
		this.preview = undefined;
		this.config = undefined;
		this.selected = undefined;
		this.selectedTool = undefined;
		this.removeTarget = undefined;
		this.notice = undefined;
		this.error = undefined;
		this.input = new DraftEditor({ multiline: true });
		this.changed();
	}
	escape(): void {
		if (this.form) {
			if (this.busy) return;
			this.form = this.form === "preview" ? "add" : undefined;
			this.preview = undefined;
			if (!this.form) this.input = new DraftEditor({ multiline: true });
			this.changed();
		} else this.close();
	}
	async refresh(): Promise<void> {
		if (this.loading || this.busy) return;
		const generation = this.#generation;
		this.loading = true;
		this.error = undefined;
		this.changed();
		try {
			const host = this.source.host();
			const config = host ? await host.configuration() : undefined;
			if (generation !== this.#generation || !this.open) return;
			this.config = config;
			if (!host) this.error = "Pi management adapter unavailable. Live registered tools are still shown; restart the Tern session to enable configuration actions.";
		} catch {
			if (generation === this.#generation) this.error = "Could not read Pi's MCP configuration. Retry Refresh; existing session tools are shown below.";
		} finally {
			if (generation === this.#generation) { this.loading = false; this.changed(); }
		}
	}
	async #run(label: string, operation: () => Promise<McpOperationResult>): Promise<void> {
		if (this.busy || !this.open) return;
		const generation = this.#generation;
		this.busy = label;
		this.notice = undefined;
		this.changed();
		try {
			const result = await operation();
			if (generation !== this.#generation || !this.open) return;
			this.notice = result;
			if (result.ok) { this.form = undefined; this.preview = undefined; this.input = new DraftEditor({ multiline: true }); }
		} catch {
			if (generation === this.#generation && this.open) this.notice = { ok: false, message: "Operation failed. Review configuration and retry." };
		} finally {
			this.busy = undefined;
			if (generation === this.#generation && this.open) { this.changed(); await this.refresh(); }
		}
	}
	async action(action: string, value?: string): Promise<void> {
		if (!this.open) return;
		if (action === "mcp.close") return this.escape();
		if (this.busy) return;
		if (this.form === "preview" && !["mcp.save", "mcp.back"].includes(action)) return;
		if (this.form === "remove" && action !== "mcp.confirm-remove") return;
		if (action === "mcp.refresh") return this.refresh();
		if (action === "mcp.tab" && ["servers", "tools", "diagnostics"].includes(value ?? "")) {
			this.tab = value as McpTab; this.search.setText(""); this.focus = "search";
		} else if (action === "mcp.select") this.selected = value;
		else if (action === "mcp.tool") this.selectedTool = value;
		else if (action === "mcp.clear") this.search.setText("");
		else if (action === "mcp.add") { this.form = "add"; this.notice = undefined; this.focus = "input"; }
		else if (action === "mcp.scope") this.project = value === "project";
		else if (action === "mcp.preview") { this.preview = previewMcpAdd(this.input.text); this.form = "preview"; }
		else if (action === "mcp.back") { this.form = "add"; this.preview = undefined; }
		else if (action === "mcp.remove") {
			const c = this.server?.config;
			if (c && c.scope !== "extension") { this.removeTarget = { name: c.name, scope: c.scope }; this.form = "remove"; }
		} else if (action === "mcp.reload") {
			return this.#run("Reloading session", async () => { await this.source.reload(); return { ok: true, message: "Reload requested." }; });
		} else {
			const host = this.source.host();
			if (!host) return;
			if (action === "mcp.save" && this.form === "preview" && this.preview && !("error" in this.preview)) {
				return this.#run("Saving configuration", () => host.add(this.input.text, this.project));
			}
			if (action === "mcp.confirm-remove" && this.form === "remove" && this.removeTarget) {
				const target = this.removeTarget;
				return this.#run("Removing configuration", () => host.remove(target.name, target.scope));
			}
			if (["mcp.reconnect", "mcp.login", "mcp.logout"].includes(action) && this.server?.config) {
				const server = this.server.config;
				const command = action.slice(4) as "reconnect" | "login" | "logout";
				if (!server.enabled || (command !== "reconnect" && !server.oauth)) return;
				return this.#run(`${command} · ${mcpLabel(server.name)}`, () => host.command(command, server.name));
			}
		}
		this.changed();
	}
	event(body: Record<string, unknown>): Promise<void> | undefined {
		const id = String(body.id ?? "");
		if (body.ev === "action") {
			const raw = String(body.act ?? "");
			const at = raw.indexOf("=");
			return this.action(at < 0 ? raw : raw.slice(0, at), at < 0 ? String(body.value ?? "") : raw.slice(at + 1));
		}
		if (body.ev === "select" || body.ev === "activate") {
			const value = String(body.item ?? body.value ?? "");
			return this.action(id === "mcp-tabs" ? "mcp.tab" : id === "mcp-scope" ? "mcp.scope" : id === "mcp-tools" ? "mcp.tool" : "mcp.select", value);
		}
		if (id === "mcp-search" || id === "mcp-add-input") {
			if ((id === "mcp-add-input" && this.form !== "add") || (id === "mcp-search" && this.form)) return;
			const editor = id === "mcp-search" ? this.search : this.input;
			if (body.ev === "focus") this.focus = id === "mcp-search" ? "search" : "input";
			if (!this.busy && body.ev === "edit") editor.applyHostEdit(body as unknown as HostEdit);
			if (!this.busy && body.ev === "undo") editor.undo();
			this.changed();
		}
		if (body.ev === "paste" && typeof body.text === "string") this.key({ kind: "text", text: body.text });
		if (body.ev === "key") {
			const key = String(body.key ?? "");
			const kinds: Record<string, KeyEffect> = { escape: { kind: "escape" }, enter: { kind: "submit" }, tab: { kind: "tab" }, up: { kind: "up" }, down: { kind: "down" }, backspace: { kind: "backspace" } };
			const effect = kinds[key] ?? (key.length === 1 ? { kind: "text" as const, text: key } : undefined);
			if (effect) this.key(effect);
		}
		return undefined;
	}
	key(effect: KeyEffect): boolean {
		if (!this.open) return false;
		if (effect.kind === "escape") { this.escape(); return true; }
		if (this.busy || this.form === "preview" || this.form === "remove") return true;
		const editor = this.form === "add" ? this.input : this.search;
		switch (effect.kind) {
			case "text": editor.insert(effect.text); break;
			case "backspace": editor.backspace(); break;
			case "deleteWord": editor.deleteWordBackward(); break;
			case "deleteForward": editor.deleteForward({ word: effect.word }); break;
			case "deleteToEdge": editor.deleteToEdge(effect.direction); break;
			case "cursor": editor.move(effect.direction, { word: effect.word, extend: effect.extend, line: effect.line }); break;
			case "selectAll": editor.selectAll(); break;
			case "undo": editor.undo(); break;
			case "newline": if (this.form === "add") editor.insert("\n"); break;
			case "tabMove": editor.move(effect.delta < 0 ? -1 : 1); break;
			case "tab": {
				if (this.form) break;
				const tabs: McpTab[] = ["servers", "tools", "diagnostics"];
				this.tab = tabs[(tabs.indexOf(this.tab) + 1) % tabs.length]!;
				this.search.setText(""); break;
			}
			case "up": case "down": {
				const ids = this.tab === "tools" ? this.tools.map((t) => t.name) : this.filtered.map((r) => r.id);
				const current = this.tab === "tools" ? this.tool?.name : this.server?.id;
				const i = Math.max(0, ids.indexOf(current ?? ""));
				const next = ids[Math.max(0, Math.min(ids.length - 1, i + (effect.kind === "up" ? -1 : 1)))];
				if (this.tab === "tools") this.selectedTool = next; else this.selected = next;
				break;
			}
			case "submit": if (this.form === "add") void this.action("mcp.preview"); break;
		}
		this.changed();
		return true;
	}
}
