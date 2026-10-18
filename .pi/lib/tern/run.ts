// Opt-in Pi-in-Tern runner. Probes for a TSP-capable Tern pane; if no hello reply arrives,
// execs the native `pi` CLI unchanged. Otherwise it creates a Pi AgentSessionRuntime (trebol extensions
// load via normal discovery) and drives its current session through PiTernBridge. The runtime's session
// replacements (for example /tern-resume) rebind the bridge and extension UI to the new session.
// Run inside a Tern pane: node --experimental-strip-types .pi/lib/tern/run.ts
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import {
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	createEventBus,
	getAgentDir,
	initTheme,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { StdinBuffer } from "@earendil-works/pi-tui";
import { sessionCommandSource, type CommandSessionLike } from "./commands.ts";
import { PiTernBridge, type PiSessionLike } from "./bridge.ts";
import { keyEffect } from "./keys.ts";
import { detectTern, helloQuery, shouldProbe, splitInput } from "./tsp.ts";

const PROBE_MS = 1000;
const stdin = process.stdin;
const stdout = process.stdout;

function runNativePi(reason: string): void {
	process.stderr.write(`[tern: ${reason}; starting native pi]\n`);
	const child = spawn("pi", process.argv.slice(2), { stdio: "inherit" });
	child.on("exit", (code) => process.exit(code ?? 0));
}

if (!shouldProbe(process.env) || !stdin.isTTY) {
	runNativePi(stdin.isTTY ? "probe disabled or multiplexer" : "stdin is not a tty");
} else {
	startTsp();
}

function startTsp(): void {
	let raw = "";
	let pending = "";
	let pendingTimer: ReturnType<typeof setTimeout> | undefined;
	const ESC_FLUSH_MS = 50;
	let bridge: PiTernBridge | null = null;
	let restored = false;
	let connecting = false;
	let probeTimer: NodeJS.Timeout | undefined;
	let lastCtrlC = 0;

	const restore = (): void => {
		if (restored) return;
		restored = true;
		bridge?.close();
		stdin.setRawMode(false);
		stdin.pause();
	};
	process.on("exit", restore);
	for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
		process.on(sig, () => {
			restore();
			process.exit(128);
		});
	}

	// StdinBuffer yields whole key sequences (kitty CSI u, bracketed paste) instead of raw chars.
	// The bridge owns the draft; keys only edit it through the bridge.
	const keyBuffer = new StdinBuffer();
	keyBuffer.on("data", (sequence: string) => {
		const effect = keyEffect(sequence);
		if (!bridge || !effect) return;
		if (effect.kind === "interrupt") {
			const now = Date.now();
			if (now - lastCtrlC < 500) {
				bridge.close();
				process.exit(0);
			} else bridge.clearDraft();
			lastCtrlC = now;
		} else if (effect.kind === "paste") {
			void bridge.pasteClipboard();
		} else if (effect.kind === "escape") {
			if (bridge.escape()) process.exit(0);
		} else if (effect.kind === "submit") {
			void bridge.submitDraft();
		} else if (effect.kind === "followUp") {
			void bridge.submitFollowUp(bridge.expandedDraft);
		} else if (effect.kind === "dequeue") {
			bridge.restoreQueuedMessages();
		} else if (effect.kind === "newline") {
			bridge.newline();
		} else if (effect.kind === "backspace") {
			bridge.backspaceDraft();
		} else if (effect.kind === "up") {
			bridge.movePicker(-1);
		} else if (effect.kind === "down") {
			bridge.movePicker(1);
		} else if (effect.kind === "tab") {
			void bridge.tab();
		} else if (effect.kind === "tabMove") {
			bridge.moveTabOrCursor(effect.delta);
		} else if (effect.kind === "cursor") {
			bridge.moveCursor(effect.direction, effect.word, effect.extend);
		} else if (effect.kind === "selectAll") {
			bridge.selectAllDraft();
		} else if (effect.kind === "undo") {
			bridge.undoDraft();
		} else if (effect.kind === "deleteWord") {
			bridge.deleteWordDraft();
		} else if (effect.kind === "toggleOutput") {
			bridge.toggleToolOutput();
		} else bridge.appendDraft(effect.text);
	});
	// Pasted text stays in the draft; embedded newlines do not submit.
	keyBuffer.on("paste", (text: string) => bridge?.pasteText(text));

	const onData = (chunk: Buffer): void => {
		const text = chunk.toString("utf8");
		if (!bridge) {
			if (connecting || restored) return;
			raw += text;
			const capabilities = detectTern(raw);
			if (capabilities) {
				connecting = true;
				clearTimeout(probeTimer);
				void connect(capabilities.credits, capabilities.apc, capabilities.kinds).catch((error: unknown) => {
					process.stderr.write(`[tern: failed to start Pi session: ${error instanceof Error ? error.message : String(error)}]\n`);
					restore();
					process.exitCode = 1;
				});
			} else if (/\x1b\[\?[\d;]*c/.test(raw)) {
				restore();
				runNativePi("DA1 without TSP hello");
			}
			return;
		}
		const parsed = splitInput(pending + text);
		pending = parsed.rest;
		for (const msg of parsed.messages) bridge.handle(msg);
		keyBuffer.process(parsed.keys);
		// A lone ESC is held as a possible APC prefix; with no continuation it is the Escape key.
		clearTimeout(pendingTimer);
		if (pending && pending.length < 6)
			pendingTimer = setTimeout(() => {
				const held = pending;
				pending = "";
				keyBuffer.process(held);
			}, ESC_FLUSH_MS);
	};

	const connect = async (credits: number, apc: number, kinds: string[]): Promise<void> => {
		// One bus shared by extensions (ask-user's remote-ask runtime) and the bridge's ask dialog.
		const events = createEventBus();
		const cwd = process.cwd();
		const runtime = await createAgentSessionRuntime(createRuntime(events), {
			cwd,
			agentDir: getAgentDir(),
			sessionManager: SessionManager.create(cwd),
		});
		// Extension component factories receive Pi's theme proxy, which needs an initialised theme.
		try {
			initTheme(runtime.session.settingsManager.getTheme());
		} catch {
			initTheme();
		}
		const theme = (runtime.session.extensionRunner.getUIContext() as { theme?: unknown }).theme;
		// The command source reads the runtime's current session, so it follows replacements too.
		const commandSession = new Proxy({}, { get: (_target, key) => Reflect.get(runtime.session, key) }) as CommandSessionLike;
		bridge = new PiTernBridge(runtime.session as unknown as PiSessionLike, {
			theme,
			write: (d) => stdout.write(d),
			surfaceId: "pi",
			credits,
			apc,
			kinds,
			onClose: restore,
			commands: sessionCommandSource(commandSession),
			events,
			reload: async () => {
			// Read and syntax-check the new CSS before mutating Pi's live loadout.
			// TSP's named sheet replacement keeps its original cascade position.
			const source = await readFile(new URL("./composer-style.ts", import.meta.url), "utf8");
			const css = source.match(/export const PI_COMPOSER_CSS = `([\s\S]*?)`;/)?.[1];
			if (!css || css.includes("${")) throw new Error("surface stylesheet could not be loaded safely");
			await runtime.session.reload();
				let pluginStatus = "Tern plugin reload unavailable; linked plugins may still auto-reload on save.";
				try {
					await promisify(execFile)("tern", ["plugin", "reload"], { timeout: 60_000 });
					pluginStatus = "Tern daemon plugins reloaded.";
				} catch (error) {
					const reason = error instanceof Error ? error.message.split("\n")[0] : String(error);
					pluginStatus = `Tern daemon plugin reload did not succeed (${reason.slice(0, 160)}); inspect Tern plugins separately.`;
				}
				return { css, pluginStatus };
		},
		});
		bridge.start("pi");
		// Command-context actions route to the runtime, which performs the real session replacement.
		const commandContextActions = {
			waitForIdle: () => runtime.session.waitForIdle(),
			newSession: (options?: Parameters<typeof runtime.newSession>[0]) => runtime.newSession(options),
			fork: (entryId: string, options?: Parameters<typeof runtime.fork>[1]) => runtime.fork(entryId, options),
			navigateTree: (targetId: string, options?: Parameters<typeof runtime.session.navigateTree>[1]) => runtime.session.navigateTree(targetId, options),
			switchSession: (sessionPath: string, options?: Parameters<typeof runtime.switchSession>[1]) => runtime.switchSession(sessionPath, options),
			reload: () => runtime.session.reload(),
		};
		// Bound after the surface opens, so session_start notices can render. Prompts are answered by
		// the user in native Tern dialogs; nothing resolves on their behalf.
		const bindSession = (next: typeof runtime.session) =>
			next.bindExtensions({ mode: "tui", uiContext: bridge!.uiContext() as never, commandContextActions: commandContextActions as never });
		runtime.setRebindSession(async (next) => {
			bridge?.rebind(next as unknown as PiSessionLike);
			await bindSession(next);
		});
		await bindSession(runtime.session);
		stdout.write("\r\n[tern: enter sends; esc cancels or clears; double esc on an empty draft opens the configured session action; ctrl-c closes]\r\n");
	};

	stdin.setRawMode(true);
	stdin.resume();
	stdin.on("data", onData);
	// Advertises no edit/undo/send features: this bridge does not apply those events.
	stdout.write(helloQuery("pi"));
	probeTimer = setTimeout(() => {
		if (!bridge && !connecting) {
			restore();
			runNativePi("no hello reply within 1s");
		}
	}, PROBE_MS);
}

// Builds services with Tern's event bus and the session for each runtime replacement, mirroring Pi's main.js.
function createRuntime(events: ReturnType<typeof createEventBus>) {
	return async ({ cwd, agentDir, sessionManager, sessionStartEvent }: { cwd: string; agentDir: string; sessionManager: SessionManager; sessionStartEvent?: unknown }) => {
		const services = await createAgentSessionServices({ cwd, agentDir, resourceLoaderOptions: { eventBus: events } });
		const created = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent: sessionStartEvent as never });
		return { ...created, services, diagnostics: services.diagnostics };
	};
}
