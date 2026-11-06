import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { startupNodes, type RepoStatus } from "../../lib/tern/startup-card.ts";
import type { TspNode } from "../../lib/tern/tsp.ts";

const blob = { id: "blob", mime: "image/svg+xml", base64: "" };
const ASSET = readFileSync(new URL("../../lib/tern/assets/trebol-shamrock.svg", import.meta.url), "utf8");
const SOURCE = readFileSync(new URL("../../lib/tern/startup-card.ts", import.meta.url), "utf8");
const BRIDGE = readFileSync(new URL("../../lib/tern/bridge.ts", import.meta.url), "utf8");

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

const image = () => find(startupNodes(blob, "1.0.0", repo), "tern-startup-logo") as unknown as { p: { w?: number; h?: number; max?: unknown } };

describe("startup card shamrock", () => {
	// Measured live at font scale 20/13: the node without `w`/`h` laid out at 248.84 x 175 with class
	// `sf-clipped`, i.e. Tern chose a wider box and cropped the artwork. `w`/`h` are what pin the box.
	it("gives the shamrock explicit bounds in the asset's own ratio", () => {
		const [, vw, vh] = (ASSET.match(/viewBox="0 0 (\d+) (\d+)"/) ?? []).map(Number);
		const { p } = image();
		expect(typeof p.w).toBe("number");
		expect(typeof p.h).toBe("number");
		expect(Math.abs((p.w as number) / (p.h as number) - vw / vh)).toBeLessThan(0.02);
	});

	it("does not leave the size to a bound in text lines, which grew with the terminal font", () => {
		const { p } = image();
		expect(p.max).toBeUndefined();
		expect(JSON.stringify(p)).not.toMatch(/lines/);
	});

	it("keeps the mark outlined, so dark brand green reads on a near-black surface", () => {
		const path = ASSET.match(/<path [^>]*>/)?.[0] ?? "";
		const width = Number(path.match(/stroke-width="([\d.]+)"/)?.[1] ?? 0);
		expect(path).toMatch(/stroke="(?!none)/);
		expect(width).toBeGreaterThan(0);
	});

	it("never fades the mark in, so a re-render cannot leave it at opacity 0", () => {
		expect(SOURCE).not.toMatch(/opacity:\s*0/);
		expect(SOURCE).not.toMatch(/@keyframes/);
		expect(BRIDGE).not.toMatch(/stylesheet\("startup"/);
	});
});
