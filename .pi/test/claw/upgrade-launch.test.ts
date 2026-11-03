/** A fresh Claw worker starts on the /upgrade prompt: its first user turn is byte-identical to what `/upgrade <launch
 *  instruction>` sends. The proof is what pi receives as argv after the real launch line goes through a real shell, not
 *  the string the daemon built: a fake `pi` on PATH records its arguments. */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildUpgradePrompt, UPGRADE_TEMPLATE } from "../../lib/claw/upgrade-prompt.ts";
import { registerUpgradePrompt } from "../../../extensions/upgrade-prompt/extension.ts";
import { continueRun, launchPrompt, startRun, type ClawHoja, type LaunchDeps } from "../../lib/claw/spawn.ts";
import { ClawStore, type Run } from "../../lib/claw/store.ts";

const TEAM = { teamId: "t", teamKey: "TREBOL", projectId: "p", project: "Hoja", assigneeId: "u", assignee: "Luis", states: { "in progress": "s-ip" } };

function fakeTern() {
	const calls: string[][] = [];
	let next = 700;
	const exec = async (args: string[]) => {
		calls.push(args);
		if (args[0] === "inspect") return JSON.stringify({ sessions: [{ id: 1, tabs: [{ id: 1, name: "Claw", blocks: [{ id: 1, exited: null, live: true, command: null }] }] }] });
		if (args[0] === "new") { const block = ++next; return JSON.stringify({ tab: block + 1000, block }); }
		return "{}";
	};
	return { exec, launches: () => calls.filter((c) => c[0] === "new").map((c) => c.slice(c.indexOf("--") + 1)) };
}

function fakeHoja(): ClawHoja {
	const issues = new Map<string, any>();
	return {
		async resolve() { return { ...TEAM } as any; },
		async createIssue(_r: any, _t: string, description: string) {
			const id = `iss-${issues.size + 1}`;
			issues.set(id, { id, identifier: `TREBOL-${issues.size + 1}`, description, state: "In Progress", teamId: "t", projectId: "p", assigneeId: "u", comments: [] });
			return { id, identifier: issues.get(id).identifier };
		},
		async readIssue(id: string) { return { ...issues.get(id), comments: [] }; },
		async findIssueByMarker() { return undefined; },
		async comment() {},
		async setState() {},
	} as unknown as ClawHoja;
}

/** Runs the launch line in `shell -c` with a fake pi on PATH; answers the argv pi received (after `pi`). */
function argvThroughShell(shell: string, line: string, bin: string): string[] {
	const out = join(bin, "argv");
	rmSync(out, { force: true });
	const r = spawnSync(shell, ["-c", line], { env: { PATH: `${bin}:/usr/bin:/bin`, HOME: bin }, encoding: "utf8" });
	expect(r.status, r.stderr).toBe(0);
	return readFileSync(out, "utf8").split("\0").slice(0, -1);
}

describe("claw worker launch with the /upgrade prompt", () => {
	let dir: string;
	let store: ClawStore;
	let tern: ReturnType<typeof fakeTern>;
	let deps: LaunchDeps;
	let bin: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "claw-upgrade-"));
		store = ClawStore.forWorkspace(dir);
		tern = fakeTern();
		deps = { store, hoja: fakeHoja(), tern: tern.exec, workspace: dir, now: () => new Date("2026-10-29T12:00:00Z"), preflight: async () => ({ ok: true }), planLaunch: () => ({ mode: "discovery" as const }), sleep: async () => {} };
		bin = join(dir, "bin");
		mkdirSync(bin);
		writeFileSync(join(bin, "pi"), `#!/bin/sh\nfor a in "$@"; do printf '%s\\0' "$a"; done > "${join(bin, "argv")}"\n`);
		chmodSync(join(bin, "pi"), 0o755);
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	const launch = async (extra: Record<string, unknown> = {}): Promise<{ run: Run; argv: string[] }> => {
		let run = await startRun({ task: "Fix it's \"quoted\" $HOME `tick` task", project: "Hoja", cwd: dir, ...extra }, deps);
		for (let i = 0; i < 5 && run.phase !== "tab_open"; i++) run = await continueRun(run, deps);
		expect(run.phase).toBe("tab_open");
		const [, , line] = tern.launches().at(-1)!;
		return { run, argv: argvThroughShell("/bin/bash", line, bin) };
	};

	it("the first user turn is byte-identical to what /upgrade <instruction> sends", async () => {
		const { run, argv } = await launch();
		const instruction = `Read and execute your Claw task file in full: ${store.taskPath(run.id)}`;
		const expected = buildUpgradePrompt(instruction)!;
		expect(argv.at(-1)).toBe(expected);
		// Exactly what a user typing `/upgrade <instruction>` sends: drive the real command handler.
		const commands = new Map<string, any>();
		const sent: string[] = [];
		registerUpgradePrompt({ registerCommand: (name: string, c: any) => commands.set(name, c) });
		await commands.get("upgrade").handler(instruction, { sendUserMessage: async (text: string) => { sent.push(text); } });
		expect(sent).toEqual([argv.at(-1)]);
		expect(argv.at(-1)!.startsWith(UPGRADE_TEMPLATE)).toBe(true);
		// Sent as a turn, not dispatched as a slash command, so it works without the upgrade extension in the worker.
		expect(argv.at(-1)).not.toMatch(/^\//);
		expect(run.upgrade).toBeUndefined();
		// The task file contract is unchanged: task text, finish rule, and no template inside it.
		const file = readFileSync(store.taskPath(run.id), "utf8");
		expect(file).toContain("## Finish (required)");
		expect(file).not.toContain(UPGRADE_TEMPLATE);
	});

	const zsh = ["/bin/zsh", "/usr/bin/zsh"].find(existsSync);
	it.skipIf(!zsh)("survives zsh, the other worker shell, unchanged", async () => {
		const { run } = await launch();
		const [, , line] = tern.launches().at(-1)!;
		expect(argvThroughShell(zsh!, line, bin).at(-1)).toBe(launchPrompt(run, store.taskPath(run.id)));
	});

	it("upgrade:false is recorded on the run and launches the plain instruction", async () => {
		const { run, argv } = await launch({ upgrade: false });
		expect(store.getRun(run.id)!.upgrade).toBe(false);
		expect(argv.at(-1)).toBe(`Read and execute your Claw task file in full: ${store.taskPath(run.id)}`);
	});
});
