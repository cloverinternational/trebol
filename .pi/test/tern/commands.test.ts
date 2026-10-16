import { describe, expect, it } from "vitest";
import {
	autocompleteCommands,
	buildCatalog,
	routeSubmission,
	sourceTag,
	sessionCommandSource,
	type CommandSource,
} from "../../lib/tern/commands.ts";
import { PiTernBridge, type PiEventLike, type PiSessionLike } from "../../lib/tern/bridge.ts";
import { SlashAutocomplete } from "../../lib/tern/autocomplete.ts";
import { ESC, parseTspMessages, type TspMessage } from "../../lib/tern/tsp.ts";

const source: CommandSource = {
	extensionCommands: () => [{ invocationName: "ext-run", description: "run ext" }],
	promptTemplates: () => [{ name: "review", description: "review tmpl" }],
	skills: () => [{ name: "triage", description: "triage skill" }],
};

const catalog = buildCatalog(source);

function fakeSession(commands = source) {
	const listeners = new Set<(e: PiEventLike) => void>();
	const calls: string[] = [];
	const session: PiSessionLike & { emit(e: PiEventLike): void } = {
		subscribe(l) {
			listeners.add(l);
			return () => listeners.delete(l);
		},
		prompt(text) {
			calls.push(`prompt:${text}`);
			return new Promise<void>(() => {});
		},
		model: { provider: "p1", id: "m1", name: "Model One" },
		modelRuntime: { getAvailableSnapshot: () => [
			{ provider: "p1", id: "m1", name: "Model One", api: "test", baseUrl: "", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, reasoning: false, contextWindow: 1000, maxTokens: 500 },
			{ provider: "p2", id: "m2", name: "Model Two", api: "test", baseUrl: "", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, reasoning: false, contextWindow: 2000, maxTokens: 1000 },
		], async getAvailable() { return this.getAvailableSnapshot(); } },
		async setModel(model) { calls.push(`model:${(model as { provider: string; id: string }).provider}/${(model as { id: string }).id}`); },
		async abort() {
			calls.push("abort");
		},
		dispose() {
			calls.push("dispose");
		},
		emit(e) {
			for (const l of listeners) l(e);
		},
	};
	const writes: string[] = [];
	const bridge = new PiTernBridge(session, { write: (d) => writes.push(d), surfaceId: "pi", credits: 1000, commands });
	bridge.start();
	return { session, calls, bridge, writes };
}

function lastFrame(writes: string[]): string {
	const last = writes.filter((w) => w.startsWith(`${ESC}_tsp;f;`)).at(-1);
	if (!last) throw new Error("no frame");
	return JSON.stringify(parseTspMessages(last)[0]?.body);
}

describe("buildCatalog", () => {
	it("marks builtins unsupported and includes live extension, template and skill names", () => {
		const byName = (n: string) => catalog.lookup(n);
		expect(byName("model")[0]).toMatchObject({ kind: "builtin", supported: true });
		expect(byName("settings")[0]).toMatchObject({ kind: "builtin", supported: false });
		expect(byName("ext-run")[0]).toMatchObject({ kind: "extension", supported: true });
		expect(byName("review")[0]).toMatchObject({ kind: "template", supported: true });
		expect(byName("skill:triage")[0]).toMatchObject({ kind: "skill", supported: true });
	});

	it("reads extension, template and skill sources from the session members", () => {
		const calls: string[] = [];
		const src = sessionCommandSource({
			extensionRunner: {
				getRegisteredCommands: () => {
					calls.push("ext");
					return [{ invocationName: "e" }];
				},
			},
			promptTemplates: [{ name: "t", description: "" }],
			resourceLoader: { getSkills: () => ({ skills: [{ name: "s", description: "" }] }) },
		});
		expect(buildCatalog(src).entries.map((e) => e.name)).toEqual([
			...buildCatalog({ extensionCommands: () => [], promptTemplates: () => [], skills: () => [] }).entries.map((e) => e.name),
			"t",
			"e",
			"skill:s",
		]);
		expect(calls).toEqual(["ext"]);
	});
});

describe("routeSubmission", () => {
	it("passes plain text through untouched", () => {
		expect(routeSubmission("hello /model", catalog, false)).toEqual({ kind: "plain" });
	});

	it("refuses unknown slash input so it never reaches the model", () => {
		expect(routeSubmission("/nope arg", catalog, false)).toMatchObject({ kind: "refuse" });
		expect(routeSubmission("/", catalog, false)).toMatchObject({ kind: "refuse" });
	});

	it("routes Tern-run builtins with their argument and refuses terminal-only ones", () => {
		expect(routeSubmission("/model", catalog, false)).toMatchObject({ kind: "builtin", name: "model", args: "" });
		expect(routeSubmission("/thinking  high ", catalog, false)).toEqual({ kind: "builtin", name: "thinking", args: "high" });
		expect(routeSubmission("/settings", catalog, false)).toMatchObject({ kind: "refuse", reason: expect.stringContaining("pi -nt") });
	});

	it("does not match a near-miss prefix of a real command name", () => {
		expect(routeSubmission("/ext", catalog, false)).toMatchObject({ kind: "refuse" });
		expect(routeSubmission("/ext-runner", catalog, false)).toMatchObject({ kind: "refuse" });
	});

	it("dispatches extensions immediately, even while busy", () => {
		expect(routeSubmission("/ext-run now", catalog, true)).toMatchObject({ kind: "dispatch", immediate: true });
	});

	it("waits for an idle session before template and skill dispatch", () => {
		expect(routeSubmission("/review x", catalog, false)).toMatchObject({ kind: "dispatch", immediate: false });
		expect(routeSubmission("/skill:triage", catalog, false)).toMatchObject({ kind: "dispatch", immediate: false });
		expect(routeSubmission("/review x", catalog, true)).toMatchObject({ kind: "refuse", reason: expect.stringContaining("busy") });
	});

	it("refuses ambiguous names that exist as more than one kind", () => {
		const clash = buildCatalog({ ...source, promptTemplates: () => [{ name: "ext-run", description: "" }] });
		expect(routeSubmission("/ext-run", clash, false)).toMatchObject({ kind: "refuse", reason: expect.stringContaining("ambiguous") });
	});

});

describe("autocompleteCommands", () => {
	it("lists builtins, templates, extensions and skills in Pi's order with OMP icons", () => {
		const items = autocompleteCommands(source);
		expect(items.slice(0, 2).map((i) => i.name)).toEqual(["settings", "model"]);
		expect(items.slice(-3).map((i) => [i.name, i.icon])).toEqual([["review", "prompt"], ["ext-run", "extension"], ["skill:triage", "skill"]]);
		expect(items.find((i) => i.name === "model")).toMatchObject({ icon: "model", description: "<provider/model> — Select model (opens selector UI)" });
		expect(items.find((i) => i.name === "settings")).toMatchObject({ icon: "settings" });
		expect(items.find((i) => i.name === "settings")?.disabled).toBeUndefined();
		expect(items.find((i) => i.name === "thinking")?.icon).toBe("action");
	});

	it("skips extension commands that clash with a builtin and hides skills when disabled", () => {
		const items = autocompleteCommands({ ...source, extensionCommands: () => [{ name: "model", invocationName: "model" }, { name: "x", invocationName: "x:2" }], skillCommandsEnabled: () => false });
		expect(items.filter((i) => i.name === "model")).toHaveLength(1);
		expect(items.some((i) => i.name === "x:2")).toBe(true);
		expect(items.some((i) => i.name.startsWith("skill:"))).toBe(false);
	});

	it("prefixes descriptions with Pi's source tags", () => {
		expect(sourceTag({ source: "builtin", scope: "user" })).toBeUndefined();
		expect(sourceTag({ source: "local", scope: "project" })).toBe("p");
		expect(sourceTag({ source: "npm:pkg", scope: "user" })).toBe("u:npm:pkg");
		expect(sourceTag({ source: "git:github.com/a/b@v1", scope: "temporary" })).toBe("t:git:github.com/a/b@v1");
		const [t] = autocompleteCommands({ ...source, promptTemplates: () => [{ name: "r", description: "d", argumentHint: "<x>", sourceInfo: { source: "local", scope: "user" } }] }).filter((i) => i.name === "r");
		expect(t.description).toBe("<x> — [u] d");
	});

	it("completes /model and /thinking arguments from the live session", () => {
		const src = sessionCommandSource({
			extensionRunner: { getRegisteredCommands: () => [] },
			promptTemplates: [],
			resourceLoader: { getSkills: () => ({ skills: [] }) },
			modelRuntime: { getAvailableSnapshot: () => [{ provider: "anthropic", id: "claude-x" }, { provider: "openai", id: "gpt-y" }] },
			getAvailableThinkingLevels: () => ["off", "low", "high"],
		});
		const done = src.builtinCompletions!();
		expect(done.model("gpt")).toEqual([{ value: "openai/gpt-y", label: "gpt-y", description: "openai" }]);
		expect(done.thinking("h")).toEqual([{ value: "high", label: "high" }]);
		expect(done.thinking("zz")).toBeNull();
	});

	it("projects only live Pi model and thinking values into OMP command rows", () => {
		const live = sessionCommandSource({
			extensionRunner: { getRegisteredCommands: () => [] }, promptTemplates: [],
			resourceLoader: { getSkills: () => ({ skills: [] }) },
			model: { provider: "anthropic", id: "haiku" }, thinkingLevel: "low",
		});
		expect(autocompleteCommands(live).find((i) => i.name === "model")?.value).toBe("anthropic/haiku");
		expect(autocompleteCommands(live).find((i) => i.name === "thinking")?.value).toBe("low");
		expect(autocompleteCommands(source).find((i) => i.name === "model")?.value).toBeUndefined();
	});
});

describe("PiTernBridge command routing", () => {
	it("opens OMP-style searchable model picker with provider groups, current marker and preview", async () => {
		const { bridge, writes } = fakeSession();
		bridge.handle({ verb: "e", body: { ev: "action", id: "model", act: "model.select" } } as TspMessage);
		await new Promise((resolve) => setTimeout(resolve, 5));
		const frame = lastFrame(writes);
		expect(frame).toContain('"model-picker-sheet"');
		expect(frame).toContain('"title":"Model"');
		expect(frame).toContain('"placeholder":"Search models…"');
		expect(frame).toContain('"group":"provider:p1"');
		expect(frame).toContain('"current":["p1/m1"]');
		expect(frame).toContain('"selected":"p1/m1"');
	});

	it("filters model picker results and applies only the activated model", async () => {
		const { bridge, calls, writes } = fakeSession();
		bridge.handle({ verb: "e", body: { ev: "action", id: "model", act: "model.select" } } as TspMessage);
		bridge.appendDraft("Model Two");
		expect(lastFrame(writes)).toContain('"selected":"p2/m2"');
		bridge.handle({ verb: "e", body: { ev: "activate", id: "model-picker-sheet", item: "p2/m2" } } as TspMessage);
		await Promise.resolve();
		expect(calls).toEqual(["model:p2/m2"]);
	});

	it("uses refreshed availability when the cached model snapshot starts empty", async () => {
		const session = fakeSession();
		const models = [{ provider: "p3", id: "late", name: "Late model", api: "test", baseUrl: "", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, reasoning: false, contextWindow: 4096, maxTokens: 1024 }];
		const pending: { resolve?: (value: typeof models) => void } = {};
		(session.session as unknown as { modelRuntime: { getAvailableSnapshot: () => typeof models; getAvailable: () => Promise<typeof models> } }).modelRuntime = {
			getAvailableSnapshot: () => [],
			getAvailable: () => new Promise((resolve) => { pending.resolve = resolve; }),
		};
		const opening = session.bridge.handle({ verb: "e", body: { ev: "action", id: "model", act: "model.select" } } as TspMessage);
		await Promise.resolve();
		expect(lastFrame(session.writes)).toContain('"state":"loading"');
		pending.resolve?.(models);
		await opening;
		expect(lastFrame(session.writes)).toContain('"p3/late"');
	});

	it("cancels model picker without changing selected model", () => {
		const { bridge, calls } = fakeSession();
		bridge.handle({ verb: "e", body: { ev: "action", id: "model", act: "model.select" } } as TspMessage);
		expect(bridge.escape()).toBe(false);
		expect(calls).toEqual([]);
	});

	it("selects available models via /model argument without sending it as a prompt", async () => {
		const { calls, bridge } = fakeSession();
		await bridge.submit("/model p2/m2");
		expect(calls).toEqual(["model:p2/m2"]);
	});

	it("opens the model chooser for bare /model and applies the selected model", async () => {
		const { calls, bridge, writes } = fakeSession();
		const selecting = bridge.submit("/model");
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(lastFrame(writes)).toContain('"model-picker-sheet"');
		bridge.handle({ verb: "e", body: { ev: "activate", id: "model-picker-sheet", item: "p2/m2" } } as TspMessage);
		await selecting;
		expect(calls).toEqual(["model:p2/m2"]);
	});

	it("rejects unavailable or malformed model arguments without changing model", async () => {
		const { calls, bridge } = fakeSession();
		await bridge.submit("/model p3/missing");
		await bridge.submit("/model p1/m1/extra");
		expect(calls).toEqual([]);
	});

	it("never sends an unknown or builtin slash command to the model", async () => {
		const { calls, bridge, writes } = fakeSession();
		await bridge.submit("/nope");
		expect(lastFrame(writes)).toContain("not sent to the model");
		await bridge.submit("/tree");
		expect(lastFrame(writes)).toContain("unavailable in Tern");
		expect(calls).toEqual([]);
	});

	it("fails closed when command discovery throws", async () => {
		const broken: CommandSource = { ...source, extensionCommands: () => { throw new Error("reload failed"); } };
		const { calls, bridge, writes } = fakeSession(broken);
		await bridge.submit("/unknown");
		expect(calls).toEqual([]);
		expect(lastFrame(writes)).toContain("not sent to the model");
	});

	it("dispatches an extension command while the session is busy", async () => {
		const { calls, bridge } = fakeSession();
		void bridge.submit("hi");
		bridge.handle({ verb: "e", body: { ev: "focus" } } as TspMessage);
		void bridge.submit("/ext-run go");
		expect(calls).toEqual(["prompt:hi", "prompt:/ext-run go"]);
	});

	it("refuses a template while busy instead of queuing it", async () => {
		const { calls, bridge, session } = fakeSession();
		void bridge.submit("hi");
		session.emit({ type: "agent_start" });
		await bridge.submit("/review now");
		expect(calls).toEqual(["prompt:hi"]);
	});

	const layer = (writes: string[]) => {
		const nodes = new Map<string, { k: string; p?: Record<string, unknown>; c?: unknown[] }>();
		for (const w of writes) for (const m of parseTspMessages(w)) for (const op of ((m.body as { ops?: unknown[][] }).ops ?? [])) {
			const walk = (n: { id: string; k: string; p?: Record<string, unknown>; c?: unknown[] }) => { nodes.set(n.id, n); for (const c of (n.c ?? []) as typeof n[]) walk(c); };
			if (op[0] === "add") walk(op[4] as never);
			if (op[0] === "del") nodes.delete(op[1] as string);
			if (op[0] === "set") { const n = nodes.get(op[1] as string); if (n) n.p = { ...n.p, ...(op[2] as object) }; }
		}
		return nodes;
	};
	const settle = () => new Promise((r) => setTimeout(r, 0));
	const listOf = (writes: string[]) => {
		const nodes = layer(writes);
		const col = nodes.get("complete")?.c?.[0] as { id: string } | undefined;
		return col ? nodes.get(`${col.id}.list`) : undefined;
	};

	it("opens OMP's caret-anchored autocomplete on / with every command", async () => {
		const { bridge, writes } = fakeSession();
		bridge.appendDraft("/");
		await settle();
		const overlay = layer(writes).get("complete");
		expect(overlay?.p).toEqual({ anchor: { caret: "composer" }, role: "omp.autocomplete" });
		const list = listOf(writes)!;
		expect(list.p).toMatchObject({ empty: "No items", max: { lines: 10 } });
		expect(list.c).toHaveLength(autocompleteCommands(source).length);
		expect(bridge.draft).toBe("/");
	});

	it("fuzzy-filters as you type, marks the typed prefix and keeps the draft", async () => {
		const { bridge, writes } = fakeSession();
		bridge.appendDraft("/");
		bridge.appendDraft("mo");
		await settle();
		const list = listOf(writes)!;
		const first = list.c![0] as { id: string; p: Record<string, unknown> };
		expect(first.p).toMatchObject({ icon: "model", label: [{ t: "mo", s: "mark" }, { t: "del" }], detail: [{ t: "<provider/model> — Select model (opens selector UI)", s: "muted" }] });
		expect(list.p?.selected).toBe(first.id);
		expect(layer(writes).get("composer")?.p?.ghost).toBe("del");
		expect(bridge.draft).toBe("/mo");
	});

	it("Tab applies the selected command name with a trailing space and closes", async () => {
		const { bridge, writes, calls } = fakeSession();
		bridge.appendDraft("/");
		bridge.appendDraft("ext");
		await settle();
		await bridge.tab();
		expect(bridge.draft).toBe("/ext-run ");
		expect(layer(writes).get("complete")).toBeUndefined();
		expect(calls).toEqual([]);
	});

	it("Enter on a command name applies and runs it", async () => {
		const { bridge, calls } = fakeSession();
		bridge.appendDraft("/");
		bridge.appendDraft("ext-r");
		await settle();
		void bridge.submitDraft();
		expect(calls).toEqual(["prompt:/ext-run"]);
	});

	it("selecting a terminal-only builtin preserves its OMP row then refuses on submit", async () => {
		const { bridge, calls, writes } = fakeSession();
		bridge.appendDraft("/");
		await settle();
		const list = listOf(writes)!;
		expect((list.c![0] as { p: Record<string, unknown> }).p.disabled).toBeUndefined();
		await bridge.tab();
		expect(bridge.draft).toBe("/settings ");
		await bridge.submitDraft();
		expect(calls).toEqual([]);
		expect(lastFrame(writes)).toContain("pi -nt");
	});

	it("Tab on a command with argument completions opens them, as OMP does", async () => {
		const withArgs: CommandSource = { ...source, extensionCommands: () => [{ invocationName: "ext-run", description: "run ext", getArgumentCompletions: () => [{ value: "start", label: "start" }] }] };
		const { bridge, writes } = fakeSession(withArgs);
		for (const ch of "/ext-r") bridge.appendDraft(ch);
		await settle();
		await bridge.tab();
		expect(bridge.draft).toBe("/ext-run ");
		expect((listOf(writes)!.c as { p: Record<string, unknown> }[]).map((c) => c.p.label)).toEqual([[{ t: "start" }]]);
	});

	it("Tab after a slash command's space requests its argument completions", async () => {
		const withArgs: CommandSource = { ...source, extensionCommands: () => [{ invocationName: "ext-run", getArgumentCompletions: () => [{ value: "start", label: "start" }, { value: "stop", label: "stop" }] }] };
		const { bridge, writes } = fakeSession(withArgs);
		bridge.setDraft("/ext-run ");
		await bridge.tab();
		expect((listOf(writes)!.c as { p: Record<string, unknown> }[]).map((c) => c.p.label)).toEqual([[{ t: "start" }], [{ t: "stop" }]]);
	});

	it("Tab refreshes real multi-level subcommands instead of closing after the first argument", async () => {
		const withArgs: CommandSource = { ...source, extensionCommands: () => [{ invocationName: "ext-run", getArgumentCompletions: (prefix: string) => prefix === "" ? [{ value: "switch ", label: "switch" }, { value: "delete ", label: "delete" }] : prefix === "switch " ? [{ value: "switch one", label: "one" }, { value: "switch two", label: "two" }] : null }] };
		const { bridge, writes } = fakeSession(withArgs);
		bridge.setDraft("/ext-run ");
		await bridge.tab();
		await bridge.tab();
		expect(bridge.draft).toBe("/ext-run switch ");
		expect((listOf(writes)!.c as { p: Record<string, unknown> }[]).map((c) => c.p.label)).toEqual([[{ t: "one" }], [{ t: "two" }]]);
	});

	it("Tab on a terminal argument does not re-open that same one-row completion", async () => {
		const withArgs: CommandSource = { ...source, extensionCommands: () => [{ invocationName: "ext-run", getArgumentCompletions: (p: string) => ["off", "high"].filter((v) => v.startsWith(p)).map((v) => ({ value: v, label: v })) }] };
		const { bridge, writes } = fakeSession(withArgs);
		bridge.setDraft("/ext-run hi");
		await bridge.tab();
		await bridge.tab();
		expect(bridge.draft).toBe("/ext-run high");
		expect(layer(writes).get("complete")).toBeUndefined();
	});

	it("keeps model argument values with slashes in one selectable Tern item id", async () => {
		const withArgs: CommandSource = { ...source, extensionCommands: () => [{ invocationName: "ext-run", getArgumentCompletions: () => [{ value: "openai/gpt-5", label: "gpt-5" }, { value: "anthropic/claude", label: "claude" }] }] };
		const { bridge, writes } = fakeSession(withArgs);
		bridge.setDraft("/ext-run gpt");
		await bridge.tab();
		const list = listOf(writes)!;
		const item = list.c![0] as { id: string };
		expect(item.id).toMatch(/openai%2Fgpt-5$/);
		// The inserted value begins with the provider; OMP's ghost must not promise a bare label suffix.
		expect(layer(writes).get("composer")?.p?.ghost).toBeUndefined();
		bridge.handle({ verb: "e", body: { ev: "activate", id: item.id.split("/")[0], item: item.id } } as TspMessage);
		expect(bridge.draft).toBe("/ext-run openai/gpt-5");
	});

	it("pages over more than 200 real completions without hiding keyboard-accessible items", async () => {
		const values = Array.from({ length: 240 }, (_, i) => ({ value: `choice-${i}`, label: `choice-${i}` }));
		const withArgs: CommandSource = { ...source, extensionCommands: () => [{ invocationName: "ext-run", getArgumentCompletions: () => values }] };
		let draft = "/ext-run ";
		const complete = new SlashAutocomplete({ commands: () => autocompleteCommands(withArgs), cwd: () => process.cwd(), draft: () => draft, setDraft: (text) => { draft = text; }, render: () => {} });
		await complete.tab();
		expect(complete.nodes()[0].c![0].c![0].c).toHaveLength(100);
		for (let i = 0; i < 220; i++) complete.move(1);
		const list = complete.nodes()[0].c![0].c![0];
		expect(list.c).toHaveLength(29);
		expect(list.p?.selected).toBe("complete.1.list/choice-220");
		expect(list.c!.some((c) => c.id === list.p?.selected)).toBe(true);
		await complete.tab();
		expect(draft).toBe("/ext-run choice-220");
	});

	it("shows argument completions after a space and Enter inserts without submitting", async () => {
		const withArgs: CommandSource = { ...source, extensionCommands: () => [{ invocationName: "ext-run", description: "run ext", getArgumentCompletions: (p: string) => ["start", "stop"].filter((v) => v.startsWith(p)).map((v) => ({ value: v, label: v, description: `${v} it` })) }] };
		const { bridge, writes, calls } = fakeSession(withArgs);
		for (const ch of "/ext-run s") bridge.appendDraft(ch);
		await settle();
		const list = listOf(writes)!;
		expect((list.c as { p: Record<string, unknown> }[]).map((c) => c.p.label)).toEqual([[{ t: "s", s: "mark" }, { t: "tart" }], [{ t: "s", s: "mark" }, { t: "top" }]]);
		bridge.movePicker(1);
		await bridge.submitDraft();
		expect(bridge.draft).toBe("/ext-run stop");
		expect(calls).toEqual([]);
		void bridge.submitDraft();
		expect(calls).toEqual(["prompt:/ext-run stop"]);
	});

	it("moves and wraps the selection, and selects or activates on click", async () => {
		const { bridge, writes } = fakeSession();
		bridge.appendDraft("/");
		await settle();
		bridge.movePicker(-1);
		const list = listOf(writes)!;
		const ids = (list.c as { id: string }[]).map((c) => c.id);
		expect(list.p?.selected).toBe(ids.at(-1));
		const listId = `${(layer(writes).get("complete")!.c![0] as { id: string }).id}.list`;
		bridge.handle({ verb: "e", body: { ev: "select", id: listId, item: ids[1] } } as TspMessage);
		expect(listOf(writes)!.p?.selected).toBe(ids[1]);
		bridge.handle({ verb: "e", body: { ev: "select", id: listId, item: ids[2] } } as TspMessage);
		expect(listOf(writes)!.p?.selected).toBe(ids[2]);
		bridge.handle({ verb: "e", body: { ev: "activate", id: listId, item: ids.find((id) => id.endsWith("/review")) } } as TspMessage);
		expect(bridge.draft).toBe("/review ");
		expect(layer(writes).get("complete")).toBeUndefined();
	});

	it("Esc closes the list and keeps the draft; backspace past / closes it", async () => {
		const { bridge, writes } = fakeSession();
		bridge.appendDraft("/");
		bridge.appendDraft("m");
		await settle();
		expect(bridge.escape()).toBe(false);
		expect(bridge.draft).toBe("/m");
		expect(layer(writes).get("complete")).toBeUndefined();
		expect(layer(writes).get("composer")?.p?.ghost).toBeNull();
		bridge.backspaceDraft();
		await settle();
		expect(layer(writes).get("complete")).toBeDefined();
		bridge.backspaceDraft();
		await settle();
		expect(layer(writes).get("complete")).toBeUndefined();
	});

	it("never opens on / typed mid-sentence", async () => {
		const { bridge, writes } = fakeSession();
		for (const ch of "a /") bridge.appendDraft(ch);
		await settle();
		expect(layer(writes).get("complete")).toBeUndefined();
	});
});
