// Session-resume core for the Tern replacement of `pi -r`. Pure logic only: it turns Pi's session list into
// plain candidates and switches sessions through the command context's `switchSession`. It imports no TUI
// modules, so the picker (Tern dialog or Pi UI) stays in the extension layer.
//
// Pi replaces the session on switch, which invalidates the old ctx. Plain data is captured before the
// switch, and any post-switch work runs in `withSession` with the ctx that callback receives.

export interface ResumeSessionRecord {
	path: string;
	id: string;
	cwd: string;
	name?: string;
	modified: Date;
	messageCount: number;
	firstMessage: string;
}

export interface ResumeCandidate {
	path: string;
	id: string;
	cwd: string;
	title: string;
	modified: number;
	messageCount: number;
}

export interface ResumeSwitchTarget {
	switchSession(
		sessionPath: string,
		options?: { withSession?: (next: unknown) => Promise<void> },
	): Promise<{ cancelled: boolean }>;
}

export type ResumeOutcome =
	| { status: "resumed"; path: string }
	| { status: "cancelled" }
	| { status: "not-applied"; path: string };

/** Lists sessions other than the current one, newest first, as plain data. */
export function resumeCandidates(records: readonly ResumeSessionRecord[], currentPath: string | undefined): ResumeCandidate[] {
	return records
		.filter((record) => record.path !== currentPath)
		.map((record) => ({
			path: record.path,
			id: record.id,
			cwd: record.cwd,
			title: record.name?.trim() || record.firstMessage.trim() || record.id,
			modified: record.modified.getTime(),
			messageCount: record.messageCount,
		}))
		.sort((a, b) => b.modified - a.modified);
}

/**
 * Switches to `sessionPath`. `afterSwitch` runs only inside `withSession`, with the replacement ctx.
 * A switch that resolves without invoking `withSession` was not applied (for example, a command context
 * bound without Pi's session runtime), so it is reported instead of counted as a resume.
 */
export async function resumeSession(
	target: ResumeSwitchTarget,
	sessionPath: string,
	afterSwitch?: (next: unknown) => Promise<void>,
): Promise<ResumeOutcome> {
	let applied = false;
	const result = await target.switchSession(sessionPath, {
		withSession: async (next) => {
			applied = true;
			await afterSwitch?.(next);
		},
	});
	if (result.cancelled) return { status: "cancelled" };
	if (!applied) return { status: "not-applied", path: sessionPath };
	return { status: "resumed", path: sessionPath };
}
