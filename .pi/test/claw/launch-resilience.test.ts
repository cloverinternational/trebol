/** TREBOL-318: a Claw worker must not die because the extension source was being written, or because the checkout moved
 *  between run creation and the worker tab. Each defect here has a test that fails without its fix:
 *   - a mid-write parse error is retried with backoff, and a persistent one fails with the loader's own message
 *   - a deterministic configuration error is not retried at all
 *   - a checkout that moved or gained tracked edits between create and launch is refused, naming the checkout
 *   - a healthy launch is untouched (one gate attempt, one tab)
 *   - a worker that dies before writing any event is failed with a reason, not left silently `lost` */
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { tick, type DaemonDeps } from "../../lib/claw/daemon.ts";
import type { IssueView } from "../../lib/claw/hoja.ts";
import {
	PREFLIGHT_ATTEMPTS, backoffDelay, checkExtensionSource, classifyLaunchFailure, compareSource, defaultPreflight,
	findPiPackage, preflightLaunch, snapshotSource, sourceState, type PreflightResult,
} from "../../lib/claw/preflight.ts";
import { continueRun, startRun, type ClawHoja, type LaunchDeps } from "../../lib/claw/spawn.ts";
import { ClawStore, type Run } from "../../lib/claw/store.ts";

const TEAM = { teamId: "team-trebol", teamKey: "TREBOL", projectId: "proj-crm", project: "CRM Clover File", assigneeId: "user-luis", assignee: "Luis" };
const STATES = { "in progress": "s-ip", "in review": "s-ir", done: "s-done", canceled: "s-canceled" };

function fakeHoja() {
	const issues = new Map<string, IssueView & { description: string }>();
	const calls = { create: 0, comment: 0, setState: 0, states: [] as string[] };
	let n = 0;
	const hoja: ClawHoja = {
		async resolve(project: string) {
			if (project !== TEAM.project) throw new Error(`Hoja project "${project}" not found`);
			return { ...TEAM, states: STATES };
		},
		async createIssue(_r, title, description, state = "In Progress") {
			calls.create++;
			n++;
			const issue = { id: `iss-${n}`, identifier: `TREBOL-${800 + n}`, title, description, state, teamId: TEAM.teamId, projectId: TEAM.projectId, assigneeId: TEAM.assigneeId, comments: [] as string[] };
			issues.set(issue.id, issue);
			return { id: issue.id, identifier: issue.identifier };
		},
		async readIssue(id: string): Promise<IssueView> {
			const issue = issues.get(id);
			if (!issue) throw new Error(`no issue ${id}`);
			return { ...issue, comments: [...issue.comments] };
		},
		async findIssueByMarker(marker: string) {
			const hit = [...issues.values()].find((i) => i.description.includes(marker));
			return hit ? { id: hit.id, identifier: hit.identifier } : undefined;
		},
		async comment(id: string, body: string) { calls.comment++; issues.get(id)!.comments.push(body); },
		async setState(_r, id: string, state: string) { calls.setState++; calls.states.push(state); issues.get(id)!.state = state; },
	};
	return { hoja, issues, calls };
}

function fakeTern() {
	const live = new Set<number>([1]);
	const calls: string[][] = [];
	let nextBlock = 300;
	const exec = async (args: string[]) => {
		calls.push(args);
		if (args[0] === "inspect") return JSON.stringify({ sessions: [{ id: 1, tabs: [{ id: 1, name: "Claw", blocks: [...live].map((id) => ({ id, exited: null, live: true })) }] }] });
		if (args[0] === "new") {
			const block = ++nextBlock;
			live.add(block);
			return JSON.stringify({ tab: block + 1000, block });
		}
		if (args[0] === "close") { live.delete(Number(args[1])); return "{}"; }
		return "{}";
	};
	return { exec, live, calls, opened: () => calls.filter((c) => c[0] === "new").length };
}

/** Specifiers written *into* fixtures must not look like this file's own imports to `tools/repo/rewrite-imports.mjs`. */
const spec = (name: string) => ["." , name].join("/");

const git = (dir: string, args: string[]) => execFileSync("git", ["-C", dir, "-c", "user.email=claw@example.com", "-c", "user.name=Claw Test", ...args], { encoding: "utf8" });

/** A minimal pi package in its own git checkout: manifest entry point plus a module it imports. */
function gitFixture(): string {
	const dir = mkdtempSync(join(tmpdir(), "claw-source-"));
	mkdirSync(join(dir, "extensions/ok"), { recursive: true });
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "claw-source-fixture", pi: { extensions: ["extensions/ok/index.ts"] } }, null, 2));
	writeFileSync(join(dir, "extensions/ok/lib.ts"), "export const lib = 2 as number;\n");
	writeFileSync(join(dir, "extensions/ok/index.ts"), `import { lib } from "${spec("lib.ts")}";\n\nexport const ok = lib;\n`);
	execFileSync("git", ["init", "-q", "-b", "main", dir]);
	git(dir, ["add", "."]);
	git(dir, ["commit", "-qm", "fixture"]);
	return dir;
}

describe("launch failure classification", () => {
	it("treats load, parse and tool-conflict messages as transient", () => {
		expect(classifyLaunchFailure("ParseError: extensions/claw/extension.ts:182:0 Unexpected token")).toBe("transient");
		expect(classifyLaunchFailure("'' expected.")).toBe("transient");
		expect(classifyLaunchFailure('Tool "Read" conflicts with /repo/extensions/fs/index.ts')).toBe("transient");
		expect(classifyLaunchFailure("Tool Read is already registered")).toBe("transient");
		expect(classifyLaunchFailure("Cannot find module './lib.ts'")).toBe("transient");
	});

	it("never retries a deterministic configuration error", () => {
		expect(classifyLaunchFailure('Unknown provider: "nope"')).toBe("deterministic");
		expect(classifyLaunchFailure("Provider is not configured: anthropic")).toBe("deterministic");
		expect(classifyLaunchFailure("invalid api key for openai")).toBe("deterministic");
		expect(classifyLaunchFailure("/root/.pi/config/settings.json is not valid JSON")).toBe("deterministic");
	});

	it("backs off exponentially with jitter inside a bounded band", () => {
		expect(backoffDelay(1, () => 0.5)).toBe(200);
		expect(backoffDelay(2, () => 0.5)).toBe(400);
		expect(backoffDelay(3, () => 0.5)).toBe(800);
		expect(backoffDelay(9, () => 0.5)).toBe(2_000);
		expect(backoffDelay(1, () => 0)).toBe(130);
		expect(backoffDelay(1, () => 1)).toBe(270);
	});
});

describe("extension source check", () => {
	let root: string;
	beforeEach(() => { root = gitFixture(); });
	afterEach(() => rmSync(root, { recursive: true, force: true }));
	// The first checkExtensionSource pays for loading the TypeScript compiler
	// (~10 MB of JavaScript) inside a 5s test. That one-off cost has nothing to
	// do with the behaviour under test and a shared runner made it exceed the
	// default, so load it once here with its own budget.
	beforeAll(async () => { await import("typescript"); }, 60_000);

	it("finds the pi package and its registered entry points", () => {
		const found = findPiPackage(root);
		expect(found.found).toBe(true);
		expect(found.found && found.root).toBe(root);
		expect(found.found && found.entryPoints).toEqual([join(root, "extensions/ok/index.ts")]);
		const nested = findPiPackage(join(root, "extensions/ok"));
		expect(nested.found && nested.root).toBe(root);
		expect(findPiPackage(tmpdir()).found).toBe(false);
	});

	it("reports a package.json caught mid-write instead of pretending the source is fine", () => {
		writeFileSync(join(root, "package.json"), '{ "name": "claw-source-fixture", "pi": { "extensions": [');
		const found = findPiPackage(join(root, "extensions/ok"));
		expect(found.found).toBe(false);
		expect(!found.found && found.reason).toBe("invalid");
		expect(!found.found && found.error).toContain("is not valid JSON");
	});

	it("accepts a healthy tree and follows local imports", async () => {
		const found = findPiPackage(root);
		if (!found.found) throw new Error("fixture is not a pi package");
		expect(await checkExtensionSource(found.entryPoints, found.root)).toEqual({ ok: true, files: 2 });
	});

	it("names the file and position of a source caught mid-write, including an imported module", async () => {
		const found = findPiPackage(root);
		if (!found.found) throw new Error("fixture is not a pi package");
		writeFileSync(join(root, "extensions/ok/lib.ts"), "export function lib( {\n");
		const checked = await checkExtensionSource(found.entryPoints, found.root);
		expect(checked.ok).toBe(false);
		expect((checked as { error: string }).error).toMatch(/^ParseError: extensions\/ok\/lib\.ts:\d+:\d+ /);
	});
});

describe("checkout identity", () => {
	let root: string;
	beforeEach(() => { root = gitFixture(); });
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it("records HEAD, branch and a fingerprint of tracked changes", async () => {
		const state = (await snapshotSource(root))!;
		expect(state.branch).toBe("main");
		expect(state.head).toMatch(/^[0-9a-f]{40}$/);
		expect(state.dirty).toEqual([]);
		expect(state.fingerprint).toMatch(/^[0-9a-f]{16}$/);
	});

	it("is silent for a directory that is not a git checkout", async () => {
		const plain = mkdtempSync(join(tmpdir(), "claw-plain-"));
		try { expect(await sourceState(plain)).toBeUndefined(); } finally { rmSync(plain, { recursive: true, force: true }); }
	});

	it("refuses a checkout that switched branch after the run was created", async () => {
		const recorded = (await snapshotSource(root))!;
		git(root, ["checkout", "-qb", "feature/in-progress"]);
		const refusal = compareSource(recorded, (await snapshotSource(root))!);
		expect(refusal).toContain("source checkout moved");
		expect(refusal).toContain(`branch "main" -> "feature/in-progress"`);
		expect(refusal).toContain(root);
	});

	it("refuses tracked files edited after the run was created, even when the checkout was already dirty", async () => {
		appendFileSync(join(root, "extensions/ok/lib.ts"), "export const deliberate = 1 as number;\n");
		const recorded = (await snapshotSource(root))!;
		expect(recorded.dirty).toEqual(["extensions/ok/lib.ts"]);
		// A second edit of the same already-dirty file still changes the fingerprint, so it is refused too.
		appendFileSync(join(root, "extensions/ok/lib.ts"), "export const midway = 2 as number;\n");
		const refusal = compareSource(recorded, (await snapshotSource(root))!);
		expect(refusal).toContain("dirty in ways it was not");
		expect(refusal).toContain("extensions/ok/lib.ts");
	});

	it("accepts the same checkout, dirty included, when nothing changed since creation", async () => {
		appendFileSync(join(root, "extensions/ok/lib.ts"), "export const deliberate = 1 as number;\n");
		const recorded = (await snapshotSource(root))!;
		expect(compareSource(recorded, (await snapshotSource(root))!)).toBeUndefined();
	});
});

describe("launch gate in the run lifecycle", () => {
	let workspace: string;
	let source: string;
	let store: ClawStore;
	let fh: ReturnType<typeof fakeHoja>;
	let tern: ReturnType<typeof fakeTern>;
	let sleeps: number[];
	let deps: LaunchDeps;

	/** Creation persists the run at phase `issue_created`; the tab opens on the next lifecycle step, which a daemon tick
	 *  would perform. Driving it explicitly keeps these tests about the gate, not about the daemon loop. */
	const spawn = async (cwd = source) => {
		const run = await startRun({ task: "work", project: TEAM.project, cwd }, deps);
		return run.phase === "issue_created" ? continueRun(run, deps) : run;
	};
	const runOf = (id: string) => store.getRun(id)!;

	beforeEach(() => {
		workspace = mkdtempSync(join(tmpdir(), "claw-launch-"));
		source = gitFixture();
		store = ClawStore.forWorkspace(workspace);
		fh = fakeHoja();
		tern = fakeTern();
		sleeps = [];
		deps = {
			store, hoja: fh.hoja, tern: tern.exec, workspace,
			sleep: async (ms) => { sleeps.push(ms); },
			random: () => 0.5,
		};
	});
	afterEach(() => {
		rmSync(workspace, { recursive: true, force: true });
		rmSync(source, { recursive: true, force: true });
	});

	it("retries a mid-write parse error and launches on the attempt that parses", async () => {
		const script: PreflightResult[] = [
			{ ok: false, error: "ParseError: extensions/ok/index.ts:4:0 Unexpected token" },
			{ ok: false, error: "ParseError: extensions/ok/index.ts:4:0 Unexpected token" },
			{ ok: true },
		];
		let calls = 0;
		deps.preflight = async () => script[Math.min(calls++, script.length - 1)]!;
		const run = await spawn();
		expect(calls).toBe(3);
		expect(sleeps).toEqual([200, 400]);
		expect(run.status).toBe("launching");
		expect(run.phase).toBe("tab_open");
		expect(run.error).toBeUndefined();
		expect(run.launchAttempts).toBe(3);
		expect(tern.opened()).toBe(1);
		expect(runOf(run.id).phase).toBe("tab_open");
	});

	it("fails after the retry budget with the loader's own parse message and opens no tab", async () => {
		const parseMessage = "ParseError: extensions/ok/index.ts:182:0 Unexpected token";
		deps.preflight = async () => ({ ok: false, error: parseMessage });
		const run = await spawn();
		expect(sleeps).toHaveLength(PREFLIGHT_ATTEMPTS - 1);
		expect(tern.opened()).toBe(0);
		expect(run.status).toBe("failed");
		expect(run.error).toContain(parseMessage);
		expect(run.error).toContain(`after ${PREFLIGHT_ATTEMPTS} attempts`);
		expect(run.error).toContain("No tab was opened");
		expect(store.readInbox(0).items.some((i) => i.kind === "run_failed")).toBe(true);
		// The Hoja issue stays In Progress: a failed launch never moves state, and never reaches Done.
		expect(fh.calls.states).toEqual([]);
		expect([...fh.issues.values()][0]!.state).toBe("In Progress");
	});

	it("does not retry a deterministic configuration error", async () => {
		deps.preflight = async () => ({ ok: false, error: 'Unknown provider: "nope"', kind: "deterministic" });
		const run = await spawn();
		expect(sleeps).toEqual([]);
		expect(tern.opened()).toBe(0);
		expect(run.status).toBe("failed");
		expect(run.launchAttempts).toBe(1);
		expect(run.error).toContain('Unknown provider: "nope"');
	});

	it("classifies a configuration error reported without a kind as deterministic", async () => {
		deps.preflight = async () => ({ ok: false, error: "Provider is not configured: anthropic" });
		const run = await spawn();
		expect(sleeps).toEqual([]);
		expect(run.launchAttempts).toBe(1);
		expect(run.status).toBe("failed");
	});

	it("refuses a worker tab when the checkout switched branch between create and launch", async () => {
		deps.preflight = async (input) => {
			git(source, ["checkout", "-qb", "feature/stranded"]);
			return defaultPreflight(input);
		};
		const run = await spawn();
		expect(tern.opened()).toBe(0);
		expect(run.status).toBe("failed");
		expect(run.error).toContain("source checkout moved");
		expect(run.error).toContain("feature/stranded");
		expect(run.error).toContain(source);
	});

	it("refuses a worker tab when tracked extension source was edited between create and launch", async () => {
		deps.preflight = async (input) => {
			writeFileSync(join(source, "extensions/ok/index.ts"), `import { lib } from "${spec("lib.ts")}";\n\nexport const ok = lib +;\n`);
			return defaultPreflight(input);
		};
		const run = await spawn();
		expect(tern.opened()).toBe(0);
		expect(run.status).toBe("failed");
		expect(run.error).toContain("dirty in ways it was not");
		expect(run.error).toContain("extensions/ok/index.ts");
	});

	it("launches a healthy source on the first attempt with the real gate", async () => {
		const run = await spawn();
		expect(run.status).toBe("launching");
		expect(run.phase).toBe("tab_open");
		expect(run.launchAttempts).toBe(1);
		expect(run.error).toBeUndefined();
		expect(sleeps).toEqual([]);
		expect(tern.opened()).toBe(1);
		expect(run.source?.branch).toBe("main");
		expect(run.sourceAtLaunch?.head).toBe(run.source?.head);
		expect(run.block).toBeDefined();
	});

	it("reports a run that died before writing any event as failed with a reason, not lost", async () => {
		const at = new Date(Date.now() - 5 * 60_000).toISOString();
		const run: Run = {
			id: "run-preevent", label: "Pre", task: "t", cwd: source, status: "launching", phase: "tab_open",
			createdAt: at, updatedAt: at, project: TEAM.project, eventsOffset: 0, settles: 0, attempts: 0, outbox: [], seen: [],
			block: 999, source: (await snapshotSource(source))!,
		};
		store.saveRun(run);
		const daemon = { ...deps, now: () => new Date(), alive: () => false, signal: () => undefined } as unknown as DaemonDeps;
		await tick(daemon);
		const after = runOf("run-preevent");
		expect(after.status).toBe("failed");
		expect(after.error).toContain("before session_start");
		// The checkout the worker came from travels with the startup failure, so the tree to fix is named.
		expect(after.error).toContain("source checkout");
		expect(after.error).toContain(source);
		const kinds = store.readInbox(0).items.map((i) => i.kind);
		expect(kinds).toContain("run_failed");
		expect(kinds).not.toContain("run_lost");
	});

	it("reports the captured loader line of a worker that died before session_start", async () => {
		const at = new Date(Date.now() - 5 * 60_000).toISOString();
		const run: Run = {
			id: "run-preevent-log", label: "Pre log", task: "t", cwd: source, status: "launching", phase: "tab_open",
			createdAt: at, updatedAt: at, project: TEAM.project, eventsOffset: 0, settles: 0, attempts: 0, outbox: [], seen: [],
			block: 997,
		};
		store.saveRun(run);
		writeFileSync(store.workerLogPath(run.id), "ParseError: Unexpected token extensions/claw/extension.ts:182:0\n");
		const daemon = { ...deps, now: () => new Date(), alive: () => false, signal: () => undefined } as unknown as DaemonDeps;
		await tick(daemon);
		const after = runOf(run.id);
		expect(after.status).toBe("failed");
		// The exact shape the incident produced must survive into the failed run, not be swallowed as "no reason".
		expect(after.error).toContain("ParseError: Unexpected token extensions/claw/extension.ts:182:0");
		expect(store.readInbox(0).items.some((i) => i.kind === "run_failed")).toBe(true);
	});

	it("still reports a worker that started and then vanished as lost", async () => {
		const at = new Date(Date.now() - 5 * 60_000).toISOString();
		const run: Run = {
			id: "run-started", label: "Started", task: "t", cwd: source, status: "running", phase: "tab_open",
			createdAt: at, updatedAt: at, project: TEAM.project, eventsOffset: 0, settles: 1, attempts: 0, outbox: [], seen: [],
			block: 998, pid: 5150,
		};
		store.saveRun(run);
		store.appendEvent({ eid: "evt-1", type: "started", at, runId: run.id, pid: 5150 });
		const daemon = { ...deps, now: () => new Date(), alive: () => false, signal: () => undefined } as unknown as DaemonDeps;
		await tick(daemon);
		expect(runOf("run-started").status).toBe("lost");
	});

	it("keeps retry delays off the healthy path even when the gate is unverifiable", async () => {
		const plain = mkdtempSync(join(tmpdir(), "claw-nogit-"));
		try {
			const run = await spawn(plain);
			expect(run.phase).toBe("tab_open");
			expect(run.launchAttempts).toBe(1);
			expect(run.launchWarning).toContain("no pi package");
			expect(sleeps).toEqual([]);
		} finally {
			rmSync(plain, { recursive: true, force: true });
		}
	});
});

describe("retry policy helper", () => {
	it("returns the first success and counts the attempts", async () => {
		let calls = 0;
		const outcome = await preflightLaunch({ cwd: "/tmp", workspace: "/tmp" }, {
			check: async () => (++calls < 3 ? { ok: false, error: "ParseError: a.ts:1:0 oops" } : { ok: true, warnings: ["fine"] }),
			sleep: async () => undefined,
			random: () => 0.5,
		});
		expect(outcome).toMatchObject({ ok: true, attempts: 3 });
		// The retried failures stay on the record, so a launch that needed two retries is visible, not silent.
		expect((outcome as { warnings: string[] }).warnings).toHaveLength(3);
		expect((outcome as { warnings: string[] }).warnings.at(-1)).toBe("fine");
	});

	it("stops at the first deterministic failure and keeps its message", async () => {
		let calls = 0;
		const outcome = await preflightLaunch({ cwd: "/tmp", workspace: "/tmp" }, {
			check: async () => { calls++; return { ok: false, error: "invalid api key" }; },
			sleep: async () => undefined,
			random: () => 0.5,
		});
		expect(calls).toBe(1);
		expect(outcome).toMatchObject({ ok: false, attempts: 1, kind: "deterministic", error: "invalid api key" });
	});

	it("surfaces a throwing gate as a retryable load failure", async () => {
		let calls = 0;
		const outcome = await preflightLaunch({ cwd: "/tmp", workspace: "/tmp" }, {
			check: async () => { calls++; throw new Error("ENOENT: mid-rename"); },
			sleep: async () => undefined,
			random: () => 0.5,
			attempts: 2,
		});
		expect(calls).toBe(2);
		expect(outcome).toMatchObject({ ok: false, attempts: 2, kind: "transient" });
		expect((outcome as { error: string }).error).toContain("mid-rename");
	});
});
