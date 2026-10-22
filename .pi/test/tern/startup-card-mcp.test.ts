import { describe, expect, it } from "vitest";
import { startupNodes, type RepoStatus } from "../../lib/tern/startup-card.ts";
import type { TspNode } from "../../lib/tern/tsp.ts";

const blob = { id: "blob", mime: "image/svg+xml", base64: "" };

const repo = {
	cwd: "/repo", git: true, root: "/repo", worktrees: 1,
	commits: [{ hash: "abc1234", subject: "feat: x", when: "1 day ago" }],
	snapshot: { branch: "main", oid: "abc1234", detached: false, noCommits: false, entries: [] },
} as unknown as RepoStatus;

function find(nodes: TspNode[], id: string): TspNode | undefined {
	for (const node of nodes) {
		if (node.id === id) return node;
		const hit = find((node as { c?: TspNode[] }).c ?? [], id);
		if (hit) return hit;
	}
	return undefined;
}

function textOf(node: TspNode | undefined): string {
	const p = (node as { p?: { text?: string; spans?: Array<{ t: string }> } } | undefined)?.p;
	return p?.text ?? (p?.spans ?? []).map((span) => span.t).join("");
}

describe("startup card MCP line", () => {
	it("is unavailable when no status is published", () => {
		const nodes = startupNodes(blob, "1.0.0", repo, undefined);
		expect(textOf(find(nodes, "tern-startup-mcp"))).toBe("MCP status unavailable");
	});

	it("reads none connected for an empty published list", () => {
		const nodes = startupNodes(blob, "1.0.0", repo, { connected: [] });
		expect(textOf(find(nodes, "tern-startup-mcp"))).toBe("No MCP servers connected");
	});

	it("lists connected server names beneath Recent commits, without URLs or secrets", () => {
		const nodes = startupNodes(blob, "1.0.0", repo, { connected: ["hoja", "docs"] });
		const info = find(nodes, "tern-startup-info") as { c: TspNode[] };
		const ids = info.c.map((node) => node.id);
		expect(ids.indexOf("tern-startup-mcp")).toBe(ids.indexOf("tern-startup-commits") + 1);
		const line = textOf(find(nodes, "tern-startup-mcp"));
		expect(line).toBe("MCP connected  hoja · docs");
		expect(JSON.stringify(nodes)).not.toMatch(/https?:|token|secret/i);
	});

	it("is omitted outside a git repository", () => {
		const nodes = startupNodes(blob, "1.0.0", { cwd: "/tmp", git: false }, { connected: ["hoja"] });
		expect(find(nodes, "tern-startup-mcp")).toBeUndefined();
	});
});
