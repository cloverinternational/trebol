// Minimal Tern Surface Protocol (TSP) v1 adapter: wire encoding, handshake
// detection, a single inline surface with credit-based flow control, and a
// pure projection from transcript messages to TSP nodes. Written from the
// captured docs in docs/reference/tern-site/protocol/. Not wired into Pi.

export const ESC = "\x1b";
export const ST = "\x1b\\";
export const PROTOCOL_VERSION = 1;
export const APC_LIMIT = 65536;
const DEFAULT_CREDITS = 2;

export interface TspNode {
	id: string;
	k: string;
	p?: Record<string, unknown>;
	c?: TspNode[];
}

export interface TspMessage {
	verb: string;
	body: Record<string, unknown>;
}

export interface TernCapabilities {
	term: string;
	ver: string;
	kinds: string[];
	features: string[];
	apc: number;
	credits: number;
}

export type TspWriter = (data: string) => void;

export function encodeTsp(verb: string, body: unknown): string {
	const json = JSON.stringify(body);
	const bytes = new TextEncoder().encode(json).length;
	if (bytes > APC_LIMIT) {
		throw new RangeError(`TSP ${verb} body is ${bytes} bytes; chunking is not implemented (limit ${APC_LIMIT})`);
	}
	return `${ESC}_tsp;${verb};${json}${ST}`;
}

let chunkCounter = 0;

// Splits an oversized body into chunk messages (`c=<id>`, `m=1` on all but the last).
// Splits only where the next byte cannot begin a parameter-shaped segment, per transport.md.
export function encodeTspChunks(verb: string, body: unknown, limit: number = APC_LIMIT): string[] {
	const json = JSON.stringify(body);
	if (utf8Length(json) <= limit) return [encodeTsp(verb, body)];
	const id = `k${++chunkCounter}`;
	const pieces = splitJson(json, limit);
	return pieces.map((piece, i) => {
		const more = i < pieces.length - 1 ? "m=1;" : "";
		return `${ESC}_tsp;${verb};c=${id};${more}${piece}${ST}`;
	});
}

// `b` carries a base64 blob (transport.md#blobs). Base64 contains no `;`, so any split is chunk-safe.
export function encodeTspBlob(id: string, mime: string, base64: string, limit: number = APC_LIMIT): string[] {
  const meta = `id=${id};mime=${mime};`;
  const room = Math.max(1, limit - 256);
  if (base64.length <= room) return [`${ESC}_tsp;b;${meta}${base64}${ST}`];
  const cid = `k${++chunkCounter}`;
  const pieces: string[] = [];
  for (let at = 0; at < base64.length; at += room) pieces.push(base64.slice(at, at + room));
  return pieces.map((piece, i) => {
    const more = i < pieces.length - 1 ? "m=1;" : "";
    const head = i === 0 ? meta : "";
    return `${ESC}_tsp;b;c=${cid};${more}${head}${piece}${ST}`;
  });
}

function utf8Length(s: string): number {
	return new TextEncoder().encode(s).length;
}

// A chunk body must not begin with a parameter-shaped segment (`name=value;`), since the
// terminal would parse it as a parameter and drop it. See transport.md#chunking.
function isSafeSplit(json: string, at: number): boolean {
	if (at >= json.length) return true;
	const code = json.charCodeAt(at);
	if (code >= 0xdc00 && code <= 0xdfff) return false;
	const semi = json.indexOf(";", at);
	const segment = semi < 0 ? json.slice(at) : json.slice(at, semi);
	return !/^[A-Za-z0-9_-]+=/.test(segment);
}

function splitJson(json: string, limit: number): string[] {
	const out: string[] = [];
	let start = 0;
	while (start < json.length) {
		let end = start;
		let bytes = 0;
		while (end < json.length) {
			const cp = json.codePointAt(end) as number;
			const ch = String.fromCodePoint(cp);
			const size = utf8Length(ch);
			if (bytes + size > limit) break;
			bytes += size;
			end += ch.length;
		}
		if (end < json.length) {
			let e = end;
			while (e > start && !isSafeSplit(json, e)) e -= 1;
			if (e === start) throw new RangeError(`TSP body has no safe chunk boundary within ${limit} bytes`);
			end = e;
		}
		out.push(json.slice(start, end));
		start = end;
	}
	return out;
}

// Separates complete TSP messages from key input in a raw read buffer.
// An unterminated APC string or a partial ESC prefix is held back as `rest`.
export function splitInput(buffer: string): { messages: TspMessage[]; keys: string; rest: string } {
	const messages: TspMessage[] = [];
	let keys = "";
	let i = 0;
	const APC_START = `${ESC}_tsp;`;
	while (i < buffer.length) {
		const start = buffer.indexOf(APC_START, i);
		const plainEnd = start < 0 ? buffer.length : start;
		keys += buffer.slice(i, plainEnd);
		if (start < 0) break;
		const end = buffer.indexOf(ST, start + APC_START.length);
		if (end < 0) return { messages, keys, rest: buffer.slice(start) };
		messages.push(...parseTspMessages(buffer.slice(start, end + ST.length)));
		i = end + ST.length;
	}
	let rest = "";
	const lastEsc = keys.lastIndexOf(ESC);
	if (lastEsc >= 0 && APC_START.startsWith(keys.slice(lastEsc)) && keys.length - lastEsc < APC_START.length) {
		rest = keys.slice(lastEsc);
		keys = keys.slice(0, lastEsc);
	}
	return { messages, keys, rest };
}

// Hello query followed by DA1; a terminal that speaks TSP answers before DA1.
export function helloQuery(app: string, features: string[] = []): string {
	return `${encodeTsp("q", { q: "hello", v: [PROTOCOL_VERSION], app, features })}${ESC}[c`;
}

const APC_RE = /\x1b_tsp;([A-Za-z]);([\s\S]*?)\x1b\\/g;
const DA1_RE = /\x1b\[\?[\d;]*c/;

export function parseTspMessages(input: string): TspMessage[] {
	const out: TspMessage[] = [];
	for (const match of input.matchAll(APC_RE)) {
		try {
			const body: unknown = JSON.parse(match[2]);
			if (isRecord(body)) out.push({ verb: match[1], body });
		} catch {
			// Malformed bodies are ignored, as Tern would report them as error events.
		}
	}
	return out;
}

// Returns capabilities only when a v1 hello reply precedes a DA1 answer.
// A DA1 answer with no preceding hello means no TSP: the caller keeps its own renderer.
export function detectTern(input: string): TernCapabilities | null {
	const da1 = DA1_RE.exec(input);
	if (!da1) return null;
	const before = input.slice(0, da1.index);
	const hello = parseTspMessages(before).find((m) => m.verb === "r" && m.body.r === "hello");
	if (!hello) return null;
	const b = hello.body;
	// The reply's `v` is the single version Tern picked from our list.
	if (b.v !== PROTOCOL_VERSION) return null;
	return {
		term: typeof b.term === "string" ? b.term : "",
		ver: typeof b.ver === "string" ? b.ver : "",
		kinds: stringArray(b.kinds),
		features: stringArray(b.features),
		apc: typeof b.apc === "number" ? b.apc : APC_LIMIT,
		credits: typeof b.credits === "number" && b.credits > 0 ? b.credits : DEFAULT_CREDITS,
	};
}

// Multiplexers swallow APC strings and Tern disables TSP on request; do not probe then.
export function shouldProbe(env: Record<string, string | undefined>): boolean {
	if (env.TERN_TSP === "0") return false;
	return !env.TMUX && !env.STY && !env.ZELLIJ;
}

// Keyed diff between the last applied children and the next children. Matching is by id and kind
// over a shared prefix; growing text becomes a `text append`, other prop changes a `set`, and the
// remaining tail is deleted and re-added in order. Streaming therefore costs only the new bytes.
export function diffChildren(parent: string, prev: TspNode[], next: TspNode[]): unknown[] {
	let m = 0;
	while (m < prev.length && m < next.length && prev[m].id === next[m].id && prev[m].k === next[m].k) m += 1;
	const ops: unknown[] = [];
	for (let i = 0; i < m; i += 1) ops.push(...diffNode(prev[i], next[i]));
	for (let i = prev.length - 1; i >= m; i -= 1) ops.push(["del", prev[i].id]);
	for (let i = m; i < next.length; i += 1) ops.push(["add", next[i].id, parent, null, next[i]]);
	return ops;
}

function diffNode(prev: TspNode, next: TspNode): unknown[] {
	if (JSON.stringify(prev) === JSON.stringify(next)) return [];
	const pp = prev.p ?? {};
	const np = next.p ?? {};
	const ops: unknown[] = [];
	const { text: pt, ...pRest } = pp;
	const { text: nt, ...nRest } = np;
	if (
		typeof pt === "string" &&
		typeof nt === "string" &&
		nt.length > pt.length &&
		nt.startsWith(pt) &&
		JSON.stringify(pRest) === JSON.stringify(nRest)
	) {
		ops.push(["text", next.id, "append", nt.slice(pt.length)]);
	} else if (JSON.stringify(pp) !== JSON.stringify(np)) {
		const props: Record<string, unknown> = {};
		for (const key of Object.keys(pp)) if (!(key in np)) props[key] = null;
		Object.assign(props, np);
		ops.push(["set", next.id, props]);
	}
	ops.push(...diffChildren(next.id, prev.c ?? [], next.c ?? []));
	return ops;
}

export interface TspView {
	main: TspNode[];
	dock: TspNode[];
	layer: TspNode[];
	focus?: string;
	reveal?: string;
}

// One inline surface with `main` (transcript), `dock` (composer) and `layer` (overlays above both)
// regions. While credit is exhausted
// only the newest view is kept; each frame is diffed against the last view Tern acknowledged applying.
export class TernInlineSurface {
	readonly #write: TspWriter;
	readonly #id: string;
	readonly #credits: number;
	readonly #apc: number;
	#opened = false;
	#seq = 0;
	#acked = 0;
	#sent: TspView | null = null;
	#pending: TspView | null = null;

	constructor(write: TspWriter, id: string, credits: number = DEFAULT_CREDITS, apc: number = APC_LIMIT) {
		this.#write = write;
		this.#id = id;
		this.#credits = credits;
		this.#apc = apc;
	}

	open(title?: string): void {
		if (this.#opened) return;
		this.#write(encodeTsp("o", { id: this.#id, mode: "inline", ...(title ? { title } : {}) }));
		this.#opened = true;
	}

	stylesheet(name: string, css: string): void {
		if (!this.#opened) throw new Error("TernInlineSurface.stylesheet called before open");
		if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error("Invalid TSP stylesheet name");
		for (const chunk of encodeTspChunks("s", { sf: this.#id, name, css }, this.#apc)) this.#write(chunk);
	}

	render(main: TspNode[], dock: TspNode[] = [], focus?: string, layer: TspNode[] = [], reveal?: string): void {
		if (!this.#opened) throw new Error("TernInlineSurface.render called before open");
		this.#pending = { main, dock, layer, focus, reveal };
		this.#flush(false);
	}

	// Ack messages are `{ev:"ack", sf, s}`; `s` is the highest frame applied and drawn.
	handleEvent(msg: TspMessage): void {
		if (msg.verb !== "e" || msg.body.ev !== "ack" || msg.body.sf !== this.#id) return;
		if (typeof msg.body.s !== "number") return;
		this.#acked = Math.max(this.#acked, msg.body.s);
		this.#flush(false);
	}

	close(keep = false): void {
		if (!this.#opened) return;
		this.#flush(true);
		this.#write(encodeTsp("x", { id: this.#id, keep }));
		this.#opened = false;
	}

	#flush(force: boolean): void {
		if (!this.#pending) return;
		if (!force && this.#seq - this.#acked >= this.#credits) return;
		const view = this.#pending;
		this.#pending = null;
		const ops = this.#ops(view);
		if (ops.length === 0) return;
		this.#seq += 1;
		for (const chunk of encodeTspChunks("f", { sf: this.#id, s: this.#seq, ops }, this.#apc)) this.#write(chunk);
		this.#sent = view;
	}

	#ops(view: TspView): unknown[] {
		const sent = this.#sent;
		const ops: unknown[] = [];
		if (!sent) {
			ops.push(["add", "main", this.#id, null, { id: "main", k: "col", c: [] }]);
			ops.push(["add", "dock", this.#id, null, { id: "dock", k: "col", c: [] }]);
			ops.push(["add", "layer", this.#id, null, { id: "layer", k: "col", c: [] }]);
		}
		ops.push(...diffChildren("main", sent?.main ?? [], view.main));
		ops.push(...diffChildren("dock", sent?.dock ?? [], view.dock));
		ops.push(...diffChildren("layer", sent?.layer ?? [], view.layer));
		if (view.focus && view.focus !== sent?.focus) ops.push(["focus", view.focus]);
		if (view.reveal && view.reveal !== sent?.reveal) ops.push(["reveal", view.reveal, "nearest"]);
		return ops;
	}
}

export interface TranscriptMessage {
	id: string;
	role: "user" | "assistant" | "system";
	text: string;
}

export function projectTranscript(messages: TranscriptMessage[]): TspNode[] {
	return messages.map((m) => {
		const id = `msg-${m.id}`;
		if (m.role === "user") return {
			id, k: "card", p: { role: "pi.user", tone: "user" },
			c: [{ id: `${id}.body`, k: "md", p: { text: m.text } }],
		};
		if (m.role === "assistant") return {
			id, k: "col", p: { role: "pi.assistant" },
			c: [{ id: `${id}.body`, k: "md", p: { text: m.text, stream: true } }],
		};
		return { id, k: "md", p: { text: m.text } };
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}
