import { describe, expect, it } from "vitest";
import { createShortcutDispatcher, type ShortcutHandler } from "../../lib/tern/ext-shortcuts.ts";

const CTRL_SPACE = "\x00";
const CTRL_SPACE_RELEASE = "\x1b[32;5:3u";

// Resolved per read, like a live runner whose extensions were reloaded.
function sessionOf(entries: () => Record<string, ShortcutHandler>, onRead?: () => void) {
	return {
		extensionRunner: {
			getShortcuts: () => {
				onRead?.();
				return new Map(Object.entries(entries()));
			},
		},
	};
}

function hostOf(notices: string[] = []) {
	return {
		ui: () => ({ widget: true }),
		cwd: () => "/work/repo",
		isIdle: () => true,
		notify: (message: string) => notices.push(message),
	};
}

describe("Tern extension shortcut dispatch", () => {
	it("runs the handler registered for the pressed chord and consumes the key", () => {
		const seen: unknown[] = [];
		const dispatch = createShortcutDispatcher(
			sessionOf(() => ({ "ctrl+space": { handler: (ctx) => void seen.push(ctx) } })),
			hostOf(),
		);
		expect(dispatch(CTRL_SPACE)).toBe(true);
		expect(seen).toHaveLength(1);
		// The handler sees the Tern surface: its ui context, tui mode, and the location.
		expect(seen[0]).toMatchObject({ mode: "tui", hasUI: true, cwd: "/work/repo", ui: { widget: true } });
	});

	it("leaves keys no extension registered to the composer", () => {
		const dispatch = createShortcutDispatcher(sessionOf(() => ({ "ctrl+space": { handler: () => {} } })), hostOf());
		// Typing must never be swallowed, and a chord nobody owns stays unhandled.
		expect(dispatch("a")).toBe(false);
		expect(dispatch("\x07")).toBe(false);
	});

	it("ignores a kitty key release so one press does not run the handler twice", () => {
		let runs = 0;
		const dispatch = createShortcutDispatcher(
			sessionOf(() => ({ "ctrl+space": { handler: () => void (runs += 1) } })),
			hostOf(),
		);
		expect(dispatch(CTRL_SPACE_RELEASE)).toBe(false);
		expect(runs).toBe(0);
	});

	it("reads the shortcut map on every press, so a reload takes effect", () => {
		let runs = 0;
		let registered = false;
		let reads = 0;
		const dispatch = createShortcutDispatcher(
			sessionOf(() => (registered ? { "ctrl+space": { handler: () => void (runs += 1) } } : {}), () => void (reads += 1)),
			hostOf(),
		);
		expect(dispatch(CTRL_SPACE)).toBe(false);
		registered = true;
		expect(dispatch(CTRL_SPACE)).toBe(true);
		expect(runs).toBe(1);
		expect(reads).toBe(2);
	});

	it("keeps the key loop alive when a handler throws or rejects", async () => {
		const notices: string[] = [];
		const dispatch = createShortcutDispatcher(
			sessionOf(() => ({
				"ctrl+space": {
					handler: () => {
						throw new Error("capture failed");
					},
				},
			})),
			hostOf(notices),
		);
		expect(() => dispatch(CTRL_SPACE)).not.toThrow();
		expect(notices).toEqual(["Shortcut failed: capture failed"]);

		const rejecting = createShortcutDispatcher(
			sessionOf(() => ({ "ctrl+space": { handler: async () => Promise.reject(new Error("no microphone")) } })),
			hostOf(notices),
		);
		expect(rejecting(CTRL_SPACE)).toBe(true);
		await new Promise((r) => setTimeout(r, 0));
		expect(notices).toContain("Shortcut failed: no microphone");
	});

	it("reports nothing registered when the session has no extension runner", () => {
		const notices: string[] = [];
		const dispatch = createShortcutDispatcher({}, hostOf(notices));
		expect(dispatch(CTRL_SPACE)).toBe(false);
		expect(notices).toEqual([]);
	});
});
