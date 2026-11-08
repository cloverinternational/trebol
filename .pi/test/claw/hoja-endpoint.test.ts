import { describe, expect, it } from "vitest";
import {
	HOJA_ENDPOINT_HINT, HojaClient, MISSING_HOJA_TOKEN, resolveHojaToken, resolveHojaUrl,
} from "../../lib/claw/hoja.ts";

const RETIRED_HOST = "hoja.clover4.app";

describe("Hoja endpoint resolution", () => {
	it("prefers HOJA_API_URL over the legacy variable", () => {
		expect(resolveHojaUrl({ HOJA_API_URL: "https://hoja.hoja.work/graphql", LINEAR_API_URL: "https://legacy.test/graphql" }))
			.toBe("https://hoja.hoja.work/graphql");
	});

	it("still honours the legacy LINEAR_API_URL", () => {
		expect(resolveHojaUrl({ LINEAR_API_URL: "https://legacy.test/graphql" })).toBe("https://legacy.test/graphql");
	});

	it("derives /graphql from the host of HOJA_MCP_URL, so one setting points Hoja work at the same remote", () => {
		expect(resolveHojaUrl({ HOJA_MCP_URL: "https://hoja.hoja.work/mcp" })).toBe("https://hoja.hoja.work/graphql");
	});

	it("honours an explicit option above every variable", () => {
		expect(resolveHojaUrl({ HOJA_API_URL: "https://a.test/graphql" }, "https://explicit.test/graphql"))
			.toBe("https://explicit.test/graphql");
	});

	it("never falls back to a baked-in host", () => {
		const resolved = resolveHojaUrl({});
		expect(resolved).toBe("");
		expect(resolved).not.toContain(RETIRED_HOST);
	});

	it("ignores an unparseable HOJA_MCP_URL instead of guessing", () => {
		expect(resolveHojaUrl({ HOJA_MCP_URL: "not a url" })).toBe("");
	});
});

describe("Hoja token resolution", () => {
	it("prefers HOJA_TOKEN over LINEAR_TOKEN", () => {
		expect(resolveHojaToken({ HOJA_TOKEN: "hoja", LINEAR_TOKEN: "linear" })).toBe("hoja");
	});

	it("still accepts the legacy LINEAR_TOKEN", () => {
		expect(resolveHojaToken({ LINEAR_TOKEN: "linear" })).toBe("linear");
	});

	it("is empty when nothing is configured", () => {
		expect(resolveHojaToken({})).toBe("");
	});
});

describe("HojaClient fails closed", () => {
	it("names the variables instead of calling a default host", async () => {
		const client = new HojaClient({ url: "", token: "t" });
		await expect(client.gql("query { viewer { id } }")).rejects.toThrow(/No Hoja endpoint configured/);
	});

	it("reports a missing token with the same guidance", async () => {
		const client = new HojaClient({ url: "https://hoja.test/graphql", token: "" });
		await expect(client.gql("query { viewer { id } }")).rejects.toThrow(MISSING_HOJA_TOKEN);
	});

	it("keeps the guidance in one exported place", () => {
		expect(HOJA_ENDPOINT_HINT).toContain("HOJA_API_URL");
		expect(HOJA_ENDPOINT_HINT).toContain("HOJA_MCP_URL");
	});
});
