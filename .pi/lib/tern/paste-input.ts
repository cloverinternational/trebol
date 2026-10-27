// Separate paste payloads before TSP/key parsing. OMP-style chunk accumulation:
// scan only new input plus a delimiter-sized tail, join once at completion.
const OPEN = "\x1b[200~";
const END = "\x1b[201~";
const APC = "\x1b_tsp;";
const ST = "\x1b\\";
export class PasteInput {
	#timer: ReturnType<typeof setTimeout> | undefined;
	#bytes = 0;
	#recovering = false;
	#disposed = false;
	readonly #options: {timeoutMs?: number; maxBytes?: number; onRecovery?: (reason: string) => void};
	#pending = "";
	#chunks: string[] | undefined;
	readonly #keys: (text: string) => void;
	readonly #paste: (text: string) => void;
	constructor(keys: (text: string) => void, paste: (text: string) => void, options: {timeoutMs?: number; maxBytes?: number; onRecovery?: (reason: string) => void} = {}) {
		this.#keys = keys; this.#paste = paste;
		this.#options = options;
	}
	get recovering(): boolean { return this.#recovering; }
	get bufferedBytes(): number { return this.#bytes; }
	resume(): void { if (!this.#disposed) this.#recovering = false; }
	cancel(reason = "cancelled"): void { this.#abort(reason, false); }
	end(): void { if (this.#chunks) this.#abort("EOF", true); this.dispose(); }
	dispose(): void { clearTimeout(this.#timer); this.#chunks=undefined; this.#pending=""; this.#bytes=0; this.#disposed=true; }
	#abort(reason: string, preserve: boolean): void {
		clearTimeout(this.#timer);
		const text = preserve && this.#chunks ? this.#chunks.join("")+this.#pending : "";
		this.#chunks=undefined; this.#pending=""; this.#bytes=0; this.#recovering=true;
		if (text) this.#paste(text);
		this.#options.onRecovery?.(reason);
	}
	process(text: string): void {
		if (this.#disposed || this.#recovering || !text) return;
		clearTimeout(this.#timer);
		let input = this.#pending + text;
		this.#pending = "";
		while (input) {
			if (this.#chunks) {
				const end = input.indexOf(END);
				const body = end < 0 ? input : input.slice(0,end);
				if (this.#bytes + Buffer.byteLength(body, "utf8") > (this.#options.maxBytes ?? 8 * 1024 * 1024)) {
					this.#abort("byte limit exceeded: entire paste rejected", false); return;
				}
				if (end < 0) {
					const keep = Math.min(END.length - 1, input.length);
					const part = input.slice(0, input.length - keep);
					this.#chunks.push(part);
					this.#bytes += Buffer.byteLength(part, "utf8");
					this.#pending = input.slice(input.length - keep);
					clearTimeout(this.#timer);
					this.#timer = setTimeout(() => this.#abort("inactivity timeout: partial paste preserved", true), this.#options.timeoutMs ?? 2000);
					return;
				}
				this.#chunks.push(input.slice(0, end));
				clearTimeout(this.#timer);
				const payload = this.#chunks.join("");
				this.#chunks = undefined;
				this.#bytes = 0;
				this.#paste(payload);
				input = input.slice(end + END.length);
				continue;
			}
			const esc = input.indexOf("\x1b");
			if (esc < 0) { this.#keys(input); return; }
			if (esc > 0) this.#keys(input.slice(0, esc));
			input = input.slice(esc);
			if (input.startsWith(OPEN)) {
				this.#chunks = []; this.#bytes=0;
				this.#timer = setTimeout(() => this.#abort("inactivity timeout: partial paste preserved", true), this.#options.timeoutMs ?? 2000);
				input = input.slice(OPEN.length); continue;
			}
			if (input.startsWith(APC)) {
				const end = input.indexOf(ST, APC.length);
				if (end < 0) { this.#pending = input; return; }
				this.#keys(input.slice(0, end + ST.length));
				input = input.slice(end + ST.length); continue;
			}
			if (OPEN.startsWith(input) || APC.startsWith(input)) { this.#pending = input; return; }
			this.#keys(input[0]); input = input.slice(1);
		}
	}
	// Idle Escape is a key. Never flush incomplete paste/protocol as executable keys.
	flushEscape(): void {
		if (!this.#chunks && this.#pending === "\x1b") {
			this.#pending = ""; this.#keys("\x1b");
		}
	}
}
