import { describe, expect, it, vi } from "vitest";
import { PiTernBridge, type PiSessionLike } from "../../lib/tern/bridge.ts";
import { contextPanelNodes, readContextBreakdown, type ContextBreakdown } from "../../lib/tern/context-panel.ts";
import { ESC, parseTspMessages, type TspMessage } from "../../lib/tern/tsp.ts";

const find = (nodes: any[], id: string): any => {
	for (const n of nodes) {
		if (n.id === id) return n;
		const hit = n.c && find(n.c, id);
		if (hit) return hit;
	}
	return undefined;
};

const skillsBlock = (body: string) => `<available_skills>${body}</available_skills>`;

function session(parts: { usage?: unknown; prompt?: string; tools?: unknown[]; messages?: unknown[]; model?: unknown } = {}) {
	return {
		model: parts.model,
		getContextUsage: () => parts.usage,
		systemPrompt: parts.prompt ?? "",
		agent: { state: { systemPrompt: parts.prompt ?? "", tools: parts.tools ?? [], messages: parts.messages ?? [] } },
	};
}

describe("context breakdown", () => {
	it("anchors the parts on the provider's own total, so the split ends where the composer meter does", () => {
		const breakdown = readContextBreakdown(
			session({
				usage: { tokens: 50_000, contextWindow: 200_000 },
				prompt: "p".repeat(4000) + skillsBlock("s".repeat(400)),
				tools: [{ name: "bash", description: "d".repeat(400), parameters: { type: "object" } }],
				messages: [{ role: "user", content: [{ type: "text", text: "m".repeat(400) }] }],
			}),
		);
		expect(breakdown.exact).toBe(true);
		expect(breakdown.used).toBe(50_000);
		expect(breakdown.window).toBe(200_000);
		// The bar is drawn from the parts: they must add up to the total the provider reported.
		const sum = breakdown.categories.reduce((total, category) => total + category.tokens, 0);
		expect(sum).toBe(50_000);
		// The conversation absorbs the estimation error, because it is the part that grows.
		expect(breakdown.categories.find((c) => c.id === "messages")!.tokens).toBeGreaterThan(0);
		expect(breakdown.categories.find((c) => c.id === "skills")!.tokens).toBeGreaterThan(0);
	});

	it("subtracts the skills block from the prompt instead of charging it twice", () => {
		const block = skillsBlock("s".repeat(400));
		const plain = "p".repeat(4000);
		const withSkills = readContextBreakdown(session({ usage: { tokens: 50_000, contextWindow: 200_000 }, prompt: plain + block }));
		const withoutSkills = readContextBreakdown(session({ usage: { tokens: 50_000, contextWindow: 200_000 }, prompt: plain }));
		const skills = (b: ContextBreakdown) => b.categories.find((c) => c.id === "skills")!.tokens;
		const prompt = (b: ContextBreakdown) => b.categories.find((c) => c.id === "systemPrompt")!.tokens;
		expect(skills(withoutSkills)).toBe(0);
		expect(skills(withSkills)).toBeGreaterThan(0);
		// The same prompt text plus a skills block moves tokens out of the prompt, not into the total twice.
		expect(prompt(withSkills)).toBe(prompt(withoutSkills));
	});

	it("estimates every part, and says so, while the provider has reported no usage", () => {
		// Pi returns tokens: null right after a compaction, before the next response.
		const breakdown = readContextBreakdown(
			session({
				usage: { tokens: null, contextWindow: 1000 },
				prompt: "p".repeat(400),
				messages: [{ role: "user", content: [{ type: "text", text: "m".repeat(400) }] }],
			}),
		);
		expect(breakdown.exact).toBe(false);
		expect(breakdown.used).toBe(breakdown.categories.reduce((total, c) => total + c.tokens, 0));
		expect(contextPanelNodes(breakdown)[0].c![0].c!.some((n) => n.id === "context-note")).toBe(true);
	});

	it("counts a picture as tokens, not as its base64 length", () => {
		const image = { type: "image", mimeType: "image/png", data: "A".repeat(400_000) };
		const breakdown = readContextBreakdown(
			session({ usage: { tokens: null, contextWindow: 200_000 }, messages: [{ role: "user", content: [image] }] }),
		);
		// 1.5k tokens for the frame, not 100k for the bytes.
		expect(breakdown.used).toBeLessThan(5000);
	});

	it("never lets the reserve eat the free space it computes from", () => {
		const breakdown = readContextBreakdown(session({ usage: { tokens: 950, contextWindow: 1000 } }), { thresholdTokens: 900 });
		expect(breakdown.thresholdTokens).toBe(900);
		expect(breakdown.autoCompactBufferTokens).toBe(50);
		expect(breakdown.freeTokens).toBe(0);
		// With compaction off there is no reserve and the rest of the window is free.
		const open = readContextBreakdown(session({ usage: { tokens: 950, contextWindow: 1000 } }));
		expect(open.autoCompactBufferTokens).toBe(0);
		expect(open.freeTokens).toBe(50);
	});

	it("reports no window when Pi has no model, and draws the card's empty state", () => {
		const breakdown = readContextBreakdown(session({ usage: undefined }));
		expect(breakdown.window).toBe(0);
		const [panel] = contextPanelNodes(breakdown);
		expect(find(panel.c, "context-unavailable")?.p.spans[0].t).toContain("no model is selected");
		expect(find(panel.c, "context-bar")).toBeUndefined();
	});

	it("survives a stale Pi context instead of throwing", () => {
		const stale = { getContextUsage: () => { throw new Error("stale ctx"); } };
		expect(readContextBreakdown(stale as never).window).toBe(0);
	});
});

describe("context card", () => {
	const breakdown = (): ContextBreakdown =>
		readContextBreakdown(
			session({
				usage: { tokens: 50_000, contextWindow: 200_000 },
				prompt: "p".repeat(40_000) + skillsBlock("s".repeat(4000)),
				tools: [{ name: "bash", description: "d".repeat(8000), parameters: { type: "object" } }],
				messages: [{ role: "user", content: [{ type: "text", text: "m".repeat(80_000) }] }],
				model: { id: "claude-haiku", name: "Claude Haiku 4.5" },
			}),
			{ thresholdTokens: 180_000 },
		);

	it("titles itself with the model and leads with the provider's figure", () => {
		const [panel] = contextPanelNodes(breakdown());
		expect(panel.k).toBe("overlay");
		expect(panel.p).toMatchObject({ head: "Context · Haiku 4.5", role: "pi.context.overlay" });
		const used = find(panel.c, "context-used");
		expect(used.p.spans.map((s: any) => s.t).join("")).toBe("50K of 200K tokens · 25%");
		expect(find(panel.c, "context-room").p.spans[0].t).toBe("130K left before auto-compaction at 90%");
	});

	it("draws one stacked bar in the rows' order, with the threshold ticked", () => {
		const [panel] = contextPanelNodes(breakdown());
		const bar = find(panel.c, "context-bar");
		expect(bar.p).toMatchObject({ role: "pi.context.bar", style: "bar", size: "lg", value: 0.25 });
		const parts = bar.p.parts;
		expect(parts.map((p: any) => p.token)).toEqual(["accent", "info", "success", "warning", "track", "error"]);
		// Free space is the empty track, and only the reserve is hatched.
		expect(parts[4].hatch).toBeUndefined();
		expect(parts[5]).toMatchObject({ token: "error", hatch: true });
		expect(bar.p.marks).toEqual([{ at: 0.9, tone: "warning", title: "Auto-compaction at 90% · 180,000 tokens" }]);
	});

	it("lists every part, free space and the reserve, each with its share", () => {
		const [panel] = contextPanelNodes(breakdown());
		const cats = find(panel.c, "context-cats");
		const rows = cats.c.map((n: any) => n.id);
		expect(rows).toEqual([
			"context-cat-systemPrompt",
			"context-cat-systemTools",
			"context-cat-skills",
			"context-cat-messages",
			"context-cat-free",
			"context-cat-buffer",
		]);
		expect(find(cats.c, "context-cat-free-label").p.text).toBe("Free space");
		expect(find(cats.c, "context-cat-systemPrompt-swatch").p.spans[0]).toEqual({ t: "■", s: "accent" });
		expect(find(cats.c, "context-cat-systemPrompt-share").p.spans[0].t).toMatch(/%$/);
	});

	it("closes from its own hint, and from a click anywhere around it", async () => {
		const [panel] = contextPanelNodes(breakdown());
		expect(find(panel.c, "context-hint").p.actions).toEqual({ click: "context.close" });
		const dismiss = (await import("../../lib/tern/context-panel.ts")).contextDismissNode();
		expect(dismiss.p).toMatchObject({ role: "pi.context.dismiss", actions: { click: "context.close" }, grow: 1 });
	});
});

// A bridge over a fake session, replaying frames into the accumulated node tree as Tern does.
function harness(options: { usage?: unknown; prompt?: string; tools?: unknown[]; messages?: unknown[]; model?: unknown } = {}) {
	const writes: string[] = [];
	const prompt = vi.fn(() => new Promise<void>(() => {}));
	const fake = {
		model: options.model ?? { id: "claude-haiku", name: "Claude Haiku 4.5" },
		getContextUsage: () => options.usage ?? { tokens: 50_000, contextWindow: 200_000 },
		systemPrompt: options.prompt ?? "p".repeat(4000),
		agent: { state: { tools: options.tools ?? [], messages: options.messages ?? [] } },
		subscribe: () => () => {},
		prompt,
		abort: async () => {},
		dispose() {},
		sessionManager: { getSessionId: () => "context", getEntries: () => [], getBranch: () => [] },
	} as unknown as PiSessionLike;
	const bridge = new PiTernBridge(fake, { write: (delta) => writes.push(delta), surfaceId: "pi", credits: 1000 });
	bridge.start();
	return { bridge, writes, prompt };
}

function nodes(writes: string[]) {
	const map = new Map<string, any>();
	const add = (node: any, parent: string) => {
		map.set(node.id, { ...node, c: undefined, parent });
		for (const child of node.c ?? []) add(child, node.id);
	};
	const remove = (id: string) => {
		for (const [childId, n] of [...map]) if (n.parent === id) remove(childId);
		map.delete(id);
	};
	for (const write of writes) {
		if (!write.startsWith(`${ESC}_tsp;f;`)) continue;
		const body = parseTspMessages(write)[0]?.body as { ops: unknown[][] };
		for (const op of body.ops) {
			if (op[0] === "add") add(op[4], String(op[2]));
			else if (op[0] === "del") remove(String(op[1]));
			else if (op[0] === "set") {
				const node = map.get(String(op[1]));
				if (node) node.p = { ...node.p, ...(op[2] as Record<string, unknown>) };
			}
		}
	}
	return map;
}

const action = (body: Record<string, unknown>): TspMessage => ({ verb: "e", body: { ev: "action", sf: "pi", ...body } });

describe("context card through the bridge", () => {
	it("opens from a click on the composer's context meter, as OMP does", () => {
		const { bridge, writes } = harness();
		expect(nodes(writes).get("context-panel")).toBeUndefined();
		bridge.handle(action({ act: "status.context", id: "ctx" }));
		const panel = nodes(writes).get("context-panel");
		expect(panel).toMatchObject({ k: "overlay", p: { role: "pi.context.overlay" } });
		// It floats in the layer with a dismiss target under it, like the git view.
		expect(nodes(writes).get("context-dismiss")).toMatchObject({ parent: "layer" });
		bridge.close();
	});

	it("opens from /context without sending anything to the model", async () => {
		const { bridge, writes, prompt } = harness();
		bridge.setDraft("/context");
		await bridge.submitDraft();
		expect(prompt).not.toHaveBeenCalled();
		expect(nodes(writes).get("context-panel")).toBeDefined();
		// The composer is cleared, so the command is not left sitting in the draft.
		expect(bridge.draft).toBe("");
		bridge.close();
	});

	it("closes on Escape and on its own Close action", async () => {
		const { bridge, writes } = harness();
		bridge.handle(action({ act: "status.context", id: "ctx" }));
		expect(nodes(writes).get("context-panel")).toBeDefined();
		bridge.escape();
		expect(nodes(writes).get("context-panel")).toBeUndefined();
		expect(nodes(writes).get("context-dismiss")).toBeUndefined();
		bridge.handle(action({ act: "status.context", id: "ctx" }));
		bridge.handle(action({ act: "context.close" }));
		expect(nodes(writes).get("context-panel")).toBeUndefined();
		bridge.close();
	});

	it("shows the session's real numbers, not the last frame's", () => {
		const { bridge, writes } = harness({ usage: { tokens: 150_000, contextWindow: 200_000 }, prompt: "p".repeat(4000) });
		bridge.handle(action({ act: "status.context", id: "ctx" }));
		const used = nodes(writes).get("context-used");
		expect(used.p.spans.map((s: any) => s.t).join("")).toBe("150K of 200K tokens · 75%");
		bridge.close();
	});
});
