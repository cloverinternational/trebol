import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	credentialValue, HOJA_URL_DEFAULT, HOJA_URL_VARS, HOJA_TOKEN_VARS, HojaClient, HojaRequestError,
	MISSING_HOJA_TOKEN,
} from "../../lib/claw/hoja.ts";

const VARS = [...HOJA_TOKEN_VARS, ...HOJA_URL_VARS];
const saved = new Map<string, string | undefined>();

beforeEach(() => {
	saved.clear();
	for (const name of VARS) {
		saved.set(name, process.env[name]);
		delete process.env[name];
	}
});

afterEach(() => {
	for (const [name, value] of saved) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
});

/** Records the request the client would send, so the test asserts on the wire values, not on private fields. */
function recorder() {
	const calls: { url: string; authorization: string; query: string }[] = [];
	const fetch = async (url: string, init: { headers: Record<string, string>; body: string }) => {
		calls.push({
			url,
			authorization: init.headers.Authorization,
			query: JSON.parse(init.body).query as string,
		});
		return { status: 200, text: async () => JSON.stringify({ data: { viewer: { id: "u1" } } }) };
	};
	return { calls, fetch };
}

describe("Hoja credentials", () => {
	// Acceptance case 1 from the issue: canonical HOJA_* only must authenticate, and must not report a
	// credentials-not-set error.
	it("authenticates with only HOJA_TOKEN and HOJA_API_URL exported", async () => {
		process.env.HOJA_TOKEN = "hoja_canonical_token";
		process.env.HOJA_API_URL = "https://app.hoja.work/graphql";
		const { calls, fetch } = recorder();
		const client = new HojaClient({ fetch: fetch as any });

		await expect(client.gql("{ viewer { id } }")).resolves.toEqual({ viewer: { id: "u1" } });
		expect(calls).toEqual([
			{ url: "https://app.hoja.work/graphql", authorization: "hoja_canonical_token", query: "{ viewer { id } }" },
		]);
	});

	it("keeps the deprecated LINEAR_* aliases working when the canonical pair is absent", async () => {
		process.env.LINEAR_TOKEN = "lin_legacy_token";
		process.env.LINEAR_API_URL = "https://legacy.test/graphql";
		const { calls, fetch } = recorder();
		const client = new HojaClient({ fetch: fetch as any });

		await client.gql("{ viewer { id } }");
		expect(calls[0]).toMatchObject({ url: "https://legacy.test/graphql", authorization: "lin_legacy_token" });
	});

	it("prefers the canonical token and URL over the deprecated aliases, even when both are set", async () => {
		process.env.HOJA_TOKEN = "hoja_canonical_token";
		process.env.HOJA_API_URL = "https://app.hoja.work/graphql";
		process.env.LINEAR_TOKEN = "lin_legacy_token";
		process.env.LINEAR_API_URL = "https://legacy.test/graphql";
		const { calls, fetch } = recorder();
		const client = new HojaClient({ fetch: fetch as any });

		await client.gql("{ viewer { id } }");
		expect(credentialValue(HOJA_TOKEN_VARS)).toBe("hoja_canonical_token");
		expect(credentialValue(HOJA_URL_VARS)).toBe("https://app.hoja.work/graphql");
		expect(calls[0]).toMatchObject({ url: "https://app.hoja.work/graphql", authorization: "hoja_canonical_token" });
	});

	it("treats a blank canonical variable as unset instead of sending an empty bearer", () => {
		process.env.HOJA_TOKEN = "   ";
		process.env.LINEAR_TOKEN = "lin_legacy_token";
		expect(credentialValue(HOJA_TOKEN_VARS)).toBe("lin_legacy_token");
	});

	it("falls back to the default endpoint when neither URL variable is exported", async () => {
		process.env.HOJA_TOKEN = "hoja_canonical_token";
		const { calls, fetch } = recorder();
		await new HojaClient({ fetch: fetch as any }).gql("{ viewer { id } }");
		expect(calls[0].url).toBe(HOJA_URL_DEFAULT);
	});

	// Acceptance case 2 from the issue: with no credentials at all the error must name HOJA_TOKEN first and
	// mention LINEAR_TOKEN only as a deprecated fallback.
	it("names HOJA_TOKEN before LINEAR_TOKEN when no credential is configured", async () => {
		const client = new HojaClient({ fetch: recorder().fetch as any });
		const error = await client.gql("{ viewer { id } }").catch((e: Error) => e);

		expect(error).toBeInstanceOf(HojaRequestError);
		const message = String((error as Error).message);
		expect(message).toBe(MISSING_HOJA_TOKEN);
		expect(message).toContain("HOJA_TOKEN is not set");
		expect(message.indexOf("HOJA_TOKEN")).toBeLessThan(message.indexOf("LINEAR_TOKEN"));
		expect(message).toMatch(/LINEAR_TOKEN is also unset/);
		expect(message).toMatch(/deprecated fallback/);
	});
});
