import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export type ShellName = "bash" | "zsh";
export const BEGIN = "# >>> trebol tern pi >>>";
export const END = "# <<< trebol tern pi <<<";

export function shellTargets(shell: ShellName, home: string, platform: string, zdotdir?: string): string[] {
	if (platform !== "darwin" && platform !== "linux") throw new Error(`Unsupported platform: ${platform}`);
	if (shell === "zsh") return [join(zdotdir || home, ".zshrc")];
	if (shell === "bash") return [join(home, ".bashrc"), join(home, ".bash_profile")];
	throw new Error(`Unsupported shell: ${shell}`);
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function ownedBlock(dispatchPath: string): string {
	const path = shellQuote(resolve(dispatchPath));
	const runner = shellQuote(resolve(dirname(dispatchPath), "../lib/tern/run.ts"));
	return `${BEGIN}\n# Only interactive shells load the Tern Pi dispatcher. Disable per command: PI_TERN_UI=0 pi\ncase $- in *i*) if [ -r ${path} ]; then TREBOL_TERN_RUNNER=${runner}; . ${path}; fi ;; esac\n${END}\n`;
}

export type BlockState = "absent" | "installed" | "conflict";
export function blockState(text: string, block: string): BlockState {
	const begin = text.indexOf(BEGIN);
	const end = text.indexOf(END);
	if (begin < 0 && end < 0) return "absent";
	if (begin < 0 || end < begin || text.indexOf(BEGIN, begin + BEGIN.length) >= 0 || text.indexOf(END, end + END.length) >= 0) return "conflict";
	return text.slice(begin, end + END.length + (text[end + END.length] === "\n" ? 1 : 0)) === block &&
		(begin === 0 || text[begin - 1] === "\n") ? "installed" : "conflict";
}

export function editBlock(text: string, block: string, action: "install" | "uninstall"): string {
	const state = blockState(text, block);
	if (state === "conflict") throw new Error("Trebol shell block was modified; refusing to overwrite user changes");
	if (action === "install" && state === "absent" && /(?:^|\n)\s*(?:alias\s+pi=|(?:function\s+)?pi\s*\(\s*\)\s*\{|function\s+pi(?:\s|\{))/m.test(text)) {
		throw new Error("An existing pi alias or function would override Trebol's dispatch; refusing to install");
	}
	// Prepend the entire owned block so uninstall can restore *all* original
	// bytes, including files with no final newline. A later user definition of
	// pi takes precedence, rather than our setup overriding it.
	if (action === "install") return state === "installed" ? text : `${block}${text}`;
	if (state !== "installed") return text;
	const at = text.indexOf(block);
	return text.slice(0, at) + text.slice(at + block.length);
}

async function readSafe(path: string): Promise<{ text: string; mode: number; exists: boolean }> {
	try {
		const info = await lstat(path);
		if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Refusing unsafe shell startup file: ${path}`);
		if (info.size > 1024 * 1024) throw new Error(`Shell startup file too large: ${path}`);
		return { text: await readFile(path, "utf8"), mode: info.mode & 0o777, exists: true };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { text: "", mode: 0o600, exists: false };
		throw error;
	}
}

async function assertSafeHome(home: string, zdotdir?: string): Promise<void> {
	for (const dir of [home, ...(zdotdir ? [zdotdir] : [])]) {
		const info = await lstat(dir);
		if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Refusing unsafe shell directory: ${dir}`);
	}
}

export async function targetsForSetup(shell: ShellName, home: string, platform: string, zdotdir?: string): Promise<string[]> {
	await assertSafeHome(home, zdotdir);
	const paths = shellTargets(shell, home, platform, zdotdir);
	if (shell !== "bash") return paths;
	const rc = await readSafe(paths[0]);
	// Bash login reads the first existing profile; never shadow .profile by
	// creating a new .bash_profile above it.
	for (const name of [".bash_profile", ".bash_login", ".profile"]) {
		const path = join(home, name);
		if ((await readSafe(path)).exists) return rc.exists ? [paths[0], path] : [path];
	}
	// With no login profile, create .bash_profile only. Creating .bashrc as
	// well would add a newly sourced file that did not exist before setup.
	return rc.exists ? paths : [paths[1]];
}

export async function setupShell(shell: ShellName, home: string, platform: string, dispatchPath: string, action: "install" | "uninstall", zdotdir?: string): Promise<{ changed: string[]; unchanged: string[] }> {
	await assertSafeHome(home, zdotdir);
	if (shell === "zsh" && (await readSafe(join(zdotdir || home, ".zshrc.local"))).text.includes(dispatchPath)) {
		throw new Error("An unmanaged Tern Pi override already exists in .zshrc.local; remove it manually before using the wizard");
	}
	const targets = await targetsForSetup(shell, home, platform, zdotdir);
	const block = ownedBlock(dispatchPath);
	if (shell === "bash") {
		// A prior wizard run may have installed in another profile; bash would
		// then load two different definitions or uninstall the wrong one.
		for (const name of [".bash_profile", ".bash_login", ".profile"]) {
			const path = join(home, name);
			if (!targets.includes(path) && blockState((await readSafe(path)).text, block) !== "absent") {
				throw new Error(`Conflicting Trebol shell block in ${path}`);
			}
		}
	}
	// Preflight every file before touching any: a changed block in one target
	// cannot leave only the other half of bash configured.
	const edits = await Promise.all(targets.map(async (path) => {
		const old = await readSafe(path);
		return { path, old, next: editBlock(old.text, block, action) };
	}));
	const changed: string[] = [];
	const unchanged: string[] = [];
	try {
		for (const { path, old, next } of edits) {
			if (old.text === next || (action === "uninstall" && !old.exists)) { unchanged.push(path); continue; }
			await mkdir(dirname(path), { recursive: true });
			const tmp = join(dirname(path), `.trebol-shell-${process.pid}-${Math.random().toString(16).slice(2)}`);
			try {
				await writeFile(tmp, next, { mode: old.mode, flag: "wx" });
				// Reject external edits during the wizard; never follow changed symlinks.
				const current = await readSafe(path);
				if (current.text !== old.text || current.exists !== old.exists) throw new Error(`Shell startup file changed during setup: ${path}`);
				await rename(tmp, path);
				changed.push(path);
			} finally { await rm(tmp, { force: true }); }
		}
	} catch (error) {
		// Best effort rollback of files this invocation changed. Never overwrite a
		// third-party edit that arrived after our rename.
		for (const path of changed.reverse()) {
			const { old, next } = edits.find((edit) => edit.path === path)!;
			try {
				const current = await readSafe(path);
				if (current.text !== next) continue;
				if (!old.exists) await rm(path);
				else {
					const tmp = join(dirname(path), `.trebol-rollback-${process.pid}-${Math.random().toString(16).slice(2)}`);
					try { await writeFile(tmp, old.text, { mode: old.mode, flag: "wx" }); await rename(tmp, path); }
					finally { await rm(tmp, { force: true }); }
				}
			} catch { /* Preserve the original write failure; warn caller below. */ }
		}
		throw error;
	}
	return { changed, unchanged };
}

export async function shellSetupState(shell: ShellName, home: string, platform: string, dispatchPath: string, zdotdir?: string): Promise<BlockState> {
	await assertSafeHome(home, zdotdir);
	const targets = await targetsForSetup(shell, home, platform, zdotdir);
	const block = ownedBlock(dispatchPath);
	const states = await Promise.all(targets.map(async (path) => blockState((await readSafe(path)).text, block)));
	if (shell === "bash") {
		for (const name of [".bash_profile", ".bash_login", ".profile"]) {
			const path = join(home, name);
			if (!targets.includes(path) && blockState((await readSafe(path)).text, block) !== "absent") return "conflict";
		}
	}
	// An older hand-written loader is outside the wizard's owned block. Do not
	// offer an uninstall that would leave it active while saying "removed".
	if (shell === "zsh") {
		const local = await readSafe(join(zdotdir || home, ".zshrc.local"));
		if (local.text.includes(dispatchPath)) return "conflict";
	}
	return states.includes("conflict") || (states.includes("installed") && states.includes("absent")) ? "conflict" : states.every((state) => state === "installed") ? "installed" : "absent";
}
