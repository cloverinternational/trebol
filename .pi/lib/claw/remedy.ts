/** The one retry primitive /claw uses: a per-run, per-state ledger entry with a budget, a jittered next-due time and a
 *  single transition to `exhausted`. Every automatic act (tab close, stall report, decision reminder, relaunch, Hoja
 *  lookup) goes through it, so no fault can be acted on in a loop. Kept dependency-free so both the daemon and the
 *  launch lifecycle can use it without a cycle. */
import type { Run } from "./store.ts";

export const remedyKey = (action: string, state?: string | number): string => (state === undefined ? action : `${action}:${state}`);

/** Deterministic jitter: the same key and attempt always give the same fraction, so a replay is exact and two runs
 *  never retry in lockstep. */
export function jitterFraction(key: string, attempt: number): number {
	let hash = 2166136261;
	for (const char of `${key}#${attempt}`) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
	return (hash % 1000) / 1000;
}

/** Exponential backoff with ±25% jitter, capped. `attempt` 1 is the first retry after the first failure. */
export function backoffMs(attempt: number, baseMs: number, capMs: number, key: string): number {
	const raw = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt - 1));
	return Math.min(capMs, Math.round(raw * (0.75 + 0.5 * jitterFraction(key, attempt))));
}

/** An act is due when it was never tried, or when its budget is unspent and its jittered next-due time has passed. */
export function remedyDue(run: Run, key: string, nowMs: number): boolean {
	const remedy = run.remedies?.[key];
	if (!remedy) return true;
	if (remedy.done || remedy.exhausted) return false;
	return Date.parse(remedy.nextAt) <= nowMs;
}

/** Records one attempt and schedules the next. The attempt that reaches the budget is marked exhausted, which is when
 *  the caller reports instead of retrying. */
export function recordAttempt(
	run: Run,
	key: string,
	nowMs: number,
	spec: { budget: number; baseMs: number; capMs: number; note?: string },
): { attempts: number; exhausted: boolean } {
	run.remedies ??= {};
	const prior = run.remedies[key];
	const attempts = (prior?.attempts ?? 0) + 1;
	const exhausted = attempts >= spec.budget;
	run.remedies[key] = {
		attempts,
		lastAt: new Date(nowMs).toISOString(),
		nextAt: new Date(nowMs + backoffMs(attempts, spec.baseMs, spec.capMs, key)).toISOString(),
		exhausted,
		note: spec.note ?? prior?.note,
	};
	return { attempts, exhausted };
}
