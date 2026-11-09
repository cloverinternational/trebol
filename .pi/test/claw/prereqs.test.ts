import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	checkPrereqs, describeInstall, installCommands, installPrereqs, isMissingExecutable, missingPrereqsMessage, ternUsable,
	type CommandRunner,
} from "../../lib/claw/prereqs.ts";
import { ternBinary } from "../../lib/claw/launcher.ts";
import { startRun, type ClawHoja } from "../../lib/claw/spawn.ts";
import { ClawStore } from "../../lib/claw/store.ts";

const enoent = (command: string) => Object.assign(new Error(`spawn ${command} ENOENT`), { code: "ENOENT" });

/** A runner that answers only for the commands it is told about; anything else is "not installed". */
function runner(table: Record<string, string | Error>): CommandRunner & { calls: string[] } {
	const calls: string[] = [];
	const run: CommandRunner = async (command, args) => {
		calls.push([command, ...args].join(" "));
		const answer = table[command];
		if (answer === undefined) throw enoent(command);
		if (answer instanceof Error) throw answer;
		return answer;
	};
	return Object.assign(run, { calls });
}

describe("mandatory tool detection", () => {
	it("treats only a failed spawn as missing, not a tool that rejects --version", async () => {
		// `tern --version` is not guaranteed; a usage error still proves the binary exists, which is Pi's own rule.
		const run = runner({ pi: "1.2.3\n", tern: new Error("tern: unknown flag --version") });
		const report = await checkPrereqs(["pi", "tern", "rg"], { run, exists: () => false, home: "/home/x", env: {} });
		expect(report.present.map((state) => state.id).sort()).toEqual(["pi", "tern"]);
		expect(report.missing).toEqual([{ id: "rg", ok: false, error: "spawn rg ENOENT" }]);
		expect(report.ok).toBe(false);
	});

	it("keeps the version line for a tool that answers", async () => {
		const report = await checkPrereqs(["pi"], { run: runner({ pi: "0.99.0\nnext line" }), exists: () => false, home: "/home/x", env: {} });
		expect(report.present[0]).toMatchObject({ id: "pi", path: "pi", version: "0.99.0" });
	});

	it("accepts the ripgrep Pi downloaded, without it being on PATH", async () => {
		const managed = "/home/x/.pi/agent/bin/rg";
		const run = runner({ [managed]: "ripgrep 15.0.0\n" });
		const report = await checkPrereqs(["rg"], { run, exists: (path) => path === managed, home: "/home/x", env: {} });
		expect(report.ok).toBe(true);
		expect(report.present[0]).toMatchObject({ id: "rg", path: managed, version: "ripgrep 15.0.0" });
		// PATH was never consulted: the managed copy is the answer.
		expect(run.calls).toEqual([`${managed} --version`]);
	});

	it("honours TERN_BIN, the override tools/tern/style-lint.mjs already uses", async () => {
		const custom = "/opt/tern/bin/tern";
		expect(ternBinary({ TERN_BIN: " /opt/tern/bin/tern " }, () => false)).toBe(custom);
		expect(ternBinary({}, () => false)).toBe("tern");
		const report = await checkPrereqs(["tern"], { run: runner({ [custom]: "tern 1.0" }), exists: (path) => path === custom, home: "/home/x", env: { TERN_BIN: custom } });
		expect(report.ok).toBe(true);
		expect(report.present[0]?.path).toBe(custom);
	});

	it("finds the Tern app's own CLI when its bin dir is not on PATH", async () => {
		// The reported machine: Tern installed and running the pane, `~/.local/bin/tern` present, PATH without that dir —
		// so the gate said "not installed" and the real spawn said ENOENT. The app's install locations are probed now.
		const installed = "/home/x/.local/bin/tern";
		const run = runner({ [installed]: "tern 0.9.12\n" });
		const report = await checkPrereqs(["tern"], { run, exists: (path) => path === installed, home: "/home/x", env: {} });
		expect(report.ok).toBe(true);
		expect(report.present[0]).toMatchObject({ id: "tern", path: installed, version: "tern 0.9.12" });
		// PATH was never asked: the app's copy answered, and it is the path the launcher spawns.
		expect(run.calls).toEqual([`${installed} --version`]);
		expect(ternBinary({}, (path) => path === installed, "/home/x")).toBe(installed);
	});

	it("follows XDG_DATA_HOME to a relocated Tern app and skips a bin dir that is gone", async () => {
		const data = "/data/tern/build/tern";
		const report = await checkPrereqs(["tern"], {
			run: runner({ [data]: "tern 1.0" }),
			exists: (path) => path === data,
			home: "/home/x",
			env: { XDG_DATA_HOME: "/data" },
		});
		expect(report.present[0]?.path).toBe(data);
		// A dangling symlink in the user bin dir does not count: present means executable, not merely named.
		expect(ternBinary({ XDG_DATA_HOME: "/data" }, (path) => path === data, "/home/x")).toBe(data);
		expect(ternBinary({}, () => false, "/home/x")).toBe("tern");
	});

	it("does not call a present-but-broken candidate on PATH a false success", async () => {
		// A dangling TERN_BIN is skipped and PATH decides, so a stale override cannot hide a working tern.
		const run = runner({ tern: "tern 1.0" });
		const report = await checkPrereqs(["tern"], { run, exists: () => false, home: "/home/x", env: { TERN_BIN: "/gone/tern" } });
		expect(report.present[0]?.path).toBe("tern");
	});

	it("classifies ENOENT by code or by message, nothing else", () => {
		expect(isMissingExecutable(enoent("tern"))).toBe(true);
		expect(isMissingExecutable(new Error("spawn tern ENOENT"))).toBe(true);
		expect(isMissingExecutable(new Error("tern: rename refused"))).toBe(false);
	});
});

describe("what the user is told", () => {
	const broken = { ok: false, present: [], missing: [
		{ id: "tern" as const, ok: false, error: "spawn tern ENOENT" },
		{ id: "rg" as const, ok: false, error: "spawn rg ENOENT" },
	] };

	it("names each tool, why Claw needs it, and the step that fixes it", () => {
		const message = missingPrereqsMessage(broken, "linux");
		expect(message.split("\n")[0]).toBe("Claw needs `tern` and `rg` and they are not installed.");
		expect(message).toContain("- tern: opens, names and inspects worker tabs (spawn tern ENOENT)");
		expect(message).toContain("https://docs.stencil.so/tern");
		expect(message).toContain("- rg: is the search every agent is told to use");
		expect(message).toContain("apt-get install -y ripgrep");
		// The old message told the user to name the tab, which was the symptom, not the fault.
		expect(message).not.toContain("Name it");
	});

	it("gives the macOS command on macOS and no invented command where there is none", () => {
		expect(installCommands("rg", "darwin")).toEqual([["brew", "install", "ripgrep"]]);
		expect(installCommands("tern", "darwin")).toEqual([]);
		expect(missingPrereqsMessage({ ok: false, present: [], missing: [{ id: "tern", ok: false }] }, "darwin"))
			.toContain("install the Tern app (https://docs.stencil.so/tern)");
	});
});

describe("installing what can be installed", () => {
	it("runs the platform command and reports success", async () => {
		const commands: string[] = [];
		const outcome = await installPrereqs([{ id: "rg", ok: false }], {
			platform: "linux",
			run: async (command, args) => { commands.push([command, ...args].join(" ")); return ""; },
		});
		expect(outcome.installed).toEqual(["rg"]);
		expect(commands).toEqual(["apt-get install -y ripgrep"]);
		expect(describeInstall(outcome)).toBe("installed rg.");
	});

	it("reports the command that failed and what it said, and cannot install tern at all", async () => {
		const outcome = await installPrereqs(
			[{ id: "rg", ok: false }, { id: "tern", ok: false }],
			{ platform: "linux", run: async (command) => { if (command === "apt-get") throw new Error("E: Could not open lock file /var/lib/dpkg/lock-frontend"); return ""; } },
		);
		expect(outcome.installed).toEqual([]);
		expect(describeInstall(outcome)).toContain("apt-get install -y ripgrep` failed: E: Could not open lock file");
		expect(describeInstall(outcome)).toContain("tern not installed: this repository cannot install it");
	});
});

describe("the launch side", () => {
	let dirs: string[] = [];
	afterEach(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); dirs = []; });

	it("refuses a run before creating its Hoja issue when the Tern CLI is unusable", async () => {
		const { store, hoja, creates } = fakeDeps();
		const run = await startRun({ task: "do the thing", project: "P" }, { store, hoja, tern: async () => "{}", workspace: store.dir, prereqs: () => ternUsable({ run: runner({}), exists: () => false, home: "/home/x", env: {} }) });
		expect(run.status).toBe("failed");
		expect(run.error).toContain("no Hoja issue was created");
		expect(run.error).toContain("tern is not installed");
		expect(creates.count).toBe(0);
	});

	it("still dispatches when the gate passes", async () => {
		const { store, hoja, creates } = fakeDeps();
		const run = await startRun({ task: "do the thing", project: "P" }, { store, hoja, tern: async (args) => (args[0] === "inspect" ? JSON.stringify({ sessions: [] }) : "{}"), workspace: store.dir, prereqs: async () => ({ ok: true }) });
		expect(creates.count).toBe(1);
		expect(run.phase).toBe("issue_created");
		expect(run.hoja?.identifier).toBe("TREBOL-901");
	});

	/** A Hoja that answers like the real one for the create path, so a passing gate can reach `issue_created`. */
	function fakeDeps() {
		const dir = mkdtempSync(join(tmpdir(), "claw-prereq-"));
		dirs.push(dir);
		let created = 0;
		const team = { teamId: "t", teamKey: "TREBOL", projectId: "p", project: "P", assigneeId: "u", assignee: "U" };
		const issues = new Map<string, { id: string; identifier: string; title: string; description: string; state: string; teamId: string; projectId: string; assigneeId: string; comments: string[] }>();
		const hoja: ClawHoja = {
			resolve: async () => ({ ...team, states: { "in progress": "s-ip", "in review": "s-ir", done: "s-done" } }),
			createIssue: async (_resolved, title, description, state) => {
				created++;
				const view = { id: "iss-1", identifier: "TREBOL-901", title, description, state: state ?? "In Progress", ...team };
				issues.set(view.id, { ...view, comments: [] });
				return { id: view.id, identifier: view.identifier };
			},
			readIssue: async (id) => {
				const view = issues.get(id);
				if (!view) throw new Error(`${id} not found`);
				return { ...view, comments: [...view.comments] };
			},
			findIssueByMarker: async (marker) => {
				const hit = [...issues.values()].find((view) => view.description.includes(marker));
				return hit ? { id: hit.id, identifier: hit.identifier } : undefined;
			},
			comment: async () => undefined,
			setState: async () => undefined,
		};
		return { store: ClawStore.forWorkspace(dir), hoja, creates: { get count() { return created; } } };
	}
});
