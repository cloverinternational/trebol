#!/usr/bin/env -S node --experimental-strip-types
/** Real Pi AgentSessionRuntime + the /tern-resume command: cancel keeps the session; choosing one switches to it. */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePiHost } from "../install/pi-host.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sdk = await import(resolvePiHost().sdkUrl);
const { SessionManager, createAgentSessionRuntime, createAgentSessionServices, createAgentSessionFromServices, createEventBus } = sdk;
const root = mkdtempSync(join(tmpdir(), "trebol-tern-resume-cmd-"));
const agentDir = join(root, "agent");
const sessionDir = join(root, "sessions");
const cwd = join(root, "work");
mkdirSync(agentDir);
mkdirSync(cwd);
const deadline = setTimeout(() => { console.error("FAIL tern resume command timed out"); process.exit(1); }, 90_000);

const events = createEventBus();
const createRuntime = async ({ cwd: c, agentDir: d, sessionManager, sessionStartEvent }) => {
	const services = await createAgentSessionServices({
		cwd: c,
		agentDir: d,
		resourceLoaderOptions: { eventBus: events, additionalExtensionPaths: [join(repo, "extensions/tern-resume/extension.ts")] },
	});
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
	// Same command-context routing as run.ts: switches go through the runtime.
	const commandContextActions = {
		waitForIdle: () => runtime.session.waitForIdle(),
		newSession: (o) => runtime.newSession(o),
		fork: (id, o) => runtime.fork(id, o),
		navigateTree: (t, o) => runtime.session.navigateTree(t, o),
		switchSession: (p, o) => runtime.switchSession(p, o),
		reload: () => runtime.session.reload(),
	};
	const notices = [];
	let pick = "cancel";
	const ui = new Proxy({
		notify: (message) => notices.push(message),
		select: async (_title, options) => (pick === "cancel" ? undefined : options[0]),
	}, { get: (target, key) => (key in target ? target[key] : () => undefined) });
	await runtime.session.bindExtensions({ mode: "tui", uiContext: ui, commandContextActions });
	runtime.setRebindSession(async (next) => {
		await next.bindExtensions({ mode: "tui", uiContext: ui, commandContextActions });
	});
	assert.equal(runtime.session.sessionFile, firstPath, "runtime starts on the first session");

	const runCommand = async () => {
		const command = runtime.session.extensionRunner.getCommand("tern-resume");
		assert.ok(command, "tern-resume is registered");
		await command.handler("", runtime.session.extensionRunner.createCommandContext());
	};

	await runCommand();
	assert.equal(runtime.session.sessionFile, firstPath, "cancelling leaves the current session unchanged");
	assert.ok(notices.includes("Resume cancelled"), "cancel reports to the user");

	pick = "first-candidate";
	await runCommand();
	assert.equal(runtime.session.sessionFile, secondPath, "choosing a session switches the live session");
	assert.ok(notices.some((n) => n === "Resumed: SECOND_SESSION_MARKER"), "post-switch notice comes from the replacement ctx");
	const transcript = JSON.stringify(runtime.session.sessionManager.getEntries());
	assert.ok(transcript.includes("SECOND_SESSION_MARKER") && !transcript.includes("FIRST_SESSION_MARKER"), "transcript shows only the resumed session");

	runtime.session.dispose();
	console.log("PASS tern resume command: cancel keeps the session; selection switches it");
} finally {
	clearTimeout(deadline);
	rmSync(root, { recursive: true, force: true });
}
