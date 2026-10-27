// Slash-command catalogue, autocomplete entries and routing for the Tern bridge. Only pi-tui's pure fuzzy filter is imported.
// Only names Pi would dispatch are runnable. Anything else is refused here, so an unknown or unsupported
// `/x` never reaches the model. Extension, template and skill names are read from the live session on
// every submission (see sessionCommandSource), so reloads are picked up.

import { fuzzyFilter } from "@earendil-works/pi-tui";
// BUILTIN_SLASH_COMMANDS is not exported from the pi-coding-agent 1.0.4 package root (its exports map
// blocks deep imports), so names, descriptions and argument hints are copied from dist/core/slash-commands.js.
export const BUILTIN_COMMANDS: ReadonlyArray<{ name: string; description: string; argumentHint?: string }> = [
	{ name: "settings", description: "Open settings menu" },
	{ name: "model", description: "Select model (opens selector UI)", argumentHint: "<provider/model>" },
	{ name: "tree", description: "Navigate session tree (switch branches)" },
	{ name: "thinking", description: "Set thinking level", argumentHint: "<level>" },
	{ name: "scoped-models", description: "Enable/disable models for Ctrl+P cycling" },
	{ name: "export", description: "Export session (HTML default, or specify path: .html/.jsonl)" },
	{ name: "import", description: "Import and resume a session from a JSONL file" },
	{ name: "share", description: "Share session as a secret GitHub gist" },
	{ name: "bug", description: "Report a bug to the Pi developers", argumentHint: "<description>" },
	{ name: "copy", description: "Copy last agent message to clipboard" },
	{ name: "name", description: "Set session display name" },
	{ name: "session", description: "Show session info and stats" },
	{ name: "changelog", description: "Show changelog entries" },
	{ name: "hotkeys", description: "Show all keyboard shortcuts" },
	{ name: "fork", description: "Create a new fork from a previous user message" },
	{ name: "clone", description: "Duplicate the current session at the current position" },
	{ name: "trust", description: "Save project trust decision for future sessions" },
	{ name: "login", description: "Configure provider authentication", argumentHint: "<provider>" },
	{ name: "logout", description: "Remove provider authentication" },
	{ name: "new", description: "Start a new session" },
	{ name: "compact", description: "Manually compact the session context" },
	{ name: "resume", description: "Resume a different session" },
	{ name: "reload", description: "Reload keybindings, extensions, skills, prompts, themes, and context files" },
	{ name: "quit", description: "Quit pi" },
];

// Builtins the Tern frontend runs on the live session (bridge #runBuiltin). The rest need Pi's interactive
// mode (terminal selectors, clipboard, gist, session switching) and stay unavailable here.
export const TERN_BUILTINS: ReadonlySet<string> = new Set(["model", "thinking", "compact", "name", "export", "reload", "quit", "resume", "new"]);

// OMP's slash-command icon names (its builtin table; commands without one fall back to "action").
// Tern resolves these OMP symbol names to its own icons.
const BUILTIN_ICONS: Readonly<Record<string, string>> = {
	settings: "settings", model: "model", tree: "tree", export: "export", share: "share", copy: "copy",
	session: "session", changelog: "news", hotkeys: "keyboard", fork: "branch", login: "signIn",
	logout: "signOut", new: "plus", compact: "compress", resume: "history", quit: "power",
};

export type CommandKind = "builtin" | "extension" | "template" | "skill";

export interface CatalogEntry {
	// Invocation name without the slash. Skills keep Pi's `skill:<name>` form.
	name: string;
	kind: CommandKind;
	description: string;
	supported: boolean;
}

export type ArgumentCompletions = Array<{ value: string; label: string; description?: string }> | null | Promise<Array<{ value: string; label: string; description?: string }> | null>;

export interface SourceInfoLike {
	source: string;
	scope: string;
}

export interface CommandInfo {
	name: string;
	description?: string;
	argumentHint?: string;
	sourceInfo?: SourceInfoLike;
}

type ExtensionCommandInfo = {
	name?: string;
	invocationName: string;
	description?: string;
	sourceInfo?: SourceInfoLike;
	getArgumentCompletions?: (prefix: string) => ArgumentCompletions;
};

export interface CommandSource {
	extensionCommands(): ReadonlyArray<ExtensionCommandInfo>;
	promptTemplates(): ReadonlyArray<CommandInfo>;
	skills(): ReadonlyArray<CommandInfo>;
	// Argument completions Pi's interactive mode adds to builtins (model, thinking).
	builtinCompletions?(): Readonly<Record<string, (prefix: string) => ArgumentCompletions>>;
	// Current state is displayed only when the live Pi session supplies it.
	builtinValues?(): Readonly<Record<string, string>>;
	// settingsManager.getEnableSkillCommands(); skills are listed in autocomplete only when enabled.
	skillCommandsEnabled?(): boolean;
}

export const EMPTY_COMMAND_SOURCE: CommandSource = {
	extensionCommands: () => [],
	promptTemplates: () => [],
	skills: () => [],
};

// Structural view of the AgentSession members the catalogue reads (pi-coding-agent 1.0.4).
type ModelLike = { provider: string; id: string; name?: string };

export interface CommandSessionLike {
	readonly model?: ModelLike;
	readonly thinkingLevel?: string;
	readonly extensionRunner: { getRegisteredCommands(): ReadonlyArray<ExtensionCommandInfo> };
	readonly promptTemplates: ReadonlyArray<CommandInfo>;
	readonly resourceLoader: { getSkills(): { skills: ReadonlyArray<CommandInfo> } };
	readonly settingsManager?: { getEnableSkillCommands?(): boolean };
	readonly scopedModels?: ReadonlyArray<{ model: ModelLike }>;
	readonly modelRuntime?: { getAvailableSnapshot(): ReadonlyArray<ModelLike> };
	getAvailableThinkingLevels?(): string[];
}

// Pi's modes/interactive/model-search.js getModelSearchText (not exported from the package root).
function modelSearchText(m: ModelLike): string {
	const name = m.name ? ` ${m.name}` : "";
	return `${m.id} ${m.provider} ${m.provider}/${m.id} ${m.provider} ${m.id}${name}`;
}

// Pi's createFuzzyAutocompleteItems: null when nothing matches.
function fuzzyItems<T>(items: readonly T[], prefix: string, text: (item: T) => string, item: (value: T) => { value: string; label: string; description?: string }) {
	const filtered = fuzzyFilter([...items], prefix, text);
	return filtered.length ? filtered.map(item) : null;
}

export function sessionCommandSource(session: CommandSessionLike): CommandSource {
	return {
		extensionCommands: () => session.extensionRunner.getRegisteredCommands(),
		promptTemplates: () => session.promptTemplates,
		skills: () => session.resourceLoader.getSkills().skills,
		skillCommandsEnabled: () => session.settingsManager?.getEnableSkillCommands?.() ?? true,
		// The same completions InteractiveMode.createBaseAutocompleteProvider attaches to /model and /thinking.
		builtinCompletions: () => ({
			model: (prefix) => {
				const models = session.scopedModels?.length ? session.scopedModels.map((s) => s.model) : session.modelRuntime?.getAvailableSnapshot() ?? [];
				if (!models.length) return null;
				return fuzzyItems(models, prefix, modelSearchText, (m) => ({ value: `${m.provider}/${m.id}`, label: m.id, description: m.provider }));
			},
			thinking: (prefix) => fuzzyItems(session.getAvailableThinkingLevels?.() ?? [], prefix, (l) => l, (l) => ({ value: l, label: l })),
		}),
		builtinValues: () => ({
			...(session.model ? { model: `${session.model.provider}/${session.model.id}` } : {}),
			...(session.thinkingLevel ? { thinking: session.thinkingLevel } : {}),
		}),
	};
}

// InteractiveMode.getAutocompleteSourceTag. Pi parses git sources with hosted-git-info (internal); this
// reads host, path and ref from the same URL forms.
export function sourceTag(info: SourceInfoLike | undefined): string | undefined {
	if (!info || info.source === "builtin") return undefined;
	const scope = info.scope === "user" ? "u" : info.scope === "project" ? "p" : "t";
	const source = info.source.trim();
	if (source === "auto" || source === "local" || source === "cli") return scope;
	if (source.startsWith("npm:")) return `${scope}:${source}`;
	const git = gitSource(source);
	return git ? `${scope}:git:${git}` : scope;
}

function gitSource(source: string): string | undefined {
	const prefixed = source.startsWith("git:");
	const url = prefixed ? source.slice(4).trim() : source;
	if (!prefixed && !/^(https?|ssh|git):\/\//i.test(url)) return undefined;
	const m = /^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^/:]+)[/:]([^/#@]+\/[^/#@]+?)(?:\.git)?(?:[#@](.+))?$/i.exec(url);
	return m ? `${m[1]}/${m[2]}${m[3] ? `@${m[3]}` : ""}` : undefined;
}

function tagged(description: string | undefined, info: SourceInfoLike | undefined): string {
	const tag = sourceTag(info);
	if (!tag) return description ?? "";
	return description ? `[${tag}] ${description}` : `[${tag}]`;
}

// One row of the slash-command autocomplete, in the order and wording of Pi's CombinedAutocompleteProvider:
// builtins, prompt templates, extension commands (minus builtin clashes), then skills when enabled.
export interface SlashCommandItem {
	name: string;
	// Pi's `hint — description` text, with the [u]/[p]/[t] source tag.
	description?: string;
	value?: string;
	icon: string;
	disabled?: boolean;
	complete?: (prefix: string) => ArgumentCompletions;
}

export function autocompleteCommands(source: CommandSource): SlashCommandItem[] {
	const full = (hint: string | undefined, desc: string) => (hint ? (desc ? `${hint} — ${desc}` : hint) : desc) || undefined;
	const builtinComplete = source.builtinCompletions?.() ?? {};
	const builtinValues = source.builtinValues?.() ?? {};
	const builtinNames = new Set(BUILTIN_COMMANDS.map((c) => c.name));
	return [
		...BUILTIN_COMMANDS.map((c): SlashCommandItem => ({
			name: c.name,
			description: full(c.argumentHint, c.description),
			icon: BUILTIN_ICONS[c.name] ?? "action",
			...(builtinValues[c.name] ? { value: builtinValues[c.name] } : {}),
			// OMP's preview doesn't dim builtins. Selecting one here only fills the draft; the route
			// separately refuses terminal-only handlers with an explicit `pi -nt` notice.
			...(builtinComplete[c.name] ? { complete: builtinComplete[c.name] } : {}),
		})),
		...source.promptTemplates().map((t): SlashCommandItem => ({ name: t.name, description: full(t.argumentHint, tagged(t.description, t.sourceInfo)), icon: "prompt" })),
		...source.extensionCommands().filter((c) => !builtinNames.has(c.name ?? c.invocationName)).map((c): SlashCommandItem => ({
			name: c.invocationName,
			description: tagged(c.description, c.sourceInfo) || undefined,
			icon: "extension",
			...(c.getArgumentCompletions ? { complete: (prefix: string) => c.getArgumentCompletions!(prefix) } : {}),
		})),
		...(source.skillCommandsEnabled?.() ?? true
			? source.skills().map((s): SlashCommandItem => ({ name: `skill:${s.name}`, description: tagged(s.description, s.sourceInfo) || undefined, icon: "skill" }))
			: []),
	];
}

export class CommandCatalog {
	readonly entries: readonly CatalogEntry[];
	readonly #byName = new Map<string, CatalogEntry[]>();

	constructor(entries: readonly CatalogEntry[]) {
		this.entries = entries;
		for (const entry of entries) {
			const list = this.#byName.get(entry.name);
			if (list) list.push(entry);
			else this.#byName.set(entry.name, [entry]);
		}
	}

	lookup(name: string): readonly CatalogEntry[] {
		return this.#byName.get(name) ?? [];
	}
}

export function buildCatalog(source: CommandSource): CommandCatalog {
	const entries: CatalogEntry[] = [
		...BUILTIN_COMMANDS.map((c): CatalogEntry => ({ name: c.name, kind: "builtin", description: c.description, supported: TERN_BUILTINS.has(c.name) })),
		...source.promptTemplates().map((t): CatalogEntry => ({ name: t.name, kind: "template", description: t.description ?? "", supported: true })),
		// Pi skips extension commands that shadow a builtin in autocomplete; dispatch still refuses the clash.
		...source.extensionCommands().map((c): CatalogEntry => ({ name: c.invocationName, kind: "extension", description: c.description ?? "", supported: true })),
		...source.skills().map((s): CatalogEntry => ({ name: `skill:${s.name}`, kind: "skill", description: s.description ?? "", supported: true })),
	];
	return new CommandCatalog(entries);
}

export type SlashRoute =
	| { kind: "plain" }
	| { kind: "dispatch"; entry: CatalogEntry; immediate: boolean }
	| { kind: "builtin"; name: string; args: string }
	| { kind: "refuse"; reason: string };

// Extension commands dispatch immediately, even while a turn streams (Pi runs them before its busy check).
// Prompt templates and skills start a model turn, so they wait for an idle session.
export function routeSubmission(text: string, catalog: CommandCatalog, busy: boolean): SlashRoute {
	const trimmed = text.trim();
	if (!trimmed.startsWith("/")) return { kind: "plain" };
	const head = trimmed.split(/\s/, 1)[0];
	const matches = catalog.lookup(head.slice(1));
	if (matches.length === 0) return { kind: "refuse", reason: `unknown command ${head}: not sent to the model` };
	if (matches.length > 1) {
		return { kind: "refuse", reason: `ambiguous command ${head} (${matches.map((m) => m.kind).join(", ")}): not run` };
	}
	const [entry] = matches;
	if (!entry.supported) return { kind: "refuse", reason: `${head} needs Pi's interactive terminal mode and is unavailable in Tern (run \`pi -nt\`)` };
	if (entry.kind === "builtin") return { kind: "builtin", name: entry.name, args: trimmed.slice(head.length).trim() };
	if (entry.kind === "extension") return { kind: "dispatch", entry, immediate: true };
	if (busy) return { kind: "refuse", reason: `busy: ${head} runs when the current turn finishes or is cancelled` };
	return { kind: "dispatch", entry, immediate: false };
}
