// Session-backed metrics for the Tern dock. Every value comes from Pi session data or from events the
// bridge observed. A value Pi does not provide stays undefined, and the dock omits it (no placeholders).

/** Real output tokens from one message's usage block, or undefined when the message carries no usage. */
export function usageOutput(message: unknown): number | undefined {
	if (typeof message !== "object" || message === null) return undefined;
	const usage = (message as { usage?: unknown }).usage;
	if (typeof usage !== "object" || usage === null) return undefined;
	const output = (usage as { output?: unknown }).output;
	return typeof output === "number" && Number.isFinite(output) && output >= 0 ? output : undefined;
}

/** Sum of real output usage across persisted session message entries; undefined when none reported usage. */
function entriesOutput(entries: readonly unknown[]): number | undefined {
	let total: number | undefined;
	for (const entry of entries) {
		if (typeof entry !== "object" || entry === null) continue;
		const { type, message } = entry as { type?: unknown; message?: unknown };
		if (type !== "message") continue;
		const output = usageOutput(message);
		if (output !== undefined) total = (total ?? 0) + output;
	}
	return total;
}

/** Context percent from Pi's ContextUsage; null (unknown after compaction) or malformed values yield undefined. */
export function contextPercent(usage: unknown): number | undefined {
	if (typeof usage !== "object" || usage === null) return undefined;
	const percent = (usage as { percent?: unknown }).percent;
	return typeof percent === "number" && Number.isFinite(percent) && percent >= 0 ? Math.round(percent) : undefined;
}

export function formatTokens(tokens: number): string {
	return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
}

export function formatActive(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	const h = Math.floor(seconds / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	const s = seconds % 60;
	return h ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m ${String(s).padStart(2, "0")}s`;
}

export interface MetricsSnapshot {
	outputTokens?: number;
	activeMs?: number;
}

/**
 * Per-session counters. `reset` rebases on a session's persisted entries (output usage only; active time
 * is unknown until a turn is observed). `start`/`stop` bracket observed turns; `addMessage` adds live usage.
 */
export class SessionMetrics {
	#sessionId: string | undefined;
	#outputTokens: number | undefined;
	#activeMs: number | undefined;
	#turnStart: number | undefined;

	get sessionId(): string | undefined {
		return this.#sessionId;
	}

	reset(sessionId: string | undefined, entries: readonly unknown[]): void {
		this.#sessionId = sessionId;
		this.#outputTokens = Array.isArray(entries) ? entriesOutput(entries) : undefined;
		this.#activeMs = undefined;
		this.#turnStart = undefined;
	}

	start(now: number): void {
		if (this.#turnStart === undefined) this.#turnStart = now;
	}

	stop(now: number): void {
		if (this.#turnStart === undefined) return;
		this.#activeMs = (this.#activeMs ?? 0) + Math.max(0, now - this.#turnStart);
		this.#turnStart = undefined;
	}

	addMessage(message: unknown): void {
		const output = usageOutput(message);
		if (output !== undefined) this.#outputTokens = (this.#outputTokens ?? 0) + output;
	}

	snapshot(now: number): MetricsSnapshot {
		const live = this.#turnStart === undefined ? 0 : Math.max(0, now - this.#turnStart);
		const known = this.#activeMs !== undefined || this.#turnStart !== undefined;
		return {
			outputTokens: this.#outputTokens,
			activeMs: known ? (this.#activeMs ?? 0) + live : undefined,
		};
	}
}
