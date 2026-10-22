/** Per-chat mode persistence. Pi writes `appendEntry` data into the session file, so the newest matching entry on the
 *  current branch is this chat's mode. It survives `/reload`, resume and restart, and a new or unrelated chat has none.
 *  Module and process globals are never the source of truth for this state. */
export function latestSessionModeEntry<T>(ctx: any, customType: string): T | undefined {
	const entries: any[] = ctx?.sessionManager?.getBranch?.() ?? [];
	const last = [...entries].reverse().find((entry) => entry?.type === "custom" && entry.customType === customType);
	return last?.data as T | undefined;
}
