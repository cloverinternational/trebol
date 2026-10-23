import { afterEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, chmod, symlink, writeFile, stat, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blockState, editBlock, ownedBlock, setupShell, shellTargets, shellSetupState } from "../../lib/ui/tern-shell-setup.ts";
import { currentShell, ternSetupWizard } from "../../lib/ui/tern-setup-wizard.ts";

const homes: string[] = [];
async function temp() { const path = await mkdtemp(join(tmpdir(), "trebol-tern-test-")); homes.push(path); return path; }
afterEach(async () => { for (const path of homes.splice(0)) await rm(path, { recursive: true, force: true }); });

// The dispatch these tests execute must work in both shells the product
// supports. A missing shell used to surface as "(undefined and string)" from
// spawnSync's ENOENT result; name the requirement instead, so an environment
// that lacks zsh (CI installs it) says so.
const SHELLS = ["bash", "zsh"] as const;
function requireShells() {
	const missing = SHELLS.filter((shell) => spawnSync(shell, ["-c", "true"], { stdio: "ignore" }).status !== 0);
	expect(missing, `${missing.join(", ")} must be installed: the generated dispatch is executed in ${SHELLS.join(" and ")}`).toEqual([]);
}

describe("shell setup editor", () => {
	it("selects zsh and bash startup paths on macOS/Linux", () => {
		for (const platform of ["darwin", "linux"]) {
			expect(shellTargets("zsh", "/tmp/home", platform)).toEqual(["/tmp/home/.zshrc"]);
			expect(shellTargets("zsh", "/tmp/home", platform, "/tmp/dot")).toEqual(["/tmp/dot/.zshrc"]);
			expect(shellTargets("bash", "/tmp/home", platform)).toEqual(["/tmp/home/.bashrc", "/tmp/home/.bash_profile"]);
		}
		expect(() => shellTargets("zsh", "/tmp/home", "win32")).toThrow(/Unsupported/);
	});

	it("preserves byte-exact content and permissions across repeat install/uninstall", async () => {
		const home = await temp(), path = join(home, ".zshrc"), original = Buffer.from("# own config\nexport X='yes'");
		await writeFile(path, original); await chmod(path, 0o640);
		const dispatch = join(home, "dispatch.sh");
		expect((await setupShell("zsh", home, "darwin", dispatch, "install")).changed).toEqual([path]);
		expect((await setupShell("zsh", home, "darwin", dispatch, "install")).changed).toEqual([]);
		expect(blockState(await readFile(path, "utf8"), ownedBlock(dispatch))).toBe("installed");
		expect((await stat(path)).mode & 0o777).toBe(0o640);
		await setupShell("zsh", home, "darwin", dispatch, "uninstall");
		expect(await readFile(path)).toEqual(original);
		expect((await stat(path)).mode & 0o777).toBe(0o640);
	});

	it("preflights both bash targets; refuses edited blocks and symlinks", async () => {
		const home = await temp(), dispatch = join(home, "dispatch.sh");
		await writeFile(join(home, ".bash_profile"), `${ownedBlock(dispatch)}# changed\n`);
		await writeFile(join(home, ".bashrc"), `${ownedBlock(dispatch).replace("interactive", "altered")}`);
		await expect(setupShell("bash", home, "linux", dispatch, "install")).rejects.toThrow(/modified/);
		expect(await readFile(join(home, ".bash_profile"), "utf8")).toContain("# changed");
		await rm(join(home, ".bashrc")); await symlink(join(home, ".bash_profile"), join(home, ".bashrc"));
		await expect(setupShell("bash", home, "linux", dispatch, "install")).rejects.toThrow(/unsafe/);
	});

	it("quotes paths safely and never removes a modified owned block", () => {
		const block = ownedBlock("/tmp/it's here/dispatch.sh");
		expect(block).toContain("'\\''");
		expect(() => editBlock(block.replace("interactive", "altered"), block, "uninstall")).toThrow(/modified/);
		expect(() => editBlock("alias pi='other'\n", block, "install")).toThrow(/existing pi alias/);
		expect(() => editBlock("pi() { command pi; }\n", block, "install")).toThrow(/existing pi alias/);
	});

	it("does not shadow an existing bash .profile or create a dormant .bashrc", async () => {
		const home = await temp(), dispatch = join(home, "dispatch.sh");
		await writeFile(join(home, ".profile"), "# login profile\n");
		expect((await setupShell("bash", home, "linux", dispatch, "install")).changed).toEqual([join(home, ".profile")]);
		await expect(readFile(join(home, ".bash_profile"))).rejects.toMatchObject({ code: "ENOENT" });
		await expect(readFile(join(home, ".bashrc"))).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("refuses a stale managed block in a non-selected bash profile", async () => {
		const home = await temp(), dispatch = join(home, "dispatch.sh");
		await writeFile(join(home, ".bash_profile"), "# currently selected\n");
		await writeFile(join(home, ".profile"), ownedBlock(dispatch));
		expect(await shellSetupState("bash", home, "linux", dispatch)).toBe("conflict");
		await expect(setupShell("bash", home, "linux", dispatch, "install")).rejects.toThrow(/Conflicting/);
		expect(await readFile(join(home, ".bash_profile"), "utf8")).toBe("# currently selected\n");
	});

	it("detects an older unmanaged zsh local override instead of installing twice", async () => {
		const home = await temp(), dispatch = join(home, "dispatch.sh");
		await writeFile(join(home, ".zshrc.local"), `[ -r '${dispatch}' ] && . '${dispatch}'\n`);
		expect(await shellSetupState("zsh", home, "darwin", dispatch)).toBe("conflict");
		await expect(setupShell("zsh", home, "darwin", dispatch, "install")).rejects.toThrow(/unmanaged/);
	});

	it("rejects a symlinked ZDOTDIR instead of writing through it", async () => {
		const home = await temp(), dot = join(home, "dot"), link = join(home, "link");
		await mkdir(dot); await symlink(dot, link);
		await expect(setupShell("zsh", home, "linux", join(home, "dispatch.sh"), "install", link)).rejects.toThrow(/unsafe shell directory/);
		await expect(readFile(join(dot, ".zshrc"))).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("executes generated dispatch in bash and zsh without recursion or lost flags", async () => {
		requireShells();
		const home = await temp(), dispatch = join(home, "dispatch.sh");
		await writeFile(dispatch, "pi() { if [[ $# -eq 0 && ${TERM_PROGRAM:-} == tern && -n ${TERN_PANE:-} ]]; then printf TSP; else command pi \"$@\"; fi; }\n");
		await mkdir(join(home, "bin"));
		const binary = join(home, "bin", "pi");
		await writeFile(binary, "#!/bin/sh\nprintf 'NATIVE:%s' \"$*\"\nexit 7\n"); await chmod(binary, 0o755);
		for (const shell of ["bash", "zsh"] as const) {
			const file = join(home, `${shell}.rc`);
			await writeFile(file, ownedBlock(dispatch));
			const run = (env: Record<string, string>, cmd: string) => spawnSync(shell, ["-ic", `. '${file}'; ${cmd}`], { encoding: "utf8", env: { ...process.env, PATH: `${join(home, "bin")}:${process.env.PATH}`, TERM_PROGRAM: "other", TERN_PANE: "", ...env } });
			expect(run({ TERM_PROGRAM: "tern", TERN_PANE: "123" }, "pi").stdout).toContain("TSP");
			const flagged = run({ TERM_PROGRAM: "tern", TERN_PANE: "123" }, "pi --version");
			expect(flagged.stdout).toContain("NATIVE:--version"); expect(flagged.status).toBe(7);
			expect(run({}, "pi").stdout).toContain("NATIVE:");
		}
	});

	it("sources the real dispatcher under bash and zsh and preserves flagged fallback", async () => {
		requireShells();
		const home = await temp(), repo = join(home, "repo"), dispatch = join(repo, ".pi/config/tern-pi.zsh");
		await mkdir(join(repo, ".pi/lib/tern"), { recursive: true }); await mkdir(join(repo, ".pi/config"), { recursive: true }); await mkdir(join(home, "bin"));
		await writeFile(dispatch, await readFile(join(process.cwd(), ".pi/config/tern-pi.zsh")));
		await writeFile(join(repo, ".pi/lib/tern/run.ts"), "// fixture\n");
		for (const [name, contents] of [["pi", "NATIVE"], ["node", "TSP"]] as const) {
			const path = join(home, "bin", name);
			await writeFile(path, `#!/bin/sh\nprintf '${contents}:%s' "$*"\nexit 17\n`); await chmod(path, 0o755);
		}
		for (const shell of ["bash", "zsh"] as const) {
			const file = join(home, `${shell}.rc`); await writeFile(file, ownedBlock(dispatch));
			const run = (env: Record<string, string>, cmd: string) => spawnSync(shell, ["-ic", `. '${file}'; ${cmd}`], { encoding: "utf8", env: { ...process.env, PATH: `${join(home, "bin")}:${process.env.PATH}`, TERM_PROGRAM: "tern", TERN_PANE: "123", ...env } });
			expect(run({}, "pi --version").stdout).toContain("NATIVE:--version");
			const bypass = run({}, `pi -nt --model 'a b'`);
			expect(bypass.stdout).toContain("NATIVE:--model a b"); expect(bypass.status).toBe(17);
			expect(run({}, "pi -nt -nt").stdout).toContain("NATIVE:-nt");
			expect(run({}, "pi --version -nt").stdout).toContain("NATIVE:--version -nt");
			expect(run({ TERM_PROGRAM: "other" }, "pi").stdout).toContain("NATIVE:");
			expect(run({ PI_TERN_UI: "0" }, "pi").stdout).toContain("NATIVE:");
			expect(run({}, "pi --version").status).toBe(17);
		}
	});
});

describe("optional startup wizard", () => {
	it("decline and EOF do not write dotfiles", async () => {
		const home = await temp(), repo = join(home, "repo");
		await mkdir(join(repo, ".pi/config"), { recursive: true }); await mkdir(join(repo, ".pi/lib/tern"), { recursive: true });
		await writeFile(join(repo, ".pi/config/tern-pi.zsh"), ""); await writeFile(join(repo, ".pi/lib/tern/run.ts"), "");
		const confirm = vi.fn().mockResolvedValue(undefined);
		const ctx = { mode: "tui", hasUI: true, ui: { confirm } };
		const opts = { env: { SHELL: "/bin/zsh" }, platform: "darwin", home, tty: true };
		expect(await ternSetupWizard(ctx, repo, opts)).toBe("declined");
		expect(confirm).toHaveBeenCalledOnce();
		await expect(readFile(join(home, ".zshrc"))).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("skips noninteractive, unsupported shell and missing UI files", async () => {
		const home = await temp(), ctx = { mode: "tui", hasUI: true, ui: { confirm: vi.fn() } };
		expect(await ternSetupWizard(ctx, home, { tty: false })).toMatch(/^skipped/);
		expect(await ternSetupWizard(ctx, home, { tty: true, env: { SHELL: "/bin/fish" } })).toMatch(/^skipped/);
		expect(await ternSetupWizard(ctx, home, { tty: true, env: { SHELL: "/bin/zsh" }, platform: "darwin", home })).toMatch(/^skipped/);
		expect(ctx.ui.confirm).not.toHaveBeenCalled();
	});

	it("installs only with consent and offers uninstall later", async () => {
		const home = await temp(), repo = join(home, "repo");
		await mkdir(join(repo, ".pi/config"), { recursive: true }); await mkdir(join(repo, ".pi/lib/tern"), { recursive: true });
		await writeFile(join(repo, ".pi/config/tern-pi.zsh"), ""); await writeFile(join(repo, ".pi/lib/tern/run.ts"), "");
		const ctx = { mode: "tui", hasUI: true, ui: { confirm: vi.fn().mockResolvedValue(true) } };
		const opts = { env: { SHELL: "/bin/bash" }, platform: "linux", home, tty: true };
		expect(await ternSetupWizard(ctx, repo, opts)).toMatch(/^installed:/);
		expect(await ternSetupWizard(ctx, repo, { ...opts, startup: true })).toBe("already installed");
		expect(await ternSetupWizard(ctx, repo, opts)).toMatch(/^uninstalled:/);
		await expect(readFile(join(home, ".bashrc"))).rejects.toMatchObject({ code: "ENOENT" });
		expect(await readFile(join(home, ".bash_profile"), "utf8")).toBe("");
	});
});
