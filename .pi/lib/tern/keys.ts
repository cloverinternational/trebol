// Maps one complete terminal key sequence (from pi-tui's StdinBuffer) to a draft action.
// Kitty CSI u sequences like ESC[114u must not be read char-by-char: their ESC would look like Escape.
//
// Bindings follow pi-tui's editor defaults (tui.editor.*) and Tern's PC-keyboard rule: on Linux and Windows
// Ctrl stands for ⌘, and with native editing Tern keeps the selecting chords, ⌘A/Ctrl+A and the drawn-line moves
// itself; without a selection Ctrl+Home/End and Ctrl+Backspace/Delete stay ours (protocol/input.md, Native
// editing). Every chord is still mapped here, because the user can turn native editing off and a plain terminal
// sends them all as keys. Ctrl+A selects all (Tern's PC meaning) rather than pi-tui's line start.
import { decodeKittyPrintable, isKeyRelease, parseKey } from "@earendil-works/pi-tui";

export type KeyEffect =
	| { kind: "submit" }
	| { kind: "followUp" }
	| { kind: "dequeue" }
	| { kind: "newline" }
	| { kind: "escape" }
	| { kind: "interrupt" }
	| { kind: "paste" }
	| { kind: "backspace" }
	| { kind: "deleteForward"; word: boolean }
	| { kind: "deleteToEdge"; direction: -1 | 1 }
	| { kind: "up" }
	| { kind: "down" }
	| { kind: "tab" }
	| { kind: "tabMove"; delta: number }
	| { kind: "cursor"; direction: -1 | 1; word: boolean; extend: boolean; line?: boolean }
	| { kind: "selectAll" }
	| { kind: "undo" }
	| { kind: "deleteWord" }
	| { kind: "toggleOutput" }
	| { kind: "text"; text: string };

// Sequences parseKey leaves unnamed or names by their legacy byte: VT220 Home/End (Linux console, tmux, some
// Windows hosts), and BS (0x08), which Tern sends for Ctrl+Backspace (Backspace is DEL, 0x7f), as Windows
// Terminal and VTE do. Observed with PI_TERN_INPUT_LOG in a live Tern pane.
const RAW_NAMES: Record<string, string> = { "\x1b[1~": "home", "\x1b[4~": "end", "\x08": "ctrl+backspace" };

const cursor = (direction: -1 | 1, opts: { word?: boolean; extend?: boolean; line?: boolean } = {}): KeyEffect =>
	({ kind: "cursor", direction, word: opts.word ?? false, extend: opts.extend ?? false, ...(opts.line ? { line: true } : {}) });

// Chord name → effect for every caret and delete key, whichever platform's convention sent it.
const EDIT_KEYS: Record<string, KeyEffect> = {
	// Word moves: Alt (macOS, readline alt+b/f arrive as alt+left/right) and Ctrl (Linux, Windows).
	"alt+left": cursor(-1, { word: true }),
	"alt+right": cursor(1, { word: true }),
	"ctrl+left": cursor(-1, { word: true }),
	"ctrl+right": cursor(1, { word: true }),
	"shift+left": cursor(-1, { extend: true }),
	"shift+right": cursor(1, { extend: true }),
	"shift+alt+left": cursor(-1, { word: true, extend: true }),
	"shift+alt+right": cursor(1, { word: true, extend: true }),
	"shift+ctrl+left": cursor(-1, { word: true, extend: true }),
	"shift+ctrl+right": cursor(1, { word: true, extend: true }),
	// Line start/end: Home/End, ⌘←/→, Ctrl+Home/End (text start/end; the draft is one line), Ctrl+E.
	home: cursor(-1, { line: true }),
	end: cursor(1, { line: true }),
	"super+left": cursor(-1, { line: true }),
	"super+right": cursor(1, { line: true }),
	"ctrl+home": cursor(-1, { line: true }),
	"ctrl+end": cursor(1, { line: true }),
	"ctrl+e": cursor(1, { line: true }),
	"shift+home": cursor(-1, { line: true, extend: true }),
	"shift+end": cursor(1, { line: true, extend: true }),
	"shift+super+left": cursor(-1, { line: true, extend: true }),
	"shift+super+right": cursor(1, { line: true, extend: true }),
	"shift+ctrl+home": cursor(-1, { line: true, extend: true }),
	"shift+ctrl+end": cursor(1, { line: true, extend: true }),
	// Deletes: word backward (Alt/Ctrl+Backspace, Ctrl+W), forward (Delete; Ctrl/Alt+Delete, Alt+D by word),
	// and to the line's edges (Ctrl+U, ⌘⌫; Ctrl+K).
	"alt+backspace": { kind: "deleteWord" },
	"ctrl+backspace": { kind: "deleteWord" },
	"ctrl+w": { kind: "deleteWord" },
	delete: { kind: "deleteForward", word: false },
	"ctrl+delete": { kind: "deleteForward", word: true },
	"alt+delete": { kind: "deleteForward", word: true },
	"alt+d": { kind: "deleteForward", word: true },
	"ctrl+u": { kind: "deleteToEdge", direction: -1 },
	"super+backspace": { kind: "deleteToEdge", direction: -1 },
	"ctrl+k": { kind: "deleteToEdge", direction: 1 },
};

export function keyEffect(sequence: string): KeyEffect | null {
	// A kitty key release (event type 3) parses as the same chord as its press: acting on it would type every
	// letter twice and make one Ctrl+C a double press (quit).
	if (isKeyRelease(sequence)) return null;
	const name = RAW_NAMES[sequence] ?? parseKey(sequence);
	if (name === "ctrl+c") return { kind: "interrupt" };
	if (name === "ctrl+v") return { kind: "paste" };
	if (name === "escape") return { kind: "escape" };
	if (name === "enter") return { kind: "submit" };
	if (name === "alt+enter") return { kind: "followUp" };
	if (name === "alt+up") return { kind: "dequeue" };
	if (name === "shift+enter") return { kind: "newline" };
	if (name === "backspace") return { kind: "backspace" };
	if (name === "ctrl+a" || name === "super+a") return { kind: "selectAll" };
	if (name === "ctrl+z" || name === "super+z") return { kind: "undo" };
	if (name === "ctrl+o") return { kind: "toggleOutput" };
	if (name && EDIT_KEYS[name]) return EDIT_KEYS[name]!;
	if (name === "up") return { kind: "up" };
	if (name === "down") return { kind: "down" };
	if (name === "left" || name === "shift+tab") return { kind: "tabMove", delta: -1 };
	if (name === "right") return { kind: "tabMove", delta: 1 };
	if (name === "tab") return { kind: "tab" };
	const printable = decodeKittyPrintable(sequence);
	if (printable !== undefined) return printable ? { kind: "text", text: printable } : null;
	// Plain (legacy) text arrives as its own character(s); escape sequences start with ESC and are ignored.
	if (!sequence.startsWith("\x1b") && sequence >= " ") return { kind: "text", text: sequence };
	return null;
}
