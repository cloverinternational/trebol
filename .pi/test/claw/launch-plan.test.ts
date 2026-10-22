/** Two checkouts of one repository - a linked worktree, or a symlink to the same tree - must not
 *  load the same extension twice. The fixture registers the same repository as a configured
 *  package and as the cwd-local project package, exactly as a Trebol worktree does, and asserts
 *  both that the plan collapses the copies and that Pi then loads one extension with no errors. */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { describePlan, entryIdentity, gitPaths, planLaunch, readSettings, repositoryIdentity, sourceExtensions } from "../../lib/claw/launch-plan.ts";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

const git = (cwd: string, ...args: string[]): string =>
	execFileSync("git", ["-C", cwd, "-c", "user.email=test@example.com", "-c", "user.name=Test", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** A git repository whose pi manifest declares one extension registering `tool`. */
function repo(root: string, name: string, tool = "fixture_tool"): string {
	const dir = join(root, name);
	mkdirSync(join(dir, "extensions"), { recursive: true });
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version: "1.0.0", type: "module", pi: { extensions: ["extensions/tool.js"] } }));
	writeFileSync(join(dir, "extensions", "tool.js"), `export default (pi) => { pi.registerTool({ name: ${JSON.stringify(tool)}, description: "fixture", parameters: { type: "object" }, execute: async () => ({ content: [] }) }); };\n`);
	git(dir, "init", "-q");
	git(dir, "add", ".");
	git(dir, "commit", "-qm", "init");
	return dir;
}
function tempRoot(): string {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "claw-launch-plan-")));
	roots.push(root);
	return root;
}
/** A checkout that self-registers as a project package and keeps an agent dir with user settings. */
function checkout(root: string, name: string, userPackages: string[], tool?: string) {
	const dir = repo(root, name, tool);
	mkdirSync(join(dir, ".pi"), { recursive: true });
	writeFileSync(join(dir, ".pi", "settings.json"), JSON.stringify({ packages: [".."] }));
	const agentDir = join(root, `${name}-agent`);
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: userPackages }));
	return { dir, agentDir };
}

/** Pi itself, on this machine's declared SDK, with the settings the plan was computed from. */
async function piLoad(cwd: string, agentDir: string, plan: { extensions?: string[] } | undefined) {
	const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
	const loader = new DefaultResourceLoader({
		cwd, agentDir, settingsManager,
		noSkills: true, noThemes: true, noContextFiles: true, noPromptTemplates: true,
		...(plan ? { noExtensions: true, additionalExtensionPaths: plan.extensions } : {}),
	});
	await loader.reload();
	const result = loader.getExtensions();
	return { paths: result.extensions.map((extension) => extension.path), errors: result.errors.map((error) => error.error) };
}

const planFor = (cwd: string, agentDir: string) =>
	planLaunch({ cwd, agentDir, userSettings: readSettings(join(agentDir, "settings.json")), projectSettings: readSettings(join(cwd, ".pi", "settings.json")) });

describe("repository identity", () => {
	it("treats a linked worktree and a symlink as the same repository, and another repository as distinct", () => {
		const root = tempRoot();
		const main = repo(root, "main");
		const worktree = join(root, "worktree");
		git(main, "worktree", "add", "-q", worktree, "-b", "lane");
		const link = join(root, "link");
		symlinkSync(main, link);
		expect(repositoryIdentity(worktree)).toBe(repositoryIdentity(main));
		expect(repositoryIdentity(link)).toBe(repositoryIdentity(main));
		expect(repositoryIdentity(repo(root, "other"))).not.toBe(repositoryIdentity(main));
		// The same file in the two checkouts has one resource identity; a different file does not.
		expect(entryIdentity(join(worktree, "extensions", "tool.js"))).toBe(entryIdentity(join(main, "extensions", "tool.js")));
		expect(entryIdentity(join(root, "other", "extensions", "tool.js"))).not.toBe(entryIdentity(join(main, "extensions", "tool.js")));
	});

	it("reports no git identity outside a repository and still yields a stable path identity", () => {
		const root = tempRoot();
		expect(gitPaths(root)).toBeUndefined();
		expect(repositoryIdentity(root)).toBe(`path:${realpathSync(root)}`);
	});

	it("reads the declared extension entries of a package", () => {
		const root = tempRoot();
		const main = repo(root, "main");
		expect(sourceExtensions(main)).toEqual([join(main, "extensions", "tool.js")]);
	});
});

describe("worker launch plan", () => {
	it("loads a worktree copy once, preferring the checkout the worker runs in", () => {
		const root = tempRoot();
		const main = repo(root, "main");
		const worktree = join(root, "worktree");
		git(main, "worktree", "add", "-q", worktree, "-b", "lane");
		mkdirSync(join(worktree, ".pi"), { recursive: true });
		writeFileSync(join(worktree, ".pi", "settings.json"), JSON.stringify({ packages: [".."] }));
		const agentDir = join(root, "agent");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [main] }));
		const plan = planLaunch({ cwd: worktree, agentDir, userSettings: readSettings(join(agentDir, "settings.json")), projectSettings: readSettings(join(worktree, ".pi", "settings.json")) });
		if (plan.mode !== "explicit") throw new Error(`expected an explicit plan, got ${plan.mode}`);
		expect(plan.extensions).toEqual([join(worktree, "extensions", "tool.js")]);
		expect(plan.kept).toEqual([worktree]);
		expect(plan.dropped).toEqual([main]);
		expect(plan.builtins).toContain("codemode");
		expect(describePlan(plan)).toContain("skipped");
	});

	it("loads a symlinked checkout once", async () => {
		const root = tempRoot();
		const main = repo(root, "main");
		const link = join(root, "link");
		symlinkSync(main, link);
		const agentDir = join(root, "agent");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [main] }));
		const plan = planLaunch({ cwd: link, agentDir, userSettings: readSettings(join(agentDir, "settings.json")), projectSettings: { packages: [".."] } });
		// Both sources canonicalize to one checkout, so there is nothing to remove; Pi loads it once.
		expect(plan).toEqual({ mode: "discovery" });
		const loaded = await piLoad(link, agentDir, undefined);
		expect(loaded.paths).toHaveLength(1);
		expect(loaded.errors).toEqual([]);
	});

	it("leaves a distinct repository alone: two different repositories both load", () => {
		const root = tempRoot();
		const first = checkout(root, "first", []);
		const second = checkout(root, "second", [first.dir], "second_tool");
		const plan = planFor(second.dir, second.agentDir);
		expect(plan).toEqual({ mode: "discovery" });
	});

	it("plans nothing for a directory that has no competing registration", () => {
		const root = tempRoot();
		const alone = checkout(root, "alone", []);
		expect(planFor(alone.dir, alone.agentDir)).toEqual({ mode: "discovery" });
	});

	it("still surfaces a genuine conflict between two different repositories", async () => {
		const root = tempRoot();
		const first = checkout(root, "first", [], "shared_tool");
		const second = checkout(root, "second", [first.dir], "shared_tool");
		const plan = planFor(second.dir, second.agentDir);
		expect(plan).toEqual({ mode: "discovery" });
		const loaded = await piLoad(second.dir, second.agentDir, undefined);
		expect(loaded.paths).toHaveLength(2);
		expect(loaded.errors.join("\n")).toContain('Tool "shared_tool" conflicts with');
	});
});

describe("Pi loads the planned extension list once", () => {
	it("turns the two-checkout conflict into one extension and no error", async () => {
		const root = tempRoot();
		const main = repo(root, "main");
		const worktree = join(root, "worktree");
		git(main, "worktree", "add", "-q", worktree, "-b", "lane");
		mkdirSync(join(worktree, ".pi"), { recursive: true });
		writeFileSync(join(worktree, ".pi", "settings.json"), JSON.stringify({ packages: [".."] }));
		const agentDir = join(root, "agent");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [main] }));

		const unplanned = await piLoad(worktree, agentDir, undefined);
		expect(unplanned.paths).toHaveLength(2);
		expect(unplanned.errors.join("\n")).toContain("conflicts with");

		const plan = planLaunch({ cwd: worktree, agentDir, userSettings: readSettings(join(agentDir, "settings.json")), projectSettings: readSettings(join(worktree, ".pi", "settings.json")) });
		if (plan.mode !== "explicit") throw new Error(`expected an explicit plan, got ${plan.mode}`);
		const planned = await piLoad(worktree, agentDir, { extensions: plan.extensions });
		expect(planned.paths).toEqual([join(worktree, "extensions", "tool.js")]);
		expect(planned.errors).toEqual([]);
	});
});
