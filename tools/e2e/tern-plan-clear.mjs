#!/usr/bin/env -S node --experimental-strip-types
/**
 * Real Pi AgentSessionRuntime + swarm-plan-mode + plan-context-clear host with a
 * deterministic faux provider. Exercises the full "Approve + Clear Context"
 * path: approval in a live session, wait for idle, session replacement, and one
 * resumed implementation turn. Also checks ordinary approval and rejection.
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
let sdk;
let ai;
try {
  const { resolvePiHost } = await import("../install/pi-host.mjs");
  const host = resolvePiHost();
  // Keep the provider and the coding agent on the same installed SDK tree.
  sdk = await import(host.sdkUrl);
  ai = await import(pathToFileURL(join(dirname(host.root), "pi-ai", "dist", "index.js")).href);
} catch {
  sdk = await import("@earendil-works/pi-coding-agent");
  ai = await import("@earendil-works/pi-ai");
}
const { SessionManager, ModelRuntime, createAgentSessionRuntime, createAgentSessionServices, createAgentSessionFromServices, createEventBus } = sdk;
const { startPlanContextClearHost } = await import("../../.pi/lib/tern/plan-context.ts");

const PLAN = "# Approved Plan\n\n1. Add the widget\n2. Verify the widget";
const deadline = setTimeout(() => { console.error("FAIL tern plan clear timed out"); process.exit(1); }, 120_000);

async function scenario(pick) {
  const root = mkdtempSync(join(tmpdir(), `trebol-plan-clear-${pick}-`));
  const agentDir = join(root, "agent");
  const sessionDir = join(root, "sessions");
  const cwd = join(root, "work");
  mkdirSync(agentDir);
  mkdirSync(cwd);
  const previousHome = process.env.SWARM_HOME;
  process.env.SWARM_HOME = join(root, "home");

  const faux = ai.fauxProvider({});
  faux.setResponses([
    ai.fauxAssistantMessage([ai.fauxToolCall("enter_plan_mode", {})]),
    ai.fauxAssistantMessage([ai.fauxToolCall("exit_plan_mode", { plan: PLAN })]),
    ai.fauxAssistantMessage(pick === "c" ? "IMPLEMENTED_FROM_APPROVED_PLAN" : "CONTINUED_IN_SAME_SESSION"),
  ]);
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"), allowModelNetwork: false, refreshOnCreate: false });
  modelRuntime.registerProvider("faux", {
    api: "faux",
    baseUrl: "http://localhost:0",
    apiKey: "faux-key",
    streamSimple: faux.provider.streamSimple,
    models: [{ id: "faux-1", name: "Faux", input: ["text"], contextWindow: 128000, maxTokens: 16384, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  });
  await modelRuntime.setRuntimeApiKey("faux", "faux-key");
  const model = modelRuntime.getModel("faux", "faux-1");

  const events = createEventBus();
  const starts = [];
  const createRuntime = async ({ cwd: runtimeCwd, sessionManager, sessionStartEvent }) => {
    if (sessionStartEvent) starts.push(sessionStartEvent.reason);
    const services = await createAgentSessionServices({
      cwd: runtimeCwd,
      agentDir,
      modelRuntime,
      resourceLoaderOptions: {
        eventBus: events,
        additionalExtensionPaths: [join(repo, "extensions/swarm-plan-mode/extension.ts")],
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
      },
    });
    return { ...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model })), services, diagnostics: services.diagnostics };
  };
  const runtime = await createAgentSessionRuntime(createRuntime, { cwd, agentDir, sessionManager: SessionManager.create(cwd, sessionDir) });

  const notices = [];
  let offered = [];
  const ui = new Proxy({
    notify: (message) => notices.push(message),
    select: async (_title, options) => { offered = options; return options.find((option) => option.startsWith(pick)); },
    input: async () => "Please change the widget name",
  }, { get: (target, key) => (key in target ? target[key] : () => undefined) });
  const commandContextActions = {
    waitForIdle: () => runtime.session.waitForIdle(),
    newSession: (options) => runtime.newSession(options),
    fork: (id, options) => runtime.fork(id, options),
    navigateTree: (target, options) => runtime.session.navigateTree(target, options),
    switchSession: (path, options) => runtime.switchSession(path, options),
    reload: () => runtime.session.reload(),
  };
  await runtime.session.bindExtensions({ mode: "tui", uiContext: ui, commandContextActions });
  runtime.setRebindSession(async (next) => {
    await next.bindExtensions({ mode: "tui", uiContext: ui, commandContextActions });
  });
  const host = startPlanContextClearHost({
    sessionFile: () => runtime.session.sessionManager?.getSessionFile?.(),
    waitForIdle: () => runtime.session.waitForIdle(),
    newSession: (options) => runtime.newSession(options),
    notify: (text) => notices.push(text),
  });

  const firstFile = runtime.session.sessionFile;
  await runtime.session.prompt("PLAN_EXPLORATION_MARKER: explore before planning");
  await host.settled();
  await runtime.session.waitForIdle();
  const sessionEntries = runtime.session.sessionManager.getEntries();
  const text = JSON.stringify(sessionEntries);

  return { root, runtime, host, firstFile, starts, offered, notices, text, faux, restoreHome: () => { if (previousHome === undefined) delete process.env.SWARM_HOME; else process.env.SWARM_HOME = previousHome; } };
}

try {
  const clear = await scenario("c");
  assert.deepEqual(clear.offered, ["y: Approve", "c: Approve + Clear Context", "n: Reject / Revise"], "clear is offered when the Tern host is installed");
  assert.ok(clear.starts.includes("new"), "approval replaced the session");
  assert.equal(clear.starts.filter((reason) => reason === "new").length, 1, "exactly one replacement");
  assert.notEqual(clear.runtime.session.sessionFile, clear.firstFile, "the live session is the replacement");
  assert.ok(clear.text.includes("IMPLEMENTED_FROM_APPROVED_PLAN"), "implementation resumed in the cleared session");
  assert.ok(clear.text.includes("Approved Plan"), "the approved plan survived the clear");
  assert.equal((clear.text.match(/Implement the approved plan now\./g) ?? []).length, 1, "resume instruction sent exactly once");
  assert.ok(!clear.text.includes("PLAN_EXPLORATION_MARKER"), "stale exploration context is gone");
  assert.equal(clear.faux.state.callCount, 3, "two plan turns plus one resumed turn");
  assert.deepEqual(clear.notices, [], "no failure notices");
  clear.host.uninstall();
  clear.runtime.session.dispose();
  clear.restoreHome();
  rmSync(clear.root, { recursive: true, force: true });

  const ordinary = await scenario("y");
  assert.equal(ordinary.starts.filter((reason) => reason === "new").length, 0, "ordinary approval keeps the session");
  assert.equal(ordinary.runtime.session.sessionFile, ordinary.firstFile, "same session file");
  assert.ok(ordinary.text.includes("CONTINUED_IN_SAME_SESSION"), "implementation continued in the same session");
  assert.ok(ordinary.text.includes("PLAN_EXPLORATION_MARKER"), "ordinary approval preserves context");
  ordinary.host.uninstall();
  ordinary.runtime.session.dispose();
  ordinary.restoreHome();
  rmSync(ordinary.root, { recursive: true, force: true });

  const rejected = await scenario("n");
  assert.equal(rejected.starts.filter((reason) => reason === "new").length, 0, "rejection keeps the session");
  assert.equal(rejected.runtime.session.sessionFile, rejected.firstFile, "rejection keeps the session file");
  assert.ok(rejected.text.includes("Please change the widget name"), "rejection keeps plan mode active with feedback");
  assert.ok(rejected.text.includes("PLAN_EXPLORATION_MARKER"), "rejection preserves context");
  assert.deepEqual(rejected.offered, ["y: Approve", "c: Approve + Clear Context", "n: Reject / Revise"], "all choices stay available after a rejection");
  rejected.host.uninstall();
  rejected.runtime.session.dispose();
  rejected.restoreHome();
  rmSync(rejected.root, { recursive: true, force: true });

  console.log("PASS tern plan clear: approve+clear replaces the session once and resumes from the approved plan; ordinary approval and rejection keep context");
} finally {
  clearTimeout(deadline);
}
