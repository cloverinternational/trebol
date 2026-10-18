// Maps one complete terminal key sequence (from pi-tui's StdinBuffer) to a draft action.
// Kitty CSI u sequences like ESC[114u must not be read char-by-char: their ESC would look like Escape.
import { decodeKittyPrintable, parseKey } from "@earendil-works/pi-tui";

export type KeyEffect =
	| { kind: "submit" }
	| { kind: "followUp" }
	| { kind: "dequeue" }
	| { kind: "newline" }
	| { kind: "escape" }
	| { kind: "interrupt" }
	| { kind: "paste" }
	| { kind: "backspace" }
	| { kind: "up" }
	| { kind: "down" }
	| { kind: "tab" }
	| { kind: "tabMove"; delta: number }
	| { kind: "cursor"; direction: -1 | 1; word: boolean; extend: boolean }
	| { kind: "selectAll" }
	| { kind: "undo" }
	| { kind: "deleteWord" }
	| { kind: "toggleOutput" }
	| { kind: "text"; text: string };

export function keyEffect(sequence: string): KeyEffect | null {
	const name = parseKey(sequence);
	if (name === "ctrl+c") return { kind: "interrupt" };
	if (name === "ctrl+v") return { kind: "paste" };
	if (name === "escape") return { kind: "escape" };
	if (name === "enter") return { kind: "submit" };
	if (name === "alt+enter") return { kind: "followUp" };
	if (name === "alt+up") return { kind: "dequeue" };
	if (name === "shift+enter") return { kind: "newline" };
	if (name === "backspace") return { kind: "backspace" };
	if (name === "alt+backspace") return { kind: "deleteWord" };
	if (name === "ctrl+a" || name === "super+a") return { kind: "selectAll" };
	if (name === "ctrl+z" || name === "super+z") return { kind: "undo" };
	if (name === "ctrl+o") return { kind: "toggleOutput" };
	if (name === "alt+left") return { kind: "cursor", direction: -1, word: true, extend: false };
	if (name === "alt+right") return { kind: "cursor", direction: 1, word: true, extend: false };
	if (name === "shift+left") return { kind: "cursor", direction: -1, word: false, extend: true };
	if (name === "shift+right") return { kind: "cursor", direction: 1, word: false, extend: true };
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
