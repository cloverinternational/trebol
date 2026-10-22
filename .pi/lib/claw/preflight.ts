/** Launch gate for a Claw worker tab. A worker is a plain `pi` process whose first act is to load the extension source
 *  under its cwd, so two failures are possible before any run event can exist:
 *   - the source does not parse (a file mid-write, a half-applied edit, a half-installed tool set). Expected to clear by
 *     itself, so the gate is retried a bounded number of times with backoff and jitter and then failed with the real
 *     diagnostic. A configuration error that waiting cannot fix is never retried.
 *   - the checkout is no longer the one the run was created from (branch switched, HEAD moved, tracked files edited). The
 *     worker would load different code than the orchestrator, so the launch is refused with the checkout named. The choice
 *     is fail-fast, not snapshotting the tree: a copy of a pi package (node_modules and all) is both expensive and a
 *     different tree than the one the orchestrator verified.
 *  Everything here is pure-ish and injectable so the daemon can be tested without git, Tern or a real worker. */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

/** One try plus three retries. Long enough to outlive an editor writing a file, short enough to stay inside a launch. */
export const PREFLIGHT_ATTEMPTS = 4;
export const PREFLIGHT_BASE_DELAY_MS = 200;
export const PREFLIGHT_MAX_DELAY_MS = 2_000;
/** Fraction of the delay that is randomised, so two launches retrying together do not line up. */
export const PREFLIGHT_JITTER = 0.35;
/** Files the import walk may parse for one launch. A pi package is far smaller; the cap only bounds a pathological graph. */
export const MAX_PREFLIGHT_FILES = 2_000;

export type FailureKind = "transient" | "deterministic";

/** The checkout a launch reads its extension source from. `fingerprint` covers the content of tracked changes, so a
 *  second edit of an already-dirty file is still a change. */
export type SourceState = { root: string; head?: string; branch?: string; dirty: string[]; fingerprint?: string };

export type PreflightInput = { cwd: string; workspace: string; recorded?: SourceState };
export type PreflightResult =
	| { ok: true; source?: SourceState; warnings?: string[] }
	| { ok: false; error: string; kind?: FailureKind };
/** The gate is a value so a test (or a future caller) can supply its own loader check. */
export type Preflight = (input: PreflightInput) => Promise<PreflightResult>;

/** Symptoms of a source file caught between two writes, or of a reload that half-registered its tools. All of these are
 *  expected to clear on their own, so they are worth another attempt. */
const TRANSIENT_PATTERNS: readonly RegExp[] = [
	/ParseError/i,
	/SyntaxError/i,
	/Unexpected token/i,
	/Unexpected end of input/i,
	/Unexpected keyword/i,
	/Invalid or unexpected token/i,
	/Unterminated/i,
	/expected\b/i,
	/Expression expected/i,
	/ERR_MODULE_NOT_FOUND/i,
	/Cannot find module/i,
	/ENOENT/,
	/EBUSY|EAGAIN|ETXTBSY/,
	/already (registered|in use|exists|registered under)/i,
	/duplicate/i,
	/conflicts with/i,
];

/** Errors that waiting cannot fix: the source or its configuration is wrong and a human must change it. */
const DETERMINISTIC_PATTERNS: readonly RegExp[] = [
	/unknown (provider|model)/i,
	/provider is not configured/i,
	/not authenticated/i,
	/invalid api ?key/i,
	/api key/i,
	/creden/i,
	/invalid config/i,
	/config(uration)? (error|invalid|file|missing)/i,
	/settings\.json/i,
	/project (is not )?trust/i,
	/extension entry point/i,
	/no pi package/i,
	/source checkout/i,
	/EACCES|EPERM/,
];

/** Which retry policy applies to a launch failure. Deterministic wins, then transient, then unknown (retried inside the
 *  bounded budget, so a slow-clearing write is still rescued while a misconfiguration still surfaces quickly). */
export function classifyLaunchFailure(message: unknown): FailureKind {
	const text = String(message ?? "");
	if (DETERMINISTIC_PATTERNS.some((re) => re.test(text))) return "deterministic";
	if (TRANSIENT_PATTERNS.some((re) => re.test(text))) return "transient";
	return "transient";
}

// --- extension source discovery --------------------------------------------------------------------------------------

export type PiPackage = { found: true; root: string; entryPoints: string[] };
export type PackageLookup = PiPackage | { found: false; reason: "none" | "invalid"; error?: string };

/** The pi package whose extensions a `pi` started in `start` loads: the nearest ancestor `package.json` that declares
 *  `pi.extensions` (the manifest pi reads). A package.json that does not parse is reported, not skipped: pi would fail on
 *  it too, and the message is the useful part of the launch failure. */
export function findPiPackage(start: string): PackageLookup {
	let dir = resolve(start);
	for (;;) {
		const path = join(dir, "package.json");
		if (existsSync(path)) {
			let pkg: unknown;
			try {
				pkg = JSON.parse(readFileSync(path, "utf8"));
			} catch (error) {
				return { found: false, reason: "invalid", error: `${path} is not valid JSON: ${(error as Error).message}` };
			}
			const declared = (pkg as { pi?: { extensions?: unknown } } | undefined)?.pi?.extensions;
			if (Array.isArray(declared)) {
				const entryPoints = declared.filter((e): e is string => typeof e === "string" && e.trim() !== "").map((e) => resolve(dir, e));
				if (entryPoints.length) return { found: true, root: dir, entryPoints };
			}
		}
		const parent = dirname(dir);
		if (parent === dir) return { found: false, reason: "none" };
		dir = parent;
	}
}

type TypeScript = typeof import("typescript");
let typeScript: Promise<TypeScript> | undefined;
/** The compiler is loaded on the first launch gate, not when the daemon or extension starts: a parse is only needed when
 *  a worker is about to be launched. */
function loadTypeScript(): Promise<TypeScript> {
	typeScript ??= import("typescript").then((mod) => ((mod as { default?: TypeScript }).default ?? mod) as TypeScript);
	return typeScript;
}

/** Parse results are keyed by path, mtime and size, so a launch after an edit re-parses exactly the edited file. */
const parseCache = new Map<string, string>();
const rememberParse = (key: string, error: string): void => {
	if (parseCache.size > MAX_PREFLIGHT_FILES * 2) parseCache.clear();
	parseCache.set(key, error);
};

export type SourceCheck = { ok: true; files: number } | { ok: false; error: string };

/** `parseDiagnostics` is the syntax-only diagnostic list of a SourceFile. It is runtime API that the published typings
 *  do not declare, so it is narrowed here instead of reaching for `any`. */
type ParsedSource = import("typescript").SourceFile & { parseDiagnostics?: readonly import("typescript").Diagnostic[] };

function scriptKind(ts: TypeScript, file: string): import("typescript").ScriptKind {
	if (file.endsWith(".tsx")) return ts.ScriptKind.TSX;
	if (file.endsWith(".jsx")) return ts.ScriptKind.JSX;
	if (file.endsWith(".js") || file.endsWith(".mjs") || file.endsWith(".cjs")) return ts.ScriptKind.JS;
	return ts.ScriptKind.TS;
}

/** Relative module specifiers of a parsed file: static imports and re-exports, plus dynamic `import("...")`. */
export function localSpecifiers(ts: TypeScript, file: import("typescript").SourceFile): string[] {
	const out: string[] = [];
	const visit = (node: import("typescript").Node): void => {
		if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
			out.push(node.moduleSpecifier.text);
		} else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
			const [arg] = node.arguments;
			if (arg && ts.isStringLiteral(arg)) out.push(arg.text);
		}
		ts.forEachChild(node, visit);
	};
	visit(file);
	return out;
}

/** Resolves a relative specifier the way the extension loader would find the file it imports. */
export function resolveLocalImport(from: string, spec: string): string | undefined {
	const base = resolve(dirname(from), spec);
	const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}.mts`, join(base, "index.ts"), join(base, "index.tsx")];
	if (/\.m?js$/.test(base)) candidates.unshift(base.replace(/\.m?js$/, ".ts"), base.replace(/\.m?js$/, ".tsx"));
	return candidates.find((c) => {
		try { return statSync(c).isFile(); } catch { return false; }
	});
}

/** Parses every registered entry point and the local modules it reaches. A mid-write anywhere in that closure is reported
 *  as `ParseError: <relative path>:<line>:<column> <diagnostic>`, the shape pi's loader uses, so the run error points at
 *  the file a human has to fix. */
export async function checkExtensionSource(entryPoints: readonly string[], root: string): Promise<SourceCheck> {
	const ts = await loadTypeScript();
	const base = resolve(root);
	const queue = [...entryPoints];
	const seen = new Set<string>();
	let files = 0;
	while (queue.length) {
		const file = queue.shift()!;
		if (seen.has(file)) continue;
		seen.add(file);
		if (!file.startsWith(`${base}${sep}`)) continue;
		const name = relative(base, file);
		let source: string;
		let key: string;
		try {
			const stat = statSync(file);
			key = `${file}\u0000${stat.mtimeMs}\u0000${stat.size}`;
			const cached = parseCache.get(key);
			if (cached) return { ok: false, error: cached };
			source = readFileSync(file, "utf8");
		} catch (error) {
			return { ok: false, error: `${name}: ${(error as Error).message}` };
		}
		const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKind(ts, file)) as ParsedSource;
		const [first] = parsed.parseDiagnostics ?? [];
		if (first) {
			const at = parsed.getLineAndCharacterOfPosition(first.start ?? 0);
			const error = `ParseError: ${name}:${at.line + 1}:${at.character} ${ts.flattenDiagnosticMessageText(first.messageText, " ")}`;
			rememberParse(key, error);
			return { ok: false, error };
		}
		files++;
		for (const spec of localSpecifiers(ts, parsed)) {
			if (!spec.startsWith(".")) continue;
			const next = resolveLocalImport(file, spec);
			if (next && !seen.has(next)) queue.push(next);
		}
		if (files >= MAX_PREFLIGHT_FILES) break;
	}
	return { ok: true, files };
}

// --- checkout identity -----------------------------------------------------------------------------------------------

export type GitRunner = (args: string[], cwd: string) => Promise<string>;
/** `--no-optional-locks` keeps a status/diff probe from taking the index lock the worker or another agent may hold. */
export const gitExec: GitRunner = async (args, cwd) =>
	(await promisify(execFile)("git", ["--no-optional-locks", ...args], { cwd, timeout: 20_000, maxBuffer: 64 * 1024 * 1024 })).stdout;

/** HEAD, branch and a fingerprint of tracked changes. Undefined when `root` is not a git checkout, which is not a failure:
 *  the launch simply has no checkout identity to compare. */
export async function sourceState(root: string, git: GitRunner = gitExec): Promise<SourceState | undefined> {
	try {
		if ((await git(["rev-parse", "--is-inside-work-tree"], root)).trim() !== "true") return undefined;
		const head = (await git(["rev-parse", "HEAD"], root)).trim();
		const branch = (await git(["rev-parse", "--abbrev-ref", "HEAD"], root)).trim();
		const dirty = (await git(["status", "--porcelain=v1", "--untracked-files=no"], root))
			.split("\n").map((line) => line.slice(3).trim()).filter(Boolean).sort();
		const diff = await git(["diff", "HEAD", "--", "."], root);
		return { root, head, branch, dirty, fingerprint: createHash("sha256").update(diff).digest("hex").slice(0, 16) };
	} catch {
		return undefined;
	}
}

/** The checkout a run would be launched from: the pi package above its cwd, else its cwd when that is a git work tree. */
export async function snapshotSource(cwd: string, git: GitRunner = gitExec): Promise<SourceState | undefined> {
	const lookup = findPiPackage(cwd);
	return sourceState(lookup.found ? lookup.root : cwd, git);
}

export function describeSource(state: SourceState): string {
	const at = state.head ? `${state.branch || "detached"}@${state.head.slice(0, 12)}` : "no commit";
	const dirty = state.dirty.length ? `, ${state.dirty.length} tracked file${state.dirty.length === 1 ? "" : "s"} modified` : "";
	return `${state.root} (${at}${dirty})`;
}

/** Why a launch must not proceed against `current`, or undefined when the checkout is the one the run was created from.
 *  A checkout that was already dirty at creation is the orchestrator's deliberate state and is allowed: only a move or a
 *  new edit between creation and launch is refused. */
export function compareSource(recorded: SourceState, current: SourceState): string | undefined {
	if (recorded.root !== current.root) {
		return `source checkout changed since this run was created: it was ${describeSource(recorded)} and is now ${describeSource(current)}`;
	}
	const moved: string[] = [];
	if (recorded.head && current.head && recorded.head !== current.head) moved.push(`HEAD ${recorded.head.slice(0, 12)} -> ${current.head.slice(0, 12)}`);
	if (recorded.branch && current.branch && recorded.branch !== current.branch) moved.push(`branch "${recorded.branch}" -> "${current.branch}"`);
	if (moved.length) {
		return `source checkout moved since this run was created: ${describeSource(current)} (${moved.join(", ")}). The worker would load different code than the orchestrator, so no tab was opened; settle the checkout, then spawn a new run`;
	}
	if (recorded.fingerprint && current.fingerprint && recorded.fingerprint !== current.fingerprint) {
		const appeared = current.dirty.filter((path) => !recorded.dirty.includes(path));
		const listed = (appeared.length ? appeared : current.dirty).slice(0, 5).join(", ");
		const more = current.dirty.length > 5 ? ` and ${current.dirty.length - 5} more` : "";
		return `source checkout is dirty in ways it was not when this run was created: ${describeSource(current)}; edited tracked file${appeared.length === 1 ? "" : "s"}: ${listed}${more}. A worker launched now would load edited extension code; commit, stash or revert those files, then spawn a new run`;
	}
	return undefined;
}

// --- the gate --------------------------------------------------------------------------------------------------------

/** The real gate: is the extension source the worker's cwd resolves to parseable, and is it still the checkout this run
 *  was created from? */
export const defaultPreflight: Preflight = async ({ cwd, recorded }) => {
	const lookup = findPiPackage(cwd);
	if (!lookup.found) {
		if (lookup.reason === "invalid") {
			const error = lookup.error ?? "package.json is not valid JSON";
			return { ok: false, kind: classifyLaunchFailure(error), error };
		}
		return { ok: true, warnings: [`no pi package at or above ${cwd}: the worker loads pi's installed extensions, which this launch gate cannot inspect`] };
	}
	const current = await sourceState(lookup.root);
	if (recorded && current) {
		const refusal = compareSource(recorded, current);
		if (refusal) return { ok: false, kind: "deterministic", error: refusal };
	}
	const warnings: string[] = [];
	if (current?.dirty.length) warnings.push(`source checkout is already dirty: ${describeSource(current)}`);
	const checked = await checkExtensionSource(lookup.entryPoints, lookup.root);
	if (!checked.ok) return { ok: false, kind: classifyLaunchFailure(checked.error), error: checked.error };
	return { ok: true, source: current, warnings };
};

/** Exponential backoff with symmetric jitter: `base * 2^(attempt-1)` scaled to [0.65, 1.35) of itself. */
export function backoffDelay(attempt: number, random: () => number): number {
	const base = Math.min(PREFLIGHT_MAX_DELAY_MS, PREFLIGHT_BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1));
	return Math.round(base * (1 - PREFLIGHT_JITTER + random() * PREFLIGHT_JITTER * 2));
}

export type PreflightOutcome =
	| { ok: true; attempts: number; source?: SourceState; warnings: string[] }
	| { ok: false; attempts: number; kind: FailureKind; error: string; warnings: string[] };

export type PreflightOptions = {
	check?: Preflight;
	sleep?: (ms: number) => Promise<void>;
	random?: () => number;
	attempts?: number;
};

/** Runs the gate, retrying only transient load/parse/tool-conflict failures. The last real error is kept verbatim so the
 *  failed run says what the loader said, not just that it gave up. */
export async function preflightLaunch(input: PreflightInput, options: PreflightOptions = {}): Promise<PreflightOutcome> {
	const check = options.check ?? defaultPreflight;
	const sleep = options.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
	const random = options.random ?? Math.random;
	const budget = Math.max(1, options.attempts ?? PREFLIGHT_ATTEMPTS);
	const warnings: string[] = [];
	for (let attempt = 1; attempt <= budget; attempt++) {
		let result: PreflightResult;
		try {
			result = await check(input);
		} catch (error) {
			result = { ok: false, error: (error as Error).message };
		}
		if (result.ok) return { ok: true, attempts: attempt, source: result.source, warnings: [...warnings, ...(result.warnings ?? [])] };
		const kind = result.kind ?? classifyLaunchFailure(result.error);
		if (kind === "deterministic") return { ok: false, attempts: attempt, kind, error: result.error, warnings };
		if (attempt === budget) return { ok: false, attempts: attempt, kind, error: result.error, warnings };
		warnings.push(`attempt ${attempt}/${budget} did not pass the launch gate: ${result.error}`);
		await sleep(backoffDelay(attempt, random));
	}
	throw new Error("preflight: empty retry budget");
}
