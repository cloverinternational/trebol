import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { nameFromUrl, parseAddInput, piMcpAdd, tokenize } from "../../lib/tools/mcp-add.ts";
import { registerMcpFallback } from "../../../extensions/mcp-fallback/extension.ts";

const ok = (text: string) => {
	const parsed = parseAddInput(text);
	if ("error" in parsed) throw new Error(parsed.error);
	return parsed;
};

describe("parseAddInput", () => {
	it("reads README snippets in every common shape", () => {
		expect(ok('{"mcpServers":{"fs":{"command":"npx","args":["-y","@modelcontextprotocol/server-filesystem","."]}}}').requests)
			.toEqual([{ name: "fs", args: ["fs", "--", "npx", "-y", "@modelcontextprotocol/server-filesystem", "."] }]);
		expect(ok('{"servers":{"docs":{"type":"http","url":"https://example.com/mcp"}}}').requests)
			.toEqual([{ name: "docs", args: ["docs", "--url", "https://example.com/mcp"] }]);
		expect(ok('"sentry": { "url": "https://mcp.sentry.dev/mcp" },').requests[0]!.name).toBe("sentry");
		expect(ok('{"a":{"url":"https://a.example/mcp"},"b":{"command":"b"}}').requests.map((r) => r.name)).toEqual(["a", "b"]);
	});

	it("carries env, headers, cwd, exposure and reports fields Pi does not have", () => {
		const parsed = ok('{"mcpServers":{"x":{"command":"srv","env":{"HOME_DIR":"/tmp"},"cwd":"/w","exposure":"direct","autoApprove":[]}}}');
		expect(parsed.requests[0]!.args).toEqual(["x", "--exposure", "direct", "--env", "HOME_DIR=/tmp", "--cwd", "/w", "--", "srv"]);
		expect(parsed.warnings).toEqual(['x: ignored "autoApprove" (Pi\'s mcp.json has no such field)']);
		expect(parsed.secrets).toEqual([]);
	});

	it("flags literal secrets but not ${VAR} or !command references", () => {
		expect(ok('{"mcpServers":{"d":{"url":"https://d.example","headers":{"Authorization":"Bearer abcdefghijklmnop"}}}}').secrets).toEqual(["d: header Authorization"]);
		expect(ok('{"mcpServers":{"d":{"url":"https://d.example","headers":{"Authorization":"Bearer ${DOCS_TOKEN}"}}}}').secrets).toEqual([]);
		expect(ok('{"mcpServers":{"g":{"command":"g","env":{"GITHUB_TOKEN":"!gh auth token"}}}}').secrets).toEqual([]);
		expect(ok('{"mcpServers":{"g":{"command":"g","env":{"GITHUB_TOKEN":"ghp_1234567890"}}}}').secrets).toEqual(["g: env GITHUB_TOKEN"]);
		expect(ok("g --env API_KEY=abc -- g").secrets).toEqual(["g: env API_KEY"]);
	});

	it("reads URLs and pi mcp add arguments", () => {
		expect(ok("https://mcp.sentry.dev/mcp").requests).toEqual([{ name: "sentry", args: ["sentry", "--url", "https://mcp.sentry.dev/mcp"] }]);
		expect(ok("docs https://example.com/mcp").requests[0]!.args).toEqual(["docs", "--url", "https://example.com/mcp"]);
		expect(ok('pi mcp add fs --exposure direct -- npx -y "my server"').requests[0]!.args).toEqual(["fs", "--exposure", "direct", "--", "npx", "-y", "my server"]);
	});

	it("refuses input it cannot name or read", () => {
		expect(parseAddInput("")).toHaveProperty("error");
		expect(parseAddInput('{"command":"x"}')).toMatchObject({ error: expect.stringContaining("without a name") });
		expect(parseAddInput("{nope")).toMatchObject({ error: expect.stringContaining("Not valid JSON") });
		expect(parseAddInput('{"mcpServers":{"x":{"args":[]}}}')).toMatchObject({ error: expect.stringContaining('"url" or "command"') });
		expect(parseAddInput("--url https://x")).toHaveProperty("error");
	});

	it("tokenizes like a shell and names servers from hosts", () => {
		expect(tokenize(`a "b c" 'd e' f\\ g ""`)).toEqual(["a", "b c", "d e", "f g", ""]);
		expect(nameFromUrl("https://api.githubcopilot.com/mcp/")).toBe("githubcopilot");
		expect(nameFromUrl("not a url")).toBeUndefined();
	});
});

describe("piMcpAdd runs Pi's own pi mcp add", () => {
	it("writes the global mcp.json, and Pi's validator rejects bad input", async () => {
		const dir = mkdtempSync(join(tmpdir(), "mcp-add-"));
		const added = await piMcpAdd(ok('{"mcpServers":{"fs":{"command":"npx","args":["-y","srv"],"exposure":"direct"}}}').requests[0]!.args, { cwd: dir, agentDir: dir });
		expect(added.ok).toBe(true);
		expect(added.lines[0]).toMatch(/^Added global MCP server "fs"/);
		expect(JSON.parse(readFileSync(join(dir, "mcp.json"), "utf8")).mcpServers.fs).toEqual({ command: "npx", args: ["-y", "srv"], exposure: "direct" });
		const bad = await piMcpAdd(["bad name", "--url", "https://x.example"], { cwd: dir, agentDir: dir });
		expect(bad.ok).toBe(false);
		expect(bad.lines.join("\n")).toMatch(/invalid server name/);
	});

	it("writes the project file with project: true", async () => {
		const dir = mkdtempSync(join(tmpdir(), "mcp-add-"));
		const result = await piMcpAdd(["docs", "--url", "https://docs.example/mcp"], { cwd: dir, agentDir: dir, project: true });
		expect(result.ok).toBe(true);
		expect(existsSync(join(dir, ".pi", "mcp.json"))).toBe(true);
		expect(existsSync(join(dir, "mcp.json"))).toBe(false);
	});
});

describe("/mcp-add", () => {
	function command() {
		const commands = new Map<string, any>();
		const pi: any = { mcpManifests: [], on: vi.fn(), registerTool: vi.fn(), registerCommand: (n: string, s: any) => commands.set(n, s), getCommands: () => [{ name: "mcp" }] };
		registerMcpFallback(pi);
		return commands.get("mcp-add");
	}

	it("asks for nothing when the secret guard declines, and writes nothing", async () => {
		const dir = mkdtempSync(join(tmpdir(), "mcp-add-"));
		const notes: string[] = [];
		const reload = vi.fn();
		await command().handler('-l {"mcpServers":{"d":{"url":"https://d.example","headers":{"Authorization":"Bearer abcdefghijklmnop"}}}}', { cwd: dir, reload, ui: { notify: (m: string) => notes.push(m), confirm: async () => false } });
		expect(existsSync(join(dir, ".pi", "mcp.json"))).toBe(false);
		expect(reload).not.toHaveBeenCalled();
		expect(notes.at(-1)).toMatch(/\$\{ENV_VAR\}/);
	});

	it("pastes through the editor, asks where to save, writes with Pi and reloads", async () => {
		const dir = mkdtempSync(join(tmpdir(), "mcp-add-"));
		const notes: string[] = [];
		const reload = vi.fn(async () => {});
		const ui = { notify: (m: string) => notes.push(m), editor: async () => "docs https://docs.example/mcp", select: async (_t: string, options: string[]) => options[1] };
		await command().handler("", { cwd: dir, reload, waitForIdle: async () => {}, ui });
		expect(JSON.parse(readFileSync(join(dir, ".pi", "mcp.json"), "utf8")).mcpServers.docs).toEqual({ url: "https://docs.example/mcp" });
		expect(notes.join("\n")).toMatch(/Added project MCP server "docs"/);
		expect(reload).toHaveBeenCalledOnce();
	});
});
