// The dictation surface contract: a Pi extension that paints plain-text widget lines
// (what `extensions/voice` does with its recording meter) must reach the Tern composer
// as a text node above the editor, with terminal escapes stripped. Custom component
// factories have no Tern owner and are refused, which is why voice's settings panels are
// documented as `pi -nt` only.
import { describe, expect, it } from "vitest";
import { PiTernBridge, type PiSessionLike } from "../../lib/tern/bridge.ts";
import { ESC, parseTspMessages } from "../../lib/tern/tsp.ts";

interface TreeNode {
	id: string;
	k: string;
	p?: Record<string, unknown>;
	c?: TreeNode[];
}

function fakeSession(): PiSessionLike {
	return {
		subscribe: () => () => {},
		prompt: () => new Promise<void>(() => {}),
		abort: async () => {},
		dispose: () => {},
		sessionManager: { getSessionId: () => "s1", getEntries: () => [], getCwd: () => "/work/repo" },
	} as unknown as PiSessionLike;
}

function harness() {
	const writes: string[] = [];
	const bridge = new PiTernBridge(fakeSession(), {
		write: (d: string) => void writes.push(d),
		surfaceId: "pi",
		credits: 8,
	});
	bridge.start();
	return { writes, bridge, ui: bridge.uiContext() as Record<string, (key: string, content: unknown) => void> };
}

// Replays frame ops into the node tree the terminal holds, including ordered child
// lists: an insertion arrives as `add` plus `move`, so sibling order cannot be read
// from a map.
const ORDER = new Map<string, string[]>();
function replay(writes: string[]): Map<string, TreeNode & { parent: string }> {
	const nodes = new Map<string, TreeNode & { parent: string }>();
	ORDER.clear();
	const order = (parent: string): string[] => {
		let list = ORDER.get(parent);
		if (!list) ORDER.set(parent, (list = []));
		return list;
	};
	const detach = (id: string) => {
		const node = nodes.get(id);
		if (!node) return;
		const list = order(node.parent);
		const at = list.indexOf(id);
		if (at >= 0) list.splice(at, 1);
	};
	const place = (id: string, parent: string, before: string | null) => {
		const list = order(parent);
		const at = before ? list.indexOf(before) : -1;
		if (at >= 0) list.splice(at, 0, id);
		else list.push(id);
	};
	const add = (node: TreeNode, parent: string, before: string | null = null) => {
		nodes.set(node.id, { ...node, c: undefined, parent });
		place(node.id, parent, before);
		for (const child of node.c ?? []) add(child, node.id);
	};
	const remove = (id: string) => {
		for (const [childId, n] of [...nodes]) if (n.parent === id) remove(childId);
		detach(id);
		nodes.delete(id);
	};
	for (const w of writes) {
		if (!w.startsWith(`${ESC}_tsp;f;`)) continue;
		const body = parseTspMessages(w)[0]?.body as { ops: unknown[][] };
		for (const op of body.ops) {
			if (op[0] === "add") add(op[4] as TreeNode, String(op[2]), (op[3] as string | null | undefined) ?? null);
			else if (op[0] === "del") remove(String(op[1]));
			else if (op[0] === "move") {
				const id = String(op[1]);
				const parent = String(op[2]);
				const node = nodes.get(id);
				if (!node) continue;
				detach(id);
				node.parent = parent;
				place(id, parent, (op[3] as string | null | undefined) ?? null);
			}
			else if (op[0] === "set") {
				const n = nodes.get(String(op[1]));
				if (n) n.p = { ...n.p, ...(op[2] as Record<string, unknown>) };
			} else if (op[0] === "text") {
				const n = nodes.get(String(op[1]));
				if (n) n.p = { ...n.p, text: `${String(n.p?.text ?? "")}${String(op[3])}` };
			}
		}
	}
	return nodes;
}

const dockOrder = (writes: string[]): string[] => {
	replay(writes);
	return [...(ORDER.get("dock") ?? [])];
};

describe("voice dictation in the Tern surface", () => {
	it("shows the recording meter as a text widget above the composer, escapes stripped", () => {
		const { writes, ui } = harness();
		// Voice paints one themed line per meter tick, bands included.
		ui.setWidget("pi-voice-meter", ["\x1b[36m██▂\x1b[0m  \x1b[2m0:03\x1b[0m  space stop"]);
		const nodes = replay(writes);
		const meter = nodes.get("ui-widget-pi-voice-meter");
		expect(meter).toMatchObject({ k: "text", parent: "dock" });
		expect(meter?.p?.role).toBe("pi.widget");
		expect(meter?.p?.text).toBe("██▂  0:03  space stop");
		expect(String(meter?.p?.text)).not.toContain("\x1b");
		// It sits above the editor, ahead of the composer column in the dock's order.
		const order = dockOrder(writes);
		expect(order.indexOf("ui-widget-pi-voice-meter")).toBeGreaterThanOrEqual(0);
		expect(order.indexOf("ui-widget-pi-voice-meter")).toBeLessThan(order.indexOf("composer-col"));
	});

	it("updates the same node while recording and removes it when capture stops", () => {
		const { writes, ui } = harness();
		ui.setWidget("pi-voice-meter", ["███ 0:01"]);
		ui.setWidget("pi-voice-meter", ["█░░ 0:02  loading model"]);
		// One node, not a second line: the meter replaces itself in place.
		const nodes = replay(writes);
		expect([...nodes.keys()].filter((id) => id === "ui-widget-pi-voice-meter")).toHaveLength(1);
		expect(nodes.get("ui-widget-pi-voice-meter")?.p?.text).toBe("█░░ 0:02  loading model");
		ui.setWidget("pi-voice-meter", undefined);
		expect(replay(writes).get("ui-widget-pi-voice-meter")).toBeUndefined();
	});

	it("refuses a pi-tui component panel with a transcript notice, but resolves a self-completing flow", async () => {
		const { writes, ui } = harness();
		const custom = ui.custom as (factory: unknown) => Promise<unknown>;
		// A component factory (voice's settings menu, pickers) has no Tern owner: the
		// click is answered with an actionable notice rather than a silent no-op.
		const refused = await custom(async () => ({ dispose() {} }));
		expect(refused).toBeUndefined();
		const texts = [...replay(writes).values()].map((n) => String(n.p?.text ?? ""));
		expect(texts.some((t) => t.includes("needs Pi's terminal UI"))).toBe(true);
		// A flow that answers itself (no pi-tui tree to own) still resolves with its value.
		const answered = await custom(async (...args: unknown[]) => {
			const done = args[3] as (value: unknown) => void;
			done("chosen");
			return { dispose() {} };
		});
		expect(answered).toBe("chosen");
	});
});
