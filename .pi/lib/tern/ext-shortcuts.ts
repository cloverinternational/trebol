// Extension keyboard shortcuts (`pi.registerShortcut`) for a Tern pane.
//
// Pi dispatches these from its own terminal UI: it reads the extension runner's
// shortcut map (normalized chord -> handler) and calls the handler with a
// per-press ExtensionContext. A Tern pane owns the terminal, so its keys travel
// through run.ts and never reach that code path; without this module a chord such
// as voice's Ctrl+Space would silently do nothing.
//
// The dispatcher runs before the composer's key map and consumes a chord only
// when an extension registered it, so ordinary typing keeps its meaning and no
// character is both typed and executed.
import { getKeybindings, isKeyRelease, parseKey } from "@earendil-works/pi-tui";

export interface ShortcutHandler {
	readonly handler: (ctx: unknown) => Promise<void> | void;
}

export interface ShortcutSession {
	readonly extensionRunner?: {
		getShortcuts(bindings: unknown): ReadonlyMap<string, ShortcutHandler>;
	};
}

export interface ShortcutContextHost {
	/** The Tern extension UI context (the object Pi binds as `ctx.ui`). */
	ui(): Record<string, unknown>;
	cwd(): string;
	isIdle(): boolean;
	notify?(message: string): void;
}

/**
 * Builds the dispatcher for one session. Returns true when an extension owned the
 * key, so the caller must not also treat it as composer input.
 */
export function createShortcutDispatcher(
	session: ShortcutSession,
	host: ShortcutContextHost,
): (sequence: string) => boolean {
	const bindings = (): unknown => {
		try {
			return getKeybindings().getResolvedBindings();
		} catch {
			// A missing keybinding manager only costs user overrides, not dispatch.
			return {};
		}
	};

	// The map is rebuilt per press: /reload and settings edits replace the runner.
	const shortcutFor = (chord: string): ShortcutHandler | undefined => {
		try {
			return session.extensionRunner?.getShortcuts(bindings())?.get(chord);
		} catch {
			return undefined;
		}
	};

	const context = (): Record<string, unknown> => ({
		ui: host.ui(),
		mode: "tui",
		hasUI: true,
		cwd: host.cwd(),
		isIdle: () => host.isIdle(),
		// Nothing in the Tern surface exposes a per-press cancellation signal; a
		// shortcut handler that needs one must observe its own state instead.
		signal: undefined,
		abort: () => {},
	});

	return (sequence: string): boolean => {
		// A kitty key release parses as the chord of its press: acting on it would run
		// the handler twice, once for the press and once for the release.
		if (!sequence || isKeyRelease(sequence)) return false;
		const chord = parseKey(sequence);
		if (!chord) return false;
		const shortcut = shortcutFor(chord);
		if (!shortcut) return false;
		try {
			// Handlers may be long-running (capture, dialogs). A rejection has to stay
			// inside the handler's own reporting: losing the key loop would strand the pane.
			void Promise.resolve(shortcut.handler(context())).catch((error: unknown) => {
				const message = error instanceof Error ? error.message : String(error);
				host.notify?.(`Shortcut failed: ${message}`);
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			host.notify?.(`Shortcut failed: ${message}`);
		}
		return true;
	};
}
