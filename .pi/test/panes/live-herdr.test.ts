/**
 * Live smoke test against the real `herdr` binary and a real server.
 *
 * Skipped unless HERDR_LIVE=1, because it needs a running server and a workspace:
 *
 *   herdr server & ; herdr workspace create --label smoke --cwd /tmp
 *   HERDR_LIVE=1 npx vitest run .pi/test/panes/live-herdr.test.ts
 *
 * The fake-runner suite proves parsing; this proves the flags, the shapes and the ownership
 * rules still match what the installed binary actually does.
 */

import { describe, expect, it } from "vitest";
import { HerdrError, createHerdrBackend } from "../../lib/panes/herdr.ts";

const live = process.env.HERDR_LIVE === "1";

describe.skipIf(!live)("herdr live", () => {
	it("inspects a real workspace", async () => {
		const backend = createHerdrBackend();
		const inspect = await backend.inspect();
		expect(inspect.sessions).toHaveLength(1);
		const tabs = inspect.sessions[0].tabs;
		expect(tabs.length).toBeGreaterThan(0);
		expect(tabs.flatMap((t) => t.blocks).length).toBeGreaterThan(0);
	});

	it("creates a tab, drives it, reads it back, and closes it", async () => {
		const backend = createHerdrBackend();
		const made = await backend.newTab({ cwd: "/tmp", label: "smoke" });
		expect(made.block).toBeGreaterThan(0);
		await backend.send(made.block, "echo smoke-marker-42", { enter: true });
		const answer = await backend.read(made.block, { until: "smoke-marker-42", timeout: 20 });
		expect(answer.matched).toBe(true);
		expect(answer.text).toContain("smoke-marker-42");
		await backend.close(made.block);
	});

	it("refuses to drive a pane it did not create", async () => {
		const backend = createHerdrBackend();
		const inspect = await backend.inspect();
		const foreign = inspect.sessions[0].tabs.flatMap((t) => t.blocks)[0].id;
		await expect(backend.send(foreign, "nope", { enter: true })).rejects.toBeInstanceOf(HerdrError);
	});

	it("splits a pane it is allowed to touch", async () => {
		const backend = createHerdrBackend(undefined, { enforceOwnership: false });
		const inspect = await backend.inspect();
		const anchor = inspect.sessions[0].tabs.flatMap((t) => t.blocks)[0].id;
		const { block } = await backend.split({ pane: anchor, direction: "right" });
		expect(block).toBeGreaterThan(0);
		await backend.close(block);
	});
});
