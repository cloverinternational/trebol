#!/usr/bin/env -S node --experimental-strip-types
/** Real Pi session: oversized tool text is spilled, bounded, and recoverable; Bash keeps its envelope. */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolvePiHost } from "../install/pi-host.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const root = mkdtempSync(join(tmpdir(), "trebol-toolout-e2e-"));
let session;
const cleanup = () => { session?.dispose(); rmSync(root, { recursive: true, force: true }); };
const deadline = setTimeout(() => { console.error("FAIL tool-output spillover timed out"); cleanup(); process.exit(1); }, 120_000);

/**
 * Repo convention is `n=/path/to/pi` for an npm-installed host. A managed
 * install (`pi` shell wrapper) has no adjacent package.json, so fall back to the
 * release the wrapper itself would exec: the same installed runtime, resolved
 * directly.
 */
function sdkUrl() {
  try { return resolvePiHost({ executable: process.env.n }).sdkUrl; } catch { /* managed install */ }
  const installRoot = process.env.PI_MANAGED_INSTALL_ROOT ?? join(homedir(), ".pi/agent/install");
  const version = readFileSync(join(installRoot, "current-version"), "utf8").trim();
  const sdk = join(installRoot, "releases", version, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js");
  if (!existsSync(sdk)) throw new Error(`No Pi SDK found (set n=/path/to/pi); looked for ${sdk}`);
  return pathToFileURL(sdk).href;
}

try {
  const agentDir = join(root, "agent");
  mkdirSync(agentDir);
  // The probe runs inside Pi's extension loader (which handles TypeScript parameter properties).
  const probe = join(root, "spill-probe.ts");
  writeFileSync(probe, `import { registerSwarmBuiltinHooks } from ${JSON.stringify(join(repo, ".pi/lib/runtime/swarm-builtin-hooks-runtime.ts"))};
import { registerSwarmBash } from ${JSON.stringify(join(repo, "extensions/swarm-bash/extension.ts"))};
export default function spillProbe(pi: any) {
  const captured: any[] = [];
  const api: any = Object.create(pi);
  api.registerTool = (tool: any) => { captured.push(tool); pi.registerTool(tool); };
  // The production wiring: taskmanage registers the Swarm builtin hooks, and
  // that registration installs the output boundary independently of them.
  registerSwarmBuiltinHooks(api, { enforcementMode: "off" });
  registerSwarmBash(api);
  api.registerTool({
    name: "bigout",
    label: "bigout",
    description: "Returns an oversized body that only the shared tool_result boundary can bound.",
    parameters: { type: "object", properties: {}, required: [] },
    async execute() {
      const text = Array.from({ length: 12000 }, (_, i) => \`row-\${i + 1}-0123456789abcdef\`).join("\\n");
      return { content: [{ type: "text", text }], details: {} };
    },
  });
  (globalThis as any).__spillProbe = { captured };
}
`);
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "local", defaultModel: "script" }));
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { local: { baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", apiKey: "dummy", models: [{ id: "script", contextWindow: 100000, maxTokens: 1024, reasoning: false }] } } }));

  const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } = await import(sdkUrl());
  const settingsManager = SettingsManager.create(root, agentDir);
  const resourceLoader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager, noExtensions: true, noSkills: true, noThemes: true, noContextFiles: true, noPromptTemplates: true, additionalExtensionPaths: [probe] });
  await resourceLoader.reload();
  ({ session } = await createAgentSession({ cwd: root, agentDir, settingsManager, resourceLoader, sessionManager: SessionManager.inMemory(root) }));
  await session.bindExtensions({ mode: "print" });
  await new Promise(r => setTimeout(r, 400));

  const tools = globalThis.__spillProbe?.captured ?? [];
  const bash = tools.find((tool) => tool.name === "bash");
  const bigout = tools.find((tool) => tool.name === "bigout");
  assert.ok(bash, "the real Swarm Bash tool was registered");
  assert.ok(bigout, "the probe tool was registered");
  const after = (name, result, isError, id) => session.agent.afterToolCall({
    toolCall: { id, name, arguments: {} }, args: {}, result, isError,
  });
  assert.equal(typeof session.agent.afterToolCall, "function", "the installed result boundary is installed");

  // 1. Real shell output over the Bash threshold: the envelope points at the full text.
  const bashResult = await bash.execute("call-bash", { command: "seq 1 20000", timeout_seconds: 60 }, undefined, undefined, { cwd: root, hasUI: false });
  const xml = bashResult.content[0].text;
  const bashPath = /<output_file path="([^"]*)"\/>/.exec(xml)?.[1];
  assert.ok(bashPath, `Bash named a spill file (got ${xml.slice(0, 200)})`);
  assert.equal(statSync(bashPath).mode & 0o777, 0o600, "the spill file is private");
  const bashFile = readFileSync(bashPath, "utf8");
  assert.equal(bashFile.split("\n").filter(Boolean).length, 20000, "every shell line is recoverable");
  assert.ok(bashFile.startsWith("1\n2\n3\n"), "recovered text starts at the first line");
  assert.ok(bashFile.endsWith("20000\n") || bashFile.endsWith("20000"), "recovered text ends at the last line");
  assert.ok(xml.includes('exit_code="0"'), "exit metadata survives the spill");
  expectNoPatch(await after("bash", bashResult, false, "call-bash"), "Bash output is already inside the general budget");

  // 2. A tool that does not bound itself: the shared boundary clips and spills it.
  const bigResult = await bigout.execute("call-big");
  const full = bigResult.content[0].text;
  assert.ok(Buffer.byteLength(full, "utf8") > 100_000, "the probe body is over the general budget");
  const patch = await after("bigout", bigResult, false, "call-big");
  assert.ok(patch?.content, "the installed boundary patched the oversized result");
  const bounded = patch.content[0].text;
  assert.ok(Buffer.byteLength(bounded, "utf8") <= 100_000, "model-facing text stays inside the budget");
  assert.match(bounded, /Full output saved to: .+/);
  const recovered = readFileSync(/Full output saved to: (.+)/.exec(bounded)[1].trim(), "utf8");
  assert.equal(recovered, full, "the artifact holds every byte the tool returned");

  // 3. A failed result stays failed and still gets its text bounded.
  const failed = await after("bigout", { content: [{ type: "text", text: full }], details: {} }, true, "call-big-fail");
  assert.equal(failed.isError, true, "the error status is preserved");
  assert.match(failed.content[0].text, /Full output saved to: /);

  console.log("PASS tool-output spillover: real shell spill recoverable, general boundary bounded, failures kept");
} catch (error) {
  console.error(`FAIL ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  cleanup();
}

function expectNoPatch(patch, label) {
  assert.equal(patch, undefined, label);
}
