import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearMcpStatus, displayServerName, publishMcpStatus, readMcpStatus, subscribeMcpStatus } from "../../lib/tools/mcp-status.ts";

const KEY = Symbol.for("pi-swarm-mcp-status");
const owner = {};
const other = {};

beforeEach(() => { (globalThis as Record<symbol, unknown>)[KEY] = undefined; });
afterEach(() => { (globalThis as Record<symbol, unknown>)[KEY] = undefined; });

describe("MCP status state", () => {
 it("isolates concurrent session readers", () => { publishMcpStatus(owner,["one"],"a"); publishMcpStatus(other,["two"],"b"); expect(readMcpStatus("a")).toEqual({connected:["one"]}); expect(readMcpStatus("b")).toEqual({connected:["two"]}); expect(readMcpStatus("c")).toBeUndefined(); clearMcpStatus(owner); expect(readMcpStatus("b")).toEqual({connected:["two"]}); });
	it("is unavailable until an owner publishes, and none when it publishes an empty list", () => {
		expect(readMcpStatus()).toBeUndefined();
		publishMcpStatus(owner, []);
		expect(readMcpStatus()).toEqual({ connected: [] });
	});

	it("publishes display-safe, de-duplicated server names only", () => {
		publishMcpStatus(owner, ["hoja", "hoja", "bad name/with?query=https://x", "a".repeat(80)]);
		const names = readMcpStatus()?.connected ?? [];
		expect(names).toEqual(["hoja", "MCP server", "a".repeat(64)]);
		expect(displayServerName("tok_en:secret@host")).toBe("MCP server");
	});

	it("returns a copy so readers cannot mutate the published list", () => {
		publishMcpStatus(owner, ["hoja"]);
		readMcpStatus()?.connected.push("injected");
		expect(readMcpStatus()).toEqual({ connected: ["hoja"] });
	});

	it("lets only the owner that published clear the status", () => {
		publishMcpStatus(owner, ["hoja"]);
		clearMcpStatus(other);
		expect(readMcpStatus()).toEqual({ connected: ["hoja"] });
		clearMcpStatus(owner);
		expect(readMcpStatus()).toBeUndefined();
	});

	it("a newer owner replaces the previous owner, so the stale owner cannot clear it", () => {
		publishMcpStatus(owner, ["old"]);
		publishMcpStatus(other, ["new"]);
		clearMcpStatus(owner);
		expect(readMcpStatus()).toEqual({ connected: ["new"] });
	});

	it("notifies subscribers on publish and clear, stops after unsubscribe, and survives a throwing listener", () => {
		const seen = vi.fn();
		const throwing = vi.fn(() => { throw new Error("listener failure"); });
		const unsubscribe = subscribeMcpStatus(seen);
		subscribeMcpStatus(throwing);
		publishMcpStatus(owner, ["hoja"]);
		expect(seen).toHaveBeenCalledTimes(1);
		expect(throwing).toHaveBeenCalledTimes(1);
		clearMcpStatus(owner);
		expect(seen).toHaveBeenCalledTimes(2);
		unsubscribe();
		publishMcpStatus(owner, []);
		expect(seen).toHaveBeenCalledTimes(2);
	});
});
