
import { describe, expect, it } from "vitest";
import { createHerdrBackend, HerdrError, parseEnvelope, tabDisplayName, type HerdrRun } from "../../lib/panes/herdr.ts";

// Answers captured from herdr 0.9.5 while a server is up.
const TAB_LIST = `{"id":"cli:tab:list","result":{"type":"tab_list","tabs":[{"tab_id":"w1:t1","label":"1","number":1,"pane_count":2,"workspace_id":"w1","focused":true,"agent_status":"unknown"},{"tab_id":"w1:t2","label":"build","number":2,"pane_count":1,"workspace_id":"w1","focused":false,"agent_status":"unknown"}]}}`;
const PANE_LIST = `{"id":"cli:pane:list","result":{"type":"pane_list","panes":[{"pane_id":"w1:p1","tab_id":"w1:t1","workspace_id":"w1","cwd":"/tmp","foreground_cwd":"/tmp","focused":true,"terminal_id":"term_a","revision":1,"scroll":{"offset":0},"agent_status":"unknown"},{"pane_id":"w1:p2","tab_id":"w1:t1","workspace_id":"w1","cwd":"/work","foreground_cwd":"/work/sub","focused":false,"terminal_id":"term_b","revision":1,"scroll":{"offset":0},"agent_status":"unknown"},{"pane_id":"w1:p3","tab_id":"w1:t2","workspace_id":"w1","cwd":"/srv","focused":false,"terminal_id":"term_c","revision":1,"scroll":{"offset":0},"agent_status":"unknown"}]}}`;
// The same list after a tab was created: a new tab means a new pane in it.
const PANE_LIST_WITH_NEW_TAB = PANE_LIST.replace(
	`"panes":[`,
	`"panes":[{"pane_id":"w1:p9","tab_id":"w1:t9","workspace_id":"w1","cwd":"/tmp","focused":false,"agent_status":"unknown"},`,
);
const PANE_SPLIT = `{"id":"cli:pane:split","result":{"type":"pane_info","pane":{"pane_id":"w1:p4","tab_id":"w1:t1","workspace_id":"w1","cwd":"/tmp"}}}`;
const TAB_CREATE = `{"id":"cli:tab:create","result":{"type":"tab_info","tab":{"tab_id":"w1:t9","label":"9","number":9,"workspace_id":"w1","focused":false}}}`;
const WAIT_MATCHED = `{"id":"cli:pane:wait-output","result":{"pane_id":"w1:p1","matched_line":"ready>","read":{"text":"booting\\nready>","truncated":false}}}`;
const READ_TEXT = "line one\nline two\nready>";

// The one that matters: herdr refuses with an envelope, and the exit status does not mean what it
// usually means. Observed on this host: status 1, body on stderr. The plan's fact table recorded
// status 0 on stdout. Both cases are covered below.
const SERVER_DOWN = `{"id":"cli:pane:list","error":{"code":"server_not_running","message":"no herdr server is running at /home/robert/.config/herdr/herdr.sock; run \`herdr\` to start or attach it"}}`;
const WAIT_TIMEOUT = `{"id":"cli:pane:wait-output","error":{"code":"wait_timeout","message":"no matching output within 30000ms"}}`;

const STATUS_DOWN = `client:
  version: 0.9.5
  channel: stable
  protocol: 22
  endpoint_protocol_generation: 1

server:
  status: not running
  socket: /home/robert/.config/herdr/herdr.sock

update:
  restart_needed: no
  server_binary_stale: no`;
const STATUS_UP = STATUS_DOWN.replace("status: not running", "status: running");

type Reply = { stdout?: string; stderr?: string; code?: number } | string;

/** A stand-in for the herdr binary: routes by the two-word command and records every call. */
function fakeHerdr(routes: Record<string, Reply | Reply[]>) {
	const calls: string[][] = [];
	const run: HerdrRun = async (args, signal) => {
		calls.push(args);
		expect(signal === undefined || signal instanceof AbortSignal).toBe(true);
		const key = args.slice(0, 2).join(" ");
		const route = routes[key];
		if (route === undefined) throw new Error(`unexpected herdr command: ${key} (${args.join(" ")})`);
		const reply = Array.isArray(route) ? route.shift() : route;
		if (reply === undefined) throw new Error(`no more canned replies for herdr ${key}`);
		const out = typeof reply === "string" ? { stdout: reply } : reply;
		return { stdout: out.stdout ?? "", stderr: out.stderr, code: out.code };
	};
	return { run, calls };
}

const argv = (calls: string[][], command: string) => calls.filter((args) => args.slice(0, 2).join(" ") === command);

/** A backend that has already read herdr's tabs and panes, so its numeric block ids exist. */
async function observed(routes: Record<string, Reply | Reply[]> = {}, options: { enforceOwnership?: boolean } = {}) {
	const fake = fakeHerdr({ "tab list": TAB_LIST, "pane list": PANE_LIST, ...routes });
	const backend = createHerdrBackend(fake.run, options);
	const tree = await backend.inspect();
	const blocks = tree.sessions[0].tabs.flatMap((tab) => tab.blocks.map((block) => block.id));
	return { backend, calls: fake.calls, blocks };
}

describe("parseEnvelope", () => {
	it("returns the result of an ok envelope", () => {
		const result = parseEnvelope(TAB_LIST, "tab list") as { type: string; tabs: unknown[] };
		expect(result.type).toBe("tab_list");
		expect(result.tabs).toHaveLength(2);
	});

	it("throws the envelope's own error code, not a generic failure", () => {
		let thrown: unknown;
		try {
			parseEnvelope(SERVER_DOWN, "pane list");
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(HerdrError);
		expect((thrown as HerdrError).code).toBe("server_not_running");
		expect((thrown as HerdrError).message).toContain("no herdr server is running");
	});

	it("names empty and non-envelope output instead of guessing at it", () => {
		try {
			parseEnvelope("", "tab list");
		} catch (error) {
			expect((error as HerdrError).code).toBe("empty_output");
		}
		try {
			parseEnvelope("just some terminal text", "pane list");
		} catch (error) {
			expect((error as HerdrError).code).toBe("unparseable_output");
		}
		expect(() => parseEnvelope("", "tab list")).toThrowError(HerdrError);
	});
});

describe("a refusal with a meaningless exit status", () => {
	it("raises server_not_running when the envelope arrives with exit status 0", async () => {
		const fake = fakeHerdr({
			"tab list": { stdout: SERVER_DOWN, code: 0 },
			"pane list": { stdout: SERVER_DOWN, code: 0 },
		});
		await expect(createHerdrBackend(fake.run).inspect()).rejects.toMatchObject({ code: "server_not_running" });
	});

	it("raises server_not_running when the envelope arrives on stderr with exit status 1", async () => {
		const fake = fakeHerdr({
			"tab list": { stderr: SERVER_DOWN.replace("cli:pane:list", "cli:tab:list"), code: 1 },
			"pane list": { stderr: SERVER_DOWN, code: 1 },
		});
		const backend = createHerdrBackend(fake.run);
		await expect(backend.tabList()).rejects.toBeInstanceOf(HerdrError);
		await expect(backend.inspect()).rejects.toMatchObject({ code: "server_not_running" });
	});

	it("never starts a server to satisfy a call", async () => {
		const fake = fakeHerdr({ "tab list": { stderr: SERVER_DOWN, code: 1 }, "pane list": { stderr: SERVER_DOWN, code: 1 } });
		await expect(createHerdrBackend(fake.run).inspect()).rejects.toMatchObject({ code: "server_not_running" });
		expect(fake.calls.every((args) => args[0] !== "server")).toBe(true);
	});
});

describe("inspect", () => {
	it("answers Tern's Inspect shape with numeric ids", async () => {
		const fake = fakeHerdr({ "tab list": TAB_LIST, "pane list": PANE_LIST });
		const inspect = await createHerdrBackend(fake.run).inspect();
		expect(inspect.sessions).toHaveLength(1);
		const [first, second] = inspect.sessions[0].tabs;
		expect(typeof first.id).toBe("number");
		// Herdr's default label is the tab's number, so that tab is unnamed in Tern's terms.
		expect(first.name).toBeNull();
		expect(second.name).toBe("build");
		expect(first.blocks.map((block) => typeof block.id)).toEqual(["number", "number"]);
		expect(first.blocks[0].cwd).toBe("/tmp");
		expect(first.blocks[1].cwd).toBe("/work");
		expect(second.blocks).toHaveLength(1);
	});

	it("keeps an id stable across reads of the same pane, and distinct for a different pane", async () => {
		const fake = fakeHerdr({ "tab list": TAB_LIST, "pane list": PANE_LIST });
		const backend = createHerdrBackend(fake.run);
		const ids = (tree: Awaited<ReturnType<typeof backend.inspect>>) => tree.sessions[0].tabs.flatMap((tab) => tab.blocks.map((block) => block.id));
		const before = ids(await backend.inspect());
		const after = ids(await backend.inspect());
		expect(after).toEqual(before);
		expect(new Set(before).size).toBe(3);
		const tabs = (await backend.inspect()).sessions[0].tabs.map((tab) => tab.id);
		expect(tabs[0]).not.toBe(tabs[1]);
	});

	it("names tabs as herdr labels them", () => {
		expect(tabDisplayName("1", 1)).toBeNull();
		expect(tabDisplayName("build", 2)).toBe("build");
		expect(tabDisplayName("", 3)).toBeNull();
		expect(tabDisplayName(undefined, undefined)).toBeNull();
	});
});

describe("send", () => {
	it("succeeds with empty stdout: a silent write is not unparseable output", async () => {
		const fake = fakeHerdr({ "pane split": PANE_SPLIT, "pane run": "" });
		const backend = createHerdrBackend(fake.run);
		const { block } = await backend.split({ direction: "right" });
		await expect(backend.send(block, "echo hi")).resolves.toEqual({ sent: block, chars: 7, enter: true });
		// `pane run` types the text and presses Enter in one call.
		expect(argv(fake.calls, "pane run")[0]).toEqual(["pane", "run", "w1:p4", "echo hi"]);
	});

	it("uses send-text when no Enter is wanted", async () => {
		const fake = fakeHerdr({ "pane split": PANE_SPLIT, "pane send-text": { stdout: "" } });
		const backend = createHerdrBackend(fake.run);
		const { block } = await backend.split({ direction: "down" });
		await expect(backend.send(block, "partial", { enter: false })).resolves.toMatchObject({ enter: false });
		expect(argv(fake.calls, "pane send-text")[0]).toEqual(["pane", "send-text", "w1:p4", "partial"]);
	});

	it("refuses panes this process did not create, unless ownership is relaxed", async () => {
		const { backend: strict, calls, blocks } = await observed({ "pane run": "" });
		await expect(strict.send(blocks[0], "hi")).rejects.toMatchObject({ code: "not_owned" });
		expect(argv(calls, "pane run")).toHaveLength(0);

		const { backend: relaxed, blocks: relaxedBlocks } = await observed({ "pane run": "" }, { enforceOwnership: false });
		await expect(relaxed.send(relaxedBlocks[0], "hi")).resolves.toMatchObject({ sent: relaxedBlocks[0] });
	});

	it("rejects a number herdr never handed out", async () => {
		const fake = fakeHerdr({ "tab list": TAB_LIST, "pane list": PANE_LIST });
		await expect(createHerdrBackend(fake.run).send(99, "hi")).rejects.toMatchObject({ code: "unknown_block" });
	});

	it("refuses text that would drive the terminal outside its text", async () => {
		const fake = fakeHerdr({ "pane split": PANE_SPLIT, "pane run": "" });
		const backend = createHerdrBackend(fake.run);
		const { block } = await backend.split({ direction: "right" });
		await expect(backend.send(block, "ls\u0003rm -rf /")).rejects.toMatchObject({ code: "invalid_argument" });
		expect(argv(fake.calls, "pane run")).toHaveLength(0);
	});
});

describe("read", () => {
	it("returns plain terminal text, not a parsed envelope", async () => {
		const { backend, calls, blocks } = await observed({ "pane read": { stdout: `${READ_TEXT}\n\n` } });
		await expect(backend.read(blocks[0])).resolves.toEqual({ block: blocks[0], text: READ_TEXT });
		expect(argv(calls, "pane read")[0]).toEqual(["pane", "read", "--lines", "60", "w1:p1"]);
	});

	it("clamps the line count to herdr's own bound", async () => {
		const { backend, calls, blocks } = await observed({ "pane read": READ_TEXT });
		await backend.read(blocks[0], { lines: 5_000 });
		expect(argv(calls, "pane read")[0]).toEqual(["pane", "read", "--lines", "400", "w1:p1"]);
	});

	it("waits with wait-output and reports a match with the snapshot it read", async () => {
		const { backend, calls, blocks } = await observed({ "pane wait-output": WAIT_MATCHED });
		await expect(backend.read(blocks[0], { until: "ready>" })).resolves.toEqual({ block: blocks[0], matched: true, text: "booting\nready>" });
		// The bound is in milliseconds and is always sent: without --timeout herdr waits forever.
		expect(argv(calls, "pane wait-output")[0]).toEqual([
			"pane",
			"wait-output",
			"--match",
			"ready>",
			"--lines",
			"60",
			"--timeout",
			"30000",
			"w1:p1",
		]);
	});

	it("reports no match when the wait runs out of time", async () => {
		const { backend, calls, blocks } = await observed({ "pane wait-output": { stdout: WAIT_TIMEOUT, code: 1 } });
		await expect(backend.read(blocks[0], { until: "never", timeout: 5 })).resolves.toEqual({ block: blocks[0], matched: false });
		expect(argv(calls, "pane wait-output")[0]).toContain("5000");
	});

	it("does not turn a dead server into an unmatched wait", async () => {
		const { backend, blocks } = await observed({ "pane wait-output": { stderr: SERVER_DOWN, code: 1 } });
		await expect(backend.read(blocks[0], { until: "ready>" })).rejects.toMatchObject({ code: "server_not_running" });
	});

	it("surfaces a refusal during a plain read", async () => {
		const { backend, blocks } = await observed({ "pane read": { stderr: SERVER_DOWN, code: 1 } });
		await expect(backend.read(blocks[0])).rejects.toMatchObject({ code: "server_not_running" });
	});
});

describe("tabs", () => {
	it("creates a tab without stealing focus and reports the pane inside it", async () => {
		const fake = fakeHerdr({ "tab create": TAB_CREATE, "tab list": TAB_LIST, "pane list": PANE_LIST_WITH_NEW_TAB });
		const created = await createHerdrBackend(fake.run).newTab({ cwd: "/tmp", label: "agent" });
		expect(created).toEqual({ tab: expect.any(Number), block: expect.any(Number) });
	});

	it("fails loudly when a created tab has no pane in it", async () => {
		const fake = fakeHerdr({ "tab create": TAB_CREATE, "tab list": TAB_LIST, "pane list": PANE_LIST });
		await expect(createHerdrBackend(fake.run).newTab({ cwd: "/tmp" })).rejects.toMatchObject({ code: "unexpected_result" });
	});

	it("sends cwd and label as flags, and refuses a relative cwd before calling anything", async () => {
		const fake = fakeHerdr({ "tab create": TAB_CREATE, "tab list": TAB_LIST, "pane list": PANE_LIST_WITH_NEW_TAB });
		await createHerdrBackend(fake.run).newTab({ cwd: "/tmp", label: "agent" });
		expect(argv(fake.calls, "tab create")[0]).toEqual(["tab", "create", "--cwd", "/tmp", "--label", "agent", "--no-focus"]);

		const idle = fakeHerdr({});
		await expect(createHerdrBackend(idle.run).newTab({ cwd: "relative/dir" })).rejects.toMatchObject({ code: "invalid_argument" });
		expect(idle.calls).toHaveLength(0);
	});

	it("renames with the verified positional order TAB_ID then LABEL", async () => {
		const fake = fakeHerdr({
			"tab create": TAB_CREATE,
			"tab list": TAB_LIST,
			"pane list": PANE_LIST_WITH_NEW_TAB,
			"tab rename": `{"id":"cli:tab:rename","result":{"type":"tab_info"}}`,
		});
		const backend = createHerdrBackend(fake.run);
		const { tab } = await backend.newTab({ cwd: "/tmp" });
		await expect(backend.renameTab(tab, "my tab")).resolves.toEqual({ tab, name: "my tab" });
		expect(argv(fake.calls, "tab rename")[0]).toEqual(["tab", "rename", "w1:t9", "my tab"]);
	});

	it("refuses to rename a tab this process did not create", async () => {
		const fake = fakeHerdr({ "tab list": TAB_LIST, "pane list": PANE_LIST });
		const backend = createHerdrBackend(fake.run);
		const tree = await backend.inspect();
		await expect(backend.renameTab(tree.sessions[0].tabs[0].id, "mine now")).rejects.toMatchObject({ code: "not_owned" });
	});

	it("lists tabs and panes with what this process created", async () => {
		const fake = fakeHerdr({ "tab list": TAB_LIST, "pane list": PANE_LIST });
		const listed = await createHerdrBackend(fake.run).tabList();
		expect(listed.tabs.map((tab) => tab.name)).toEqual([null, "build"]);
		expect(listed.tabs[0].blocks.map((block) => block.cwd)).toEqual(["/tmp", "/work"]);
		expect(listed.tabs.every((tab) => tab.agentCreated === false)).toBe(true);
	});
});

describe("panes", () => {
	it("splits a named pane and tracks the pane it created", async () => {
		const { backend, calls, blocks } = await observed({ "pane split": PANE_SPLIT });
		const made = await backend.split({ pane: blocks[0], direction: "right" });
		expect(made).toMatchObject({ beside: blocks[0], direction: "right" });
		expect(argv(calls, "pane split")[0]).toEqual(["pane", "split", "w1:p1", "--direction", "right", "--no-focus"]);
	});

	it("splits relative to herdr's current pane only when no pane is named", async () => {
		const fake = fakeHerdr({ "pane split": PANE_SPLIT });
		await createHerdrBackend(fake.run).split({ direction: "down" });
		expect(argv(fake.calls, "pane split")[0]).toEqual(["pane", "split", "--current", "--direction", "down", "--no-focus"]);
	});

	it("closes only what it created, and forgets the id afterwards", async () => {
		const fake = fakeHerdr({ "pane split": PANE_SPLIT, "pane close": "" });
		const backend = createHerdrBackend(fake.run);
		const { block } = await backend.split({ direction: "right" });
		await expect(backend.close(block)).resolves.toEqual({ closed: block });
		expect(argv(fake.calls, "pane close")[0]).toEqual(["pane", "close", "w1:p4"]);
		await expect(backend.close(block)).rejects.toMatchObject({ code: "unknown_block" });
	});

	it("focuses the pane's tab, because herdr 0.9.5 has no focus-this-pane verb", async () => {
		const { backend, calls, blocks } = await observed({ "tab focus": `{"id":"cli:tab:focus","result":{"type":"tab_info"}}` });
		// blocks[2] is the only pane of the second tab.
		await expect(backend.focus(blocks[2])).resolves.toMatchObject({ focused: blocks[2], level: "tab" });
		expect(argv(calls, "tab focus")[0]).toEqual(["tab", "focus", "w1:t2"]);
	});
});

describe("status", () => {
	it("reads the server block rather than the client block", async () => {
		const down = fakeHerdr({ status: STATUS_DOWN });
		await expect(createHerdrBackend(down.run).status()).resolves.toMatchObject({ running: false });
		const up = fakeHerdr({ status: STATUS_UP });
		await expect(createHerdrBackend(up.run).status()).resolves.toMatchObject({ running: true });
	});

	it("reports a server that is not there as the absence of one, not as a crash", async () => {
		const fake = fakeHerdr({ status: { stderr: SERVER_DOWN, code: 1 } });
		await expect(createHerdrBackend(fake.run).status()).resolves.toMatchObject({ running: false });
	});
});
