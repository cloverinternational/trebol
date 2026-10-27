// Own DECSET 2004 only after the Tern handshake succeeds. Native Pi owns its own modes.
export class PasteMode {
	#active = false;
	readonly #write: (text: string) => void;
	constructor(write: (text: string) => void) { this.#write = write; }
	start(): void {
		if (this.#active) return;
		this.#active = true;
		this.#write("\x1b[?2004h");
	}
	close(): void {
		if (!this.#active) return;
		this.#active = false;
		this.#write("\x1b[?2004l");
	}
}
