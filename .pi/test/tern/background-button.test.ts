// Ctrl+B and Tern's composer button: one dispatch, gated on real state, verified on the wire.
//
// Two levels, deliberately:
//  - the frame level replays the TSP ops Tern applies, so an assertion is about what the pane would draw,
//    not about a private field of the bridge;
//  - the process level runs a real foreground Bash call through SwarmBackgroundProcessManager, so "the
//    command keeps running and its output stays retrievable" is measured, not assumed.
import { afterEach, describe, expect, it } from "vitest";
import { PiTernBridge, type PiEventLike, type PiSessionLike } from "../../lib/tern/bridge.ts";
import { keyEffect } from "../../lib/tern/keys.ts";
import { ESC, parseTspMessages } from "../../lib/tern/tsp.ts";
import { removeRunningWork, runningWorkSnapshot, setRunningWork } from "../../lib/ui/running-work-store.ts";
import { SwarmBackgroundProcessManager } from "../../lib/tools/swarm-bgprocess.ts";

const BASH_DETACH = Symbol.for("pi-swarm-background-bash-detach");
const AGENT_DETACH = Symbol.for("pi-swarm-wait-for-agent-background");
const globals = globalThis as Record<PropertyKey, unknown>;

interface TreeNode { id: string; k: string; p?: Record<string, unknown>; c?: TreeNode[] }

function fakeSession() {
	const listeners = new Set<(e: PiEventLike) => void>();
	const session = {
		subscribe(l: (e: PiEventLike) => void) { listeners.add(l); return () => listeners.delete(l); },
		prompt: () => new Promise<void>(() => {}),
		abort: async () => {},
		dispose() {},
		model: { provider: "anthropic", id: "claude-x" },
		sessionManager: { getSessionId: () => "s1", getEntries: () => [], getBranch: () => [] },
	};
	return session as unknown as PiSessionLike;
}

// Tern applies frame ops to its own tree; doing the same here means the assertions read the drawn dock.
function replay(writes: string[]): Map<string, TreeNode & { parent: string }> {
	const nodes = new Map<string, TreeNode & { parent: string }>();
	const remove = (id: string) => { for (const [childId, n] of [...nodes]) if (n.parent === id) remove(childId); nodes.delete(id); };
	for (const write of writes) {
		if (!write.startsWith(`${ESC}_tsp;f;`)) continue;
		const body = parseTspMessages(write)[0]?.body as { ops: unknown[][] } | undefined;
		for (const op of body?.ops ?? []) {
			if (op[0] === "add") {
				const node = op[4] as TreeNode;
				const parent = String(op[2]);
				const add = (n: TreeNode) => { nodes.set(n.id, { ...n, c: undefined, parent }); for (const child of n.c ?? []) add(child); };
				add(node);
			} else if (op[0] === "del") remove(String(op[1]));
			else if (op[0] === "set") {
				const n = nodes.get(String(op[1]));
				if (n) n.p = { ...n.p, ...(op[2] as Record<string, unknown>) };
			}
		}
	}
	return nodes;
}

function make() {
	const writes: string[] = [];
	const bridge = new PiTernBridge(fakeSession(), { write: (d) => writes.push(d), surfaceId: "pi", credits: 1000 });
	bridge.start("pi");
	const node = () => replay(writes).get("composer-background");
	const action = (act: string) => bridge.handle({ verb: "e", body: { ev: "action", act } } as never);
	return { bridge, writes, node, action };
}

let seq = 0;
const created: string[] = [];
const foregroundBash = (patch: Partial<Record<string, unknown>> = {}) => {
	const id = `bg-btn-${++seq}`;
	created.push(id);
	setRunningWork({ id, kind: "bash", label: "Bash", status: "running", startedAt: Date.now(), detail: "sleep 5", foreground: true, ...patch });
	return id;
};

// Every test starts from an empty store: a leftover foreground item would keep the button on screen.
const saved = new Map<PropertyKey, unknown>();
for (const key of [BASH_DETACH, AGENT_DETACH]) saved.set(key, globals[key]);
afterEach(() => {
	// Restore rather than delete: another test file in this worker may own a writer.
	for (const [key, value] of saved) {
		if (value === undefined) delete globals[key];
		else globals[key] = value;
	}
	for (const id of created.splice(0)) removeRunningWork(id);
});

describe("composer Background button", () => {
	it("is absent when no detach is published, even for a live foreground call", () => {
		// A writer-less foreground item is the honest "nothing to background" case: no key, no button.
		foregroundBash();
		const { bridge, node } = make();
		expect(node()).toBeUndefined();
		bridge.close();
	});

	it("is absent while every live item is already in the background", () => {
		globals[BASH_DETACH] = () => true;
		foregroundBash({ foreground: false });
		const { bridge, node } = make();
		expect(node()).toBeUndefined();
		bridge.close();
	});

	it("draws the chord it stands for and moves the work on click", () => {
		let detaches = 0;
		globals[BASH_DETACH] = () => { detaches++; return true; };
		const id = foregroundBash();
		const { bridge, node, action, writes } = make();
		const button = node();
		// The button names the key it mirrors: a label plus the two keycaps.
		const keys = replay(writes).get("composer-background-keys");
		expect(keys?.p?.keys).toEqual(["ctrl", "b"]);
		expect(node()?.p?.actions).toEqual({ click: "bg.background" });
		expect(button?.p?.role).toBe("omp.composer.background");
		action("bg.background");
		expect(detaches).toBe(1);
		bridge.close();
		expect(id).toBeTruthy();
	});

	it("disappears once the writer marks the item backgrounded, and the card takes over", () => {
		// Mirrors what SwarmBackgroundProcessManager.markBackgrounded does: the store patch is the signal.
		const id = foregroundBash();
		globals[BASH_DETACH] = () => { setRunningWork({ ...runningWorkSnapshot().find((i) => i.id === id)!, foreground: false } as never); return true; };
		const { bridge, node, action } = make();
		expect(node()).toBeDefined();
		action("bg.background");
		expect(node()).toBeUndefined();
		expect(runningWorkSnapshot().find((i) => i.id === id)?.foreground).toBe(false);
		bridge.close();
	});

	it("uses the same dispatch as ctrl+b, in both key encodings", () => {
		let detaches = 0;
		globals[BASH_DETACH] = () => { detaches++; return true; };
		foregroundBash();
		const { bridge } = make();
		expect(keyEffect("\x02")).toEqual({ kind: "detach" });
		expect(keyEffect("\x1b[98;5u")).toEqual({ kind: "detach" });
		expect(bridge.backgroundForegroundWork()).toBe(true);
		expect(detaches).toBe(1);
		bridge.close();
	});
});

describe("real foreground Bash call", () => {
	it("returns the turn, keeps running, and its output is still readable", async () => {
		const manager = new SwarmBackgroundProcessManager();
		globals[BASH_DETACH] = () => manager.requestBackground();
		const running = manager.executeBash({ command: "sleep 3; printf button-proof", timeout_seconds: 60 }, process.cwd());
		// Wait for the manager's own running-work item instead of guessing at a delay.
		const live = await until(() => runningWorkSnapshot().find((i) => i.foreground === true && i.detail === "sleep 3; printf button-proof"));
		expect(live?.kind).toBe("bash");

		const { bridge, node } = make();
		expect(node()).toBeDefined();
		// The manager stores the running-work item when it spawns, a few microtasks before it arms its detach;
		// retry the chord instead of asserting on that internal ordering.
		expect(await until(() => (bridge.backgroundForegroundWork() ? true : undefined), 600)).toBe(true);

		// The tool call stops waiting, which is the whole point of the chord.
		const result = await running;
		expect(JSON.parse(result.text)).toMatchObject({ backgrounded: true, status: "running" });
		expect(runningWorkSnapshot().find((i) => i.id === live!.id)?.foreground).toBe(false);

		// The child kept running after the call returned, and its output is still retrievable.
		const done = await until(() => runningWorkSnapshot().find((i) => i.id === live!.id && i.status === "running"), 100);
		expect(done).toBeDefined();
		const status = JSON.parse((await manager.read({ task_id: live!.id, action: "status", format: "json" })).text);
		expect(status).toMatchObject({ task_id: live!.id });
		await manager.read({ task_id: live!.id, action: "cancel" });
		bridge.close();
	}, 30_000);
});

async function until<T>(check: () => T | undefined, tries = 200): Promise<T> {
	for (let i = 0; i < tries; i++) {
		const value = check();
		if (value !== undefined) return value;
		await new Promise((r) => setTimeout(r, 25));
	}
	throw new Error("condition never held");
}
