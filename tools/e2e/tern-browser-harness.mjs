#!/usr/bin/env -S node --experimental-strip-types
/** Live e2e for the `tern` agent tool. Requires a Tern window with TERN_PANE set; exits 0 with a skip
 *  message otherwise. Drives a regular browser over a local fixture (open, blocks, snapshot, act click,
 *  capture, goto), creates a tab, renames it, opens a browser inside it, splits and focuses, then closes
 *  only what this run created. Also checks refusals on the user's own panes, which change nothing.
 *  Deterministic scope and validation rules live in .pi/test/tern/browser.test.ts. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { realDeps } from "../../.pi/lib/tern/browser.ts";
import ternExtension from "../../extensions/tern-browser/extension.ts";

if (!process.env.TERN_PANE) {
	console.log("skip live checks: TERN_PANE is not set");
	process.exit(0);
}

let passed = 0;
const check = async (name, fn) => {
	await fn();
	passed += 1;
	console.log(`ok  ${name}`);
};
const waitFor = async (fn, label, timeoutMs = 15_000) => {
	const deadline = Date.now() + timeoutMs;
	let last;
	while (Date.now() < deadline) {
		try {
			last = await fn();
			if (last) return last;
		} catch (err) {
			last = err;
		}
		await new Promise((r) => setTimeout(r, 250));
	}
	throw new Error(`timed out waiting for ${label}; last=${last instanceof Error ? last.message : JSON.stringify(last)}`);
};
const findRef = (node, role, name) => {
	if (!node) return undefined;
	if (node.role === role && node.name === name) return node.ref;
	for (const child of node.children ?? []) {
		const ref = findRef(child, role, name);
		if (ref) return ref;
	}
	return undefined;
};

const page = (title, body) => `<!doctype html><meta charset="utf-8"><title>${title}</title>${body}`;
const server = createServer((req, res) => {
	res.writeHead(200, { "content-type": "text/html" });
	res.end(req.url === "/second"
		? page("Second", "<h1>second page</h1>")
		: page("First", `<button id="target" onclick="this.textContent='clicked'">Target</button>`));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const deps = realDeps();
let registered;
ternExtension({ registerTool: (tool) => { registered = tool; } });
const run = async (p, signal) => {
	const result = await registered.execute("live-e2e", p, signal);
	if (result.isError) throw new Error(result.content[0].text);
	return JSON.parse(result.content[0].text);
};
const listed = async () => run({ op: "list" });
const allTabIds = async () => (await listed()).tabs.map((t) => t.tab);

const created = { blocks: new Set(), tabs: new Set() };
let caller;

try {
	await check("the registered execute handler answers list through the tool surface", async () => {
		let tool;
		ternExtension({ registerTool: (t) => (tool = t) });
		const result = await tool.execute("e2e", { op: "list" }, undefined, undefined, undefined);
		assert.ok(!result.isError, result.content[0].text);
		assert.ok(JSON.parse(result.content[0].text).tabs.some((t) => t.caller));
	});

	await check("list shows this pane's tab and no agent-created tab yet", async () => {
		const { tabs } = await listed();
		caller = tabs.find((t) => t.caller);
		assert.ok(caller, "caller tab missing");
		assert.ok(caller.blocks.some((b) => b.caller), "caller pane missing from its tab");
		assert.ok(!tabs.some((t) => t.agentCreated), "unexpected agent-created tab");
	});

	let block;
	await check("open places a regular browser block in this pane's tab and tracks it", async () => {
		const opened = await run({ op: "open", url: `${base}/` });
		block = opened.block;
		created.blocks.add(block);
		assert.ok(Number.isInteger(block), `open returned ${JSON.stringify(opened)}`);
		assert.ok(caller.tab === opened.tab, `opened into ${opened.tab}, expected ${caller.tab}`);
	});

	let ref;
	await check("snapshot exposes the button ref, then act click changes the page", async () => {
		ref = await waitFor(async () => findRef((await run({ op: "snapshot", block })).tree, "button", "Target"), "Target button");
		await run({ op: "act", block, action: "click", ref });
		await waitFor(async () => findRef((await run({ op: "snapshot", block })).tree, "button", "clicked"), "clicked button");
	});

	await check("capture writes a PNG; goto loads another page in the same block", async () => {
		const { path } = await run({ op: "capture", block });
		assert.ok(existsSync(path), `missing ${path}`);
		assert.equal(readFileSync(path).subarray(1, 4).toString(), "PNG");
		await run({ op: "goto", block, url: `${base}/second` });
		await waitFor(async () => (await run({ op: "snapshot", block })).title === "Second", "second title");
	});

	let newTab;
	await check("new_tab creates a tab in the caller's session, with a cwd", async () => {
		newTab = await run({ op: "new_tab", cwd: "/tmp" });
		created.tabs.add(newTab.tab);
		created.blocks.add(newTab.block);
		assert.ok((await allTabIds()).includes(newTab.tab), "new tab missing from list");
	});

	await check("rename_tab names the agent's tab; a user's tab refuses rename", async () => {
		const name = `tern-e2e ${Date.now()}`;
		assert.deepEqual(await run({ op: "rename_tab", block: newTab.block, name }), { tab: newTab.tab, name });
		const { tabs } = await listed();
		assert.equal(tabs.find((t) => t.tab === newTab.tab).name, name);
		await assert.rejects(run({ op: "rename_tab", block: deps.paneId, name: "x" }), /was not created by this agent/);
	});

	let inNewTab;
	await check("open with block targets the new tab's pane and lands there", async () => {
		inNewTab = await run({ op: "open", url: `${base}/`, block: newTab.block });
		created.blocks.add(inNewTab.block);
		assert.equal(inNewTab.tab, newTab.tab, `opened into ${inNewTab.tab}, expected the new tab`);
	});

	await check("split beside this pane adds one tracked pane to the caller's tab", async () => {
		const split = await run({ op: "split", direction: "right" });
		created.blocks.add(split.block);
		const tab = (await listed()).tabs.find((t) => t.caller);
		assert.ok(tab.blocks.some((b) => b.block === split.block), "split pane not in caller tab");
	});

	await check("close refuses this pane and the user's own panes; nothing changes", async () => {
		const before = (await listed()).tabs.map((t) => t.blocks.length);
		await assert.rejects(run({ op: "close", block: deps.paneId }), /own pane/);
		const userPane = caller.blocks.find((b) => !b.caller && !b.agentCreated)?.block;
		if (userPane !== undefined) await assert.rejects(run({ op: "close", block: userPane }), /was not created by this agent/);
		assert.deepEqual((await listed()).tabs.map((t) => t.blocks.length), before);
	});

	await check("a cancelled call rejects without running tern", async () => {
		const controller = new AbortController();
		controller.abort();
		await assert.rejects(run({ op: "blocks" }, controller.signal), /cancelled/);
	});

	await check("focus returns to this pane", async () => {
		assert.deepEqual(await run({ op: "focus", block: deps.paneId }), { focused: deps.paneId });
	});

	await check("close removes created browser blocks; the agent's tab closes with its last block", async () => {
		await run({ op: "close", block: inNewTab.block });
		created.blocks.delete(inNewTab.block);
		await run({ op: "close", block: newTab.block });
		created.blocks.delete(newTab.block);
		created.tabs.delete(newTab.tab);
		assert.equal((await allTabIds()).includes(newTab.tab), false, "agent tab still present");
	});

	await check("close the first browser block and the split pane; blocks op is empty for this run", async () => {
		await run({ op: "close", block });
		created.blocks.delete(block);
		const split = [...created.blocks][0];
		if (split !== undefined) await run({ op: "close", block: split });
		created.blocks.clear();
		const { blocks } = await run({ op: "blocks" });
		assert.equal(blocks.some((b) => b.block === block), false);
	});

	console.log(`PASS tern live: ${passed} checks`);
} finally {
	for (const id of created.blocks) await run({ op: "close", block: id }).catch(() => {});
	server.close();
}
