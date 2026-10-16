#!/usr/bin/env -S node --experimental-strip-types
/** Real Pi AgentSessionRuntime + Tern session-resume core: selecting a candidate switches the live session to it. */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePiHost } from "../install/pi-host.mjs";
import { resumeCandidates, resumeSession } from "../../.pi/lib/tern/session-resume.ts";

const sdk = await import(resolvePiHost().sdkUrl);
const { SessionManager, createAgentSessionRuntime, createAgentSessionServices, createAgentSessionFromServices } = sdk;
const root = mkdtempSync(join(tmpdir(), "trebol-tern-resume-"));
const agentDir = join(root, "agent");
const sessionDir = join(root, "sessions");
const cwd = join(root, "work");
mkdirSync(agentDir);
mkdirSync(cwd);
const deadline = setTimeout(() => { console.error("FAIL tern session resume timed out"); process.exit(1); }, 60_000);

const createRuntime = async ({ cwd: runtimeCwd, agentDir: dir, sessionManager, sessionStartEvent }) => {
	const services = await createAgentSessionServices({ cwd: runtimeCwd, agentDir: dir });
	const created = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent });
	return { ...created, services, diagnostics: services.diagnostics };
};

try {
	const first = SessionManager.create(cwd, sessionDir);
	first.appendMessage({ role: "user", content: "FIRST_SESSION_MARKER", timestamp: Date.now() });
	const firstPath = first.getSessionFile();
	await new Promise((r) => setTimeout(r, 20));
	const second = SessionManager.create(cwd, sessionDir);
	second.appendMessage({ role: "user", content: "SECOND_SESSION_MARKER", timestamp: Date.now() });
	const secondPath = second.getSessionFile();

	const runtime = await createAgentSessionRuntime(createRuntime, { cwd, agentDir, sessionManager: SessionManager.open(firstPath, sessionDir) });
	assert.equal(runtime.session.sessionFile, firstPath, "runtime starts on the first session");

	const records = await SessionManager.list(cwd, sessionDir);
	const candidates = resumeCandidates(records, runtime.session.sessionFile);
	assert.deepEqual(candidates.map((c) => c.path), [secondPath], "current session is excluded from the picker list");

	let seenInside = null;
	const outcome = await resumeSession(runtime, candidates[0].path, async (next) => {
		seenInside = next.sessionManager.getSessionFile();
	});
	assert.deepEqual(outcome, { status: "resumed", path: secondPath }, "switch is applied");
	assert.equal(runtime.session.sessionFile, secondPath, "live session is the selected session");
	assert.equal(seenInside, secondPath, "post-switch work receives the replacement ctx");

	const transcript = JSON.stringify(runtime.session.sessionManager.getEntries());
	assert.ok(transcript.includes("SECOND_SESSION_MARKER"), "transcript now shows the resumed session");
	assert.ok(!transcript.includes("FIRST_SESSION_MARKER"), "transcript no longer shows the previous session");

	runtime.session.dispose();
	console.log("PASS tern session resume: selecting a candidate switches the live Pi session");
} finally {
	clearTimeout(deadline);
	rmSync(root, { recursive: true, force: true });
}
