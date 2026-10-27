#!/usr/bin/env -S node --experimental-strip-types
/**
 * Real Pi SessionManager + real Tern bridge: after the machine went down a pane reopens its own session
 * and renders the transcript on the first frame; a pane that outlived its program in the same boot, a
 * session a live runner owns, and a forgotten record all start a new conversation. This is the durability
 * contract of .pi/lib/tern/startup-session.ts, exercised through the same function the runner calls.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir, uptime } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { resolvePiHost } from "../install/pi-host.mjs";
import { PiTernBridge } from "../../.pi/lib/tern/bridge.ts";
import {
	bootGeneration,
	chooseStartupSession,
	clearPaneRecord,
	openStartupSession,
	pidAlive,
	readPaneBook,
	recordPaneSession,
} from "../../.pi/lib/tern/startup-session.ts";

const ESC = "\u001b";
const PREFIX = `${ESC}_tsp;f;`;
const root = mkdtempSync(join(tmpdir(), "trebol-tern-durable-"));
const agentDir = join(root, "agent");
const sessionDir = join(root, "sessions");
const cwd = join(root, "work");
const bookPath = join(root, "tern-panes.json");
const PANE = "90194313219";
mkdirSync(agentDir);
mkdirSync(cwd);

const sdk = await import(resolvePiHost({ executable: process.env.PI_EXECUTABLE }).sdkUrl);
const { SessionManager, createAgentSessionRuntime, createAgentSessionServices, createAgentSessionFromServices } = sdk;
const deadline = setTimeout(() => {
	console.error("FAIL tern durable resume timed out");
	rmSync(root, { recursive: true, force: true });
	process.exit(1);
}, 90_000);

const createRuntime = async ({ cwd: runtimeCwd, agentDir: dir, sessionManager, sessionStartEvent }) => {
	const services = await createAgentSessionServices({ cwd: runtimeCwd, agentDir: dir });
	const created = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent });
	return { ...created, services, diagnostics: services.diagnostics };
};

/** A pid that has certainly exited, and one that is certainly alive. */
async function exitedAndLivePids() {
	const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
	await new Promise((resolve) => child.on("exit", resolve));
	const live = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
	return { dead: child.pid, live };
}

const BOOT = bootGeneration(Date.now(), uptime());
const start = (overrides = {}) =>
	openStartupSession({
		sessionManager: SessionManager,
		cwd,
		fresh: false,
		key: PANE,
		book: readPaneBook(bookPath),
		selfPid: process.pid,
		exists: existsSync,
		alive: pidAlive,
		boot: BOOT,
		...overrides,
	});
const record = (sessionFile, pid, boot) => ({ sessionFile, pid, cwd, updatedAt: Date.now(), boot });

let runtime;
let live;
try {
	const { dead, live: liveChild } = await exitedAndLivePids();
	live = liveChild;

	// Phase 1: a conversation recorded before this boot — the machine went down and took the runner with it.
	const owned = SessionManager.create(cwd, sessionDir);
	owned.appendMessage({ role: "user", content: "DURABLE_MARKER", timestamp: Date.now() });
	const ownedFile = owned.getSessionFile();
	assert.ok(ownedFile, "the first message persisted a session file");
	recordPaneSession(bookPath, PANE, record(ownedFile, dead, BOOT - 1), pidAlive);
	assert.equal(pidAlive(dead), false, "the previous owner is gone");

	// Phase 2: the next start on this boot reopens that session instead of starting over.
	const reopened = start();
	assert.equal(reopened.getSessionFile(), ownedFile, "the pane reopened its own session");
	const branch = JSON.stringify(reopened.getBranch());
	assert.ok(branch.includes("DURABLE_MARKER"), "the reopened session carries the persisted branch");

	// Phase 3: the real bridge renders that transcript on the very first frame, not an empty pane.
	runtime = await createAgentSessionRuntime(createRuntime, { cwd, agentDir, sessionManager: reopened });
	const writes = [];
	const bridge = new PiTernBridge(runtime.session, { write: (d) => writes.push(d), surfaceId: "pi", credits: 1000 });
	bridge.start("pi");
	const frames = writes.filter((w) => w.startsWith(PREFIX)).length;
	assert.ok(frames > 0, "the bridge wrote at least one frame");
	assert.ok(writes.join("").includes("DURABLE_MARKER"), "the first frames carry the restored transcript");
	bridge.close();

	// Phase 4: a record from this same boot means the pane outlived its program on purpose: start over.
	recordPaneSession(bookPath, PANE, record(ownedFile, dead, BOOT), pidAlive);
	assert.deepEqual(
		chooseStartupSession({ fresh: false, key: PANE, book: readPaneBook(bookPath), selfPid: process.pid, exists: existsSync, alive: pidAlive, boot: BOOT }),
		{ kind: "new", reason: "same-boot" },
	);
	assert.notEqual(start().getSessionFile(), ownedFile, "a deliberate exit starts a new conversation");

	// Phase 5: a session a live runner still owns is never opened twice (the detached-window case).
	recordPaneSession(bookPath, PANE, record(ownedFile, live.pid, BOOT - 1), pidAlive);
	assert.deepEqual(
		chooseStartupSession({ fresh: false, key: PANE, book: readPaneBook(bookPath), selfPid: process.pid, exists: existsSync, alive: pidAlive, boot: BOOT }),
		{ kind: "new", reason: "owner-alive" },
	);
	assert.notEqual(start().getSessionFile(), ownedFile, "the live session was not opened a second time");

	// Phase 6: /new forgets the record, so not even a later reboot reopens the old conversation.
	recordPaneSession(bookPath, PANE, record(ownedFile, dead, BOOT - 1), pidAlive);
	clearPaneRecord(bookPath, PANE);
	assert.equal(start().getSessionFile() === ownedFile, false, "a forgotten record resumes nothing");

	// Phase 7: an explicit fresh start ignores the record.
	recordPaneSession(bookPath, PANE, record(ownedFile, dead, BOOT - 1), pidAlive);
	assert.notEqual(start({ fresh: true }).getSessionFile(), ownedFile, "PI_TERN_FRESH starts a new conversation");

	console.log("PASS tern durable resume: post-boot resume renders, same-boot and forgotten records start over, a live owner is never doubled");
} finally {
	clearTimeout(deadline);
	live?.kill();
	runtime?.session?.dispose?.();
	rmSync(root, { recursive: true, force: true });
}
