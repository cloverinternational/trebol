// Opt-in Pi-in-Tern runner. Probes for a TSP-capable Tern pane; if no hello reply arrives,
// execs the native `pi` CLI unchanged. Otherwise it creates a Pi AgentSessionRuntime (trebol extensions
// load via normal discovery) and drives its current session through PiTernBridge. The runtime's session
// replacements (for example /tern-resume) rebind the bridge and extension UI to the new session.
// Run inside a Tern pane: node --experimental-strip-types .pi/lib/tern/run.ts
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { appendFileSync, existsSync } from "node:fs";
import { uptime } from "node:os";
import { join } from "node:path";
import {
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	createEventBus,
	getAgentDir,
	initTheme,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { getNativeClipboard, StdinBuffer } from "@earendil-works/pi-tui";
import { sessionCommandSource, type CommandSessionLike } from "./commands.ts";
import { PiTernBridge, type PiSessionLike } from "./bridge.ts";
import { createUiTrace } from "./ui-trace.ts";
import { keyEffect } from "./keys.ts";
import { detectTern, helloQuery, PI_TSP_FEATURES, shouldProbe, splitInput } from "./tsp.ts";
import { bootGeneration, clearPaneRecord, openStartupSession, paneKey, pidAlive, readPaneBook, recordPaneSession } from "./startup-session.ts";

const PROBE_MS = 1000;
const stdin = process.stdin;
const stdout = process.stdout;
// Which pane owns which session, so a pane that lost its runner reopens its conversation instead of
// starting over. See .pi/lib/tern/startup-session.ts.
const PANE_BOOK = join(getAgentDir(), "tern-panes.json");
// A reboot is the only restart that reopens a conversation; see .pi/lib/tern/startup-session.ts.
const BOOT = bootGeneration(Date.now(), uptime());

// A machine that went down takes the pane's program with it, and Tern restores the pane (same id) as a
// plain login shell. Reopening that pane's own session is the whole durability story; a pane the user
// closed on purpose starts over, and a live owner is never reopened.
function startupSession(cwd: string): SessionManager {
	return openStartupSession({
		sessionManager: SessionManager,
		cwd,
		fresh: process.env.PI_TERN_FRESH === "1" || process.env.PI_TERN_RESUME === "0",
		key: paneKey(process.env),
		book: readPaneBook(PANE_BOOK),
		selfPid: process.pid,
		exists: (sessionFile) => existsSync(sessionFile),
		alive: pidAlive,
		boot: BOOT,
	});
}

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
		// Bracketed paste off again for whatever runs in the pane next.
		stdout.write("\x1b[?2004l");
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
		if (bridge.applyEditKey(effect)) return;
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
		} else if (effect.kind === "toggleOutput") {
			bridge.toggleToolOutput();
		} else if (effect.kind === "text") bridge.appendDraft(effect.text);
	});
	// Pasted text stays in the draft; embedded newlines do not submit.
	keyBuffer.on("paste", (text: string) => bridge?.pasteText(text));

	const onData = (chunk: Buffer): void => {
		const text = chunk.toString("utf8");
		// Opt-in raw input log (keys and TSP events as they arrive), for diagnosing platform input differences.
		if (process.env.PI_TERN_INPUT_LOG) {
			try {
				appendFileSync(process.env.PI_TERN_INPUT_LOG, `${JSON.stringify({ at: Date.now(), data: text })}\n`);
			} catch {
				// Diagnostics only.
			}
		}
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

	const uiTrace = process.env.PI_TERN_UI_TRACE === "0" ? undefined : createUiTrace(join(getAgentDir(), "tern-trace"));
	const connect = async (credits: number, apc: number, kinds: string[]): Promise<void> => {
		// One bus shared by extensions (ask-user's remote-ask runtime) and the bridge's ask dialog.
		const events = createEventBus();
		const cwd = process.cwd();
		const runtime = await createAgentSessionRuntime(createRuntime(events), {
			cwd,
			agentDir: getAgentDir(),
			sessionManager: startupSession(cwd),
		});
		// Pi writes a session file at the first message, not at startup, so the pane record is written
		// from the events and after every session replacement rather than here. Only a changed file is
		// recorded, so a long turn does not rewrite the book per event.
		// `null` records "this pane has no persisted session": after /new the old record must go, or a
		// later reboot would reopen the conversation the user just left.
		let recordedFile: string | null | undefined;
		const rememberSession = (session: typeof runtime.session): void => {
			const key = paneKey(process.env);
			if (!key) return;
			const file = session.sessionManager?.getSessionFile?.() ?? null;
			if (file === recordedFile) return;
			recordedFile = file;
			try {
				if (file) recordPaneSession(PANE_BOOK, key, { sessionFile: file, pid: process.pid, cwd, updatedAt: Date.now(), boot: BOOT });
				else clearPaneRecord(PANE_BOOK, key);
			} catch {
				// A record failure must never affect the session; the pane only loses its resume point.
			}
		};
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
			// Records the raw Pi event stream (one {at, event} JSON line each) for replay tests; off unless set.
			// Dogfooding UI trace (on unless PI_TERN_UI_TRACE=0): event types and per-render rows in ~/.pi/agent/tern-trace/.
			// Full event payloads for replay fixtures are recorded only when PI_TERN_EVENT_LOG is set.
			onEvent: (event) => {
				uiTrace?.event(event);
				rememberSession(runtime.session);
				if (!process.env.PI_TERN_EVENT_LOG) return;
				try {
					appendFileSync(process.env.PI_TERN_EVENT_LOG, `${JSON.stringify({ at: Date.now(), sessionFile: runtime.session.sessionManager?.getSessionFile?.(), event })}\n`);
				} catch {
					// A recorder failure must never affect the session.
				}
			},
			onRender: (nodes, trigger, busy) => uiTrace?.render(nodes, trigger, busy),
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
			// /new goes through Pi's runtime so the session is replaced, persisted and rebound as in Pi's own UI.
			newSession: async () => runtime.newSession(),
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
			rememberSession(next);
			await bindSession(next);
		});
		await bindSession(runtime.session);
		rememberSession(runtime.session);
		stdout.write("\r\n[tern: enter sends; esc cancels or clears; double esc on an empty draft opens the configured session action; ctrl-c closes]\r\n");
	};

	// Windows: a ConPTY console delivers keys as VT sequences (modified keys, kitty input, and Tern's OSC 877
	// messages) only with ENABLE_VIRTUAL_TERMINAL_INPUT, which Pi's own ProcessTerminal sets the same way. On
	// win32 pi-tui's native clipboard object is that platform helper.
	if (process.platform === "win32") {
		try {
			(getNativeClipboard() as { enableVirtualTerminalInput?: () => boolean } | undefined)?.enableVirtualTerminalInput?.();
		} catch {
			// No native helper: Shift+Tab and other modified keys may arrive unmodified.
		}
	}
	stdin.setRawMode(true);
	stdin.resume();
	stdin.on("data", onData);
	// Bracketed paste: a paste or a file drop arrives whole (StdinBuffer's `paste`), so its newlines never submit
	// and dropped paths can become attachments. Without it Tern types the text in character by character.
	stdout.write("\x1b[?2004h");
	stdout.write(helloQuery("pi", [...PI_TSP_FEATURES]));
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
