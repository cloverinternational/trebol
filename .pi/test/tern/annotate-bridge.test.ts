import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiTernBridge, type PiEventLike, type PiSessionLike } from "../../lib/tern/bridge.ts";
import { encodePng } from "../../lib/tern/png-crop.ts";
import type { TspNode } from "../../lib/tern/tsp.ts";

function fixturePng(width = 120, height = 60): Buffer {
	const rgba = Buffer.alloc(width * height * 4, 200);
	for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
	return encodePng({ width, height, rgba });
}

function fakeSession(cwd: string) {
	const listeners = new Set<(e: PiEventLike) => void>();
	const session: PiSessionLike & { emit(e: PiEventLike): void } = {
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		prompt() {
			return new Promise<void>(() => {});
		},
		async abort() {},
		dispose() {},
		sessionManager: { getCwd: () => cwd } as unknown as PiSessionLike["sessionManager"],
		emit(event) {
			for (const listener of listeners) listener(event);
		},
	};
	return session;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

function findDockNode(nodes: readonly TspNode[], id: string): TspNode | undefined {
	for (const node of nodes) {
		if (node.id === id) return node;
		const hit = findDockNode(node.c ?? [], id);
		if (hit) return hit;
	}
	return undefined;
}

// A Read result is how a picture reaches the transcript; the bridge previews it from the file on disk.
async function showPicture(bridge: PiTernBridge, session: ReturnType<typeof fakeSession>, path: string): Promise<void> {
	session.emit({ type: "tool_execution_start", toolCallId: "c1", toolName: "Read", args: { file_path: path } } as PiEventLike);
	session.emit({ type: "tool_execution_end", toolCallId: "c1", toolName: "Read", result: { content: [] }, isError: false } as PiEventLike);
	// Previewing reads and hashes the file; under a loaded suite that takes longer than one tick.
	for (let i = 0; i < 100; i++) {
		await tick();
		if ((bridge.items[0] as { artifacts?: unknown[] } | undefined)?.artifacts?.length) return;
	}
	throw new Error("the Read result never produced a preview");
}

function bridgeFor(session: ReturnType<typeof fakeSession>): PiTernBridge {
	const bridge = new PiTernBridge(session, { write: () => {}, surfaceId: "pi", credits: 1000 });
	// Tern opens the surface first; every render and stylesheet needs that handshake.
	bridge.start("pi");
	return bridge;
}

describe("annotate a presented picture", () => {
	it("/annotate puts the newest picture on a stage with a click grid and controls", async () => {
		const dir = mkdtempSync(join(tmpdir(), "annotate-"));
		const png = join(dir, "shot.png");
		writeFileSync(png, fixturePng());
		const session = fakeSession(dir);
		const bridge = bridgeFor(session);
		await showPicture(bridge, session, png);

		await bridge.submit("/annotate");
		const dock = bridge.debugView().dock;
		const card = findDockNode(dock, "annotate-card");
		expect(card?.p?.head).toBe("Annotate shot.png");
		expect(findDockNode(dock, "annotate-image")).toBeTruthy();
		expect(findDockNode(dock, "annotate-cell-0-0")).toBeTruthy();
		expect(findDockNode(dock, "annotate-cursor")).toBeTruthy();
		// The stage sheet is installed before the frame that needs it.
		expect(findDockNode(dock, "annotate-note")).toBeTruthy();
		bridge.close();
	});

	it("a cell click places the crosshair, Enter pins, the note is typed, and sending attaches the marked copy", async () => {
		const dir = mkdtempSync(join(tmpdir(), "annotate-"));
		const png = join(dir, "shot.png");
		writeFileSync(png, fixturePng(120, 60));
		const session = fakeSession(dir);
		const bridge = bridgeFor(session);
		await showPicture(bridge, session, png);
		await bridge.submit("/annotate");

		bridge.handle({ verb: "e", body: { ev: "action", act: "annotate.cell", id: "annotate-cell-4-8" } });
		bridge.handle({ verb: "e", body: { ev: "key", key: "enter" } });
		bridge.handle({ verb: "e", body: { ev: "key", key: "right" } });
		bridge.handle({ verb: "e", body: { ev: "action", act: "annotate.cell", id: "annotate-cell-4-8" } });
		bridge.handle({ verb: "e", body: { ev: "key", key: "enter" } });
		bridge.handle({ verb: "e", body: { ev: "focus", id: "annotate-note" } });
		bridge.handle({ verb: "e", body: { ev: "edit", id: "annotate-note", from: 0, to: 0, text: "not here", cursor: 8 } });

		const dock = bridge.debugView().dock;
		expect(findDockNode(dock, "annotate-pin-1")).toBeTruthy();
		expect(findDockNode(dock, "annotate-pin-2")).toBeTruthy();
		expect(findDockNode(dock, "annotate-note")?.p?.text).toBe("not here");

		bridge.handle({ verb: "e", body: { ev: "action", act: "annotate.send" } });
		await tick();

		expect(bridge.draft).toContain("Annotated shot.png (120×60)");
		expect(bridge.draft).toContain("not here");
		expect(bridge.draft).toContain('"marks"');
		// The path is in the text as well as the chip: a model without vision still has the file.
		expect(bridge.draft).toMatch(/Saved copy: artifacts\/annotations\/shot-annotated-[a-z0-9]+\.png/);
		expect(findDockNode(bridge.debugView().dock, "annotate-card")).toBeUndefined();
		const files = join(dir, "artifacts", "annotations");
		expect(existsSync(files)).toBe(true);
		bridge.close();
	});

	it("Escape discards the stage without touching the draft", async () => {
		const dir = mkdtempSync(join(tmpdir(), "annotate-"));
		const png = join(dir, "shot.png");
		writeFileSync(png, fixturePng());
		const session = fakeSession(dir);
		const bridge = bridgeFor(session);
		await showPicture(bridge, session, png);
		await bridge.submit("/annotate");
		bridge.handle({ verb: "e", body: { ev: "key", key: "enter" } });
		bridge.handle({ verb: "e", body: { ev: "key", key: "escape" } });
		expect(findDockNode(bridge.debugView().dock, "annotate-card")).toBeUndefined();
		expect(bridge.draft).toBe("");
		bridge.close();
	});

	it("the artifact card's Mark up action opens the stage on that preview", async () => {
		const dir = mkdtempSync(join(tmpdir(), "annotate-"));
		const png = join(dir, "shot.png");
		writeFileSync(png, fixturePng());
		const session = fakeSession(dir);
		const bridge = bridgeFor(session);
		await showPicture(bridge, session, png);

		const card = findDockNode(bridge.debugView().main, "t-c1-art-0");
		expect(card?.c?.some((node) => node.id === "t-c1-art-0-annotate")).toBe(true);
		bridge.handle({ verb: "e", body: { ev: "action", act: "artifact.annotate", id: "t-c1-art-0-annotate" } });
		expect(findDockNode(bridge.debugView().dock, "annotate-card")?.p?.head).toBe("Annotate shot.png");
		bridge.close();
	});

	it("explains when nothing in the transcript can be annotated", async () => {
		const dir = mkdtempSync(join(tmpdir(), "annotate-"));
		const session = fakeSession(dir);
		const bridge = bridgeFor(session);
		await bridge.submit("/annotate");
		expect(findDockNode(bridge.debugView().dock, "annotate-card")).toBeUndefined();
		expect(bridge.items.at(-1)?.text).toContain("No previewable picture");
		bridge.close();
	});
});

describe("edit a Mermaid diagram", () => {
	it("/diagram puts the last diagram's source in the composer for editing", async () => {
		const dir = mkdtempSync(join(tmpdir(), "annotate-"));
		const session = fakeSession(dir);
		const bridge = bridgeFor(session);
		const message = { role: "assistant", content: [{ type: "text", text: "Here it is:\n\n```mermaid\nflowchart LR\n  A --> B\n```\n" }] };
		session.emit({ type: "message_start", message: { role: "assistant", content: [] } } as PiEventLike);
		session.emit({ type: "message_end", message } as PiEventLike);

		await bridge.submit("/diagram");
		expect(bridge.draft).toContain("flowchart LR");
		expect(bridge.draft).toContain("A --> B");
		expect(bridge.draft).toContain("Change: ");
		bridge.close();
	});

	it("says so when no diagram exists", async () => {
		const dir = mkdtempSync(join(tmpdir(), "annotate-"));
		const session = fakeSession(dir);
		const bridge = bridgeFor(session);
		await bridge.submit("/diagram");
		expect(bridge.items.at(-1)?.text).toContain("No Mermaid diagram");
		bridge.close();
	});
});
