import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyCreation, defaultPolicy, loadPolicy, savePolicy, serializePolicy,
  structureGuardDisabledByEnv, STRUCTURE_POLICY_RELPATH,
} from "../../lib/policy/project-structure.ts";
import { applyArtifacts, parseEnvVars, planArtifacts, validateName, validateSummary, type ProjectAnswers } from "../../lib/policy/project-scaffold.ts";
import { evaluateToolCall } from "../../lib/policy/structure-guard.ts";
import { buildInitPrompt, executeProjectInit, inspectTarget, registerProjectInit, resolveTarget, validateAnswers } from "../../extensions/20-policy/project-init.ts";

const workspace = () => mkdtempSync(join(tmpdir(), "pi-project-init-"));

const answers = (overrides: Partial<ProjectAnswers> = {}): ProjectAnswers => ({
  name: "sample-service", summary: "A sample service.", tier: "product", language: "typescript",
  envVars: [], iac: "none", ci: false, knowledge: false, ...overrides,
});

/** Minimal Pi double capturing command, tool, and hook registrations. */
function fakePi(cwd: string) {
  const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
  const commands = new Map<string, any>();
  const tools = new Map<string, any>();
  const sent: Array<{ content: string; options: any }> = [];
  const pi = {
    appendEntry() {}, getCwd: () => cwd,
    on(event: string, handler: any) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
    registerCommand(name: string, spec: any) { commands.set(name, spec); },
    registerTool(tool: any) { tools.set(tool.name, tool); },
    sendUserMessage(content: string, options: any) { sent.push({ content, options }); },
  };
  return { pi, handlers, commands, tools, sent };
}

const payload = (result: any) => result.details;

describe("structure policy", () => {
  it("serialises deterministically regardless of input ordering", () => {
    const a = defaultPolicy("product");
    const b = { ...a, rootFiles: [...a.rootFiles].reverse(), forbidden: [...a.forbidden].reverse() };
    expect(serializePolicy(b)).toBe(serializePolicy(a));
    expect(serializePolicy(a).endsWith("\n")).toBe(true);
  });

  it("round-trips through disk and treats a malformed policy as absent with a warning", () => {
    const cwd = workspace();
    const policy = defaultPolicy("platform");
    savePolicy(cwd, policy);
    expect(loadPolicy(cwd)).toEqual(policy);
    writeFileSync(join(cwd, STRUCTURE_POLICY_RELPATH), "{not json");
    const warnings: string[] = [];
    expect(loadPolicy(cwd, warnings.push.bind(warnings))).toBeUndefined();
    expect(warnings[0]).toContain("not valid JSON");
  });
});

describe("creation classification", () => {
  const policy = defaultPolicy("product");

  it("allows permitted root files and paths under permitted root directories", () => {
    const cwd = workspace();
    expect(classifyCreation(cwd, policy, "README.md")).toBeUndefined();
    expect(classifyCreation(cwd, policy, "src/server/handler.ts")).toBeUndefined();
    expect(classifyCreation(cwd, policy, "docs/reference/configuration.md")).toBeUndefined();
  });

  it("denies unlisted root files, unlisted root directories, forbidden names, and bad casing", () => {
    const cwd = workspace();
    expect(classifyCreation(cwd, policy, "notes.md")?.rule).toBe("root-file");
    expect(classifyCreation(cwd, policy, "scratch/thing.ts")?.rule).toBe("root-dir");
    expect(classifyCreation(cwd, policy, "src/server.ts.bak")?.rule).toBe("forbidden");
    expect(classifyCreation(cwd, policy, "src/MyComponent.ts")?.rule).toBe("naming");
  });

  it("never flags a path that already exists, so legacy files stay editable", () => {
    const cwd = workspace();
    writeFileSync(join(cwd, "LegacyNotes.md"), "old");
    expect(classifyCreation(cwd, policy, "LegacyNotes.md")).toBeUndefined();
  });

  it("rejects traversal and ignores paths outside the project root", () => {
    const cwd = workspace();
    expect(classifyCreation(cwd, policy, "../escape.md")).toBeUndefined();
    expect(classifyCreation(cwd, policy, "/tmp/elsewhere.md")).toBeUndefined();
    expect(classifyCreation(cwd, policy, "src/../notes.md")?.rule).toBe("root-file");
  });

  it("classifies through a symlinked directory by its real location", () => {
    const cwd = workspace();
    mkdirSync(join(cwd, "src"));
    symlinkSync(join(cwd, "src"), join(cwd, "link"));
    expect(classifyCreation(cwd, policy, "link/handler.ts")).toBeUndefined();
    expect(classifyCreation(cwd, policy, "link/BadName.ts")?.rule).toBe("naming");
  });
});

describe("structure guard tool_call evaluation", () => {
  it("blocks polluting bash commands while allowing permitted and read-only ones", () => {
    const cwd = setup();
    // The gap this closes: shell mutations previously bypassed the guard.
    expect(evaluateToolCall({ toolName: "bash", input: { command: "touch junk.md" } }, { cwd })?.block).toBe(true);
    expect(evaluateToolCall({ toolName: "bash", input: { command: "mkdir scratch" } }, { cwd })?.block).toBe(true);
    expect(evaluateToolCall({ toolName: "bash", input: { command: "echo x > junk.md" } }, { cwd })?.block).toBe(true);

    // Permitted destinations and read-only commands must stay usable.
    expect(evaluateToolCall({ toolName: "bash", input: { command: "touch src/handler.go" } }, { cwd })).toBeUndefined();
    // Creating a permitted root directory itself must not be mistaken for a file.
    expect(evaluateToolCall({ toolName: "bash", input: { command: "mkdir -p src" } }, { cwd })).toBeUndefined();
    expect(evaluateToolCall({ toolName: "bash", input: { command: "mkdir tests" } }, { cwd })).toBeUndefined();
    expect(evaluateToolCall({ toolName: "bash", input: { command: "ls -la" } }, { cwd })).toBeUndefined();
    expect(evaluateToolCall({ toolName: "bash", input: { command: "npx vitest run" } }, { cwd })).toBeUndefined();
    expect(evaluateToolCall({ toolName: "bash", input: { command: "git status" } }, { cwd })).toBeUndefined();
    // Non-literal targets are not guessed at.
    expect(evaluateToolCall({ toolName: "bash", input: { command: "touch $TMPFILE" } }, { cwd })).toBeUndefined();
  });

  const setup = (tier: Parameters<typeof defaultPolicy>[0] = "product") => {
    const cwd = workspace();
    savePolicy(cwd, defaultPolicy(tier));
    return cwd;
  };

  it("blocks a write that would pollute the root and reports the policy file", () => {
    const cwd = setup();
    const decision = evaluateToolCall({ toolName: "write", input: { path: "scratch-notes.md" } }, { cwd });
    expect(decision?.block).toBe(true);
    expect(decision?.reason).toContain("not a permitted root file");
    expect(decision?.reason).toContain(STRUCTURE_POLICY_RELPATH);
  });

  it("blocks an apply_patch Add File directive but not its edits to existing files", () => {
    const cwd = setup();
    const add = "*** Begin Patch\n*** Add File: junk.txt\n+x\n*** End Patch";
    expect(evaluateToolCall({ toolName: "apply_patch", input: { input: add } }, { cwd })?.block).toBe(true);
    const update = "*** Begin Patch\n*** Update File: junk.txt\n+x\n*** End Patch";
    expect(evaluateToolCall({ toolName: "apply_patch", input: { input: update } }, { cwd })).toBeUndefined();
  });

  it("does not apply without a policy, under advisory enforcement, or with the env override", () => {
    expect(evaluateToolCall({ toolName: "write", input: { path: "junk.md" } }, { cwd: workspace() })).toBeUndefined();
    const advisory = workspace();
    savePolicy(advisory, { ...defaultPolicy("product"), enforcement: "advisory" });
    expect(evaluateToolCall({ toolName: "write", input: { path: "junk.md" } }, { cwd: advisory })).toBeUndefined();
    const blocking = setup();
    expect(evaluateToolCall({ toolName: "write", input: { path: "junk.md" } }, { cwd: blocking, env: { PI_SWARM_NO_STRUCTURE_GUARD: "1" } })).toBeUndefined();
    expect(structureGuardDisabledByEnv({ PI_SWARM_NO_STRUCTURE_GUARD: "yes" })).toBe(true);
  });

  it("ignores read-only tools", () => {
    const cwd = setup();
    expect(evaluateToolCall({ toolName: "read", input: { path: "junk.md" } }, { cwd })).toBeUndefined();
    expect(evaluateToolCall({ toolName: "bash", input: { command: "cat junk.md" } }, { cwd })).toBeUndefined();
  });

  it("returns Pi's exact blocking shape from the registered tool_call hook, before any write happens", async () => {
    const cwd = setup();
    const { pi, handlers, commands, tools } = fakePi(cwd);
    registerProjectInit(pi, { cwd });
    expect(commands.has("init")).toBe(true);
    expect(tools.has("project_init")).toBe(true);
    const blocked = await handlers.get("tool_call")![0]({ toolName: "write", toolCallId: "c1", input: { path: "junk.md" } }, {});
    expect(blocked).toMatchObject({ block: true });
    expect(Object.keys(blocked as object).sort()).toEqual(["block", "reason"]);
    expect(existsSync(join(cwd, "junk.md"))).toBe(false);
    await expect(handlers.get("tool_call")![0]({ toolName: "write", toolCallId: "c2", input: { path: "src/ok.ts" } }, {})).resolves.toBeUndefined();
  });
});

describe("artifact generation", () => {
  it("validates project name, summary, and env variable names", () => {
    expect(validateName("good-name")).toBeUndefined();
    expect(validateName("Bad Name")).toContain("kebab-case");
    expect(validateName("")).toContain("required");
    expect(validateSummary("Fine.")).toBeUndefined();
    expect(validateSummary("a\nb")).toContain("single line");
    expect(parseEnvVars("DATABASE_URL, api_key, PORT")).toEqual({ names: ["DATABASE_URL", "PORT"], invalid: ["api_key"] });
  });

  it("scales the artifact set by tier and options", () => {
    const paths = (a: ProjectAnswers) => planArtifacts(a).map(artifact => artifact.path);
    expect(paths(answers({ tier: "demo" }))).not.toContain("AGENTS.md");
    expect(paths(answers({ tier: "product" }))).toContain("AGENTS.md");
    expect(paths(answers({ tier: "platform" }))).toEqual(expect.arrayContaining(["CONTRIBUTING.md", "SECURITY.md"]));
    expect(paths(answers({ envVars: ["DATABASE_URL"] }))).toEqual(expect.arrayContaining([".env.example", "docs/reference/configuration.md"]));
    expect(paths(answers({ iac: "terraform", ci: true, knowledge: true }))).toEqual(expect.arrayContaining(["infra/main.tf", ".github/workflows/ci.yml", "knowledge/index.md"]));
  });

  it("produces byte-identical output for identical answers", () => {
    const first = planArtifacts(answers({ envVars: ["B_VAR", "A_VAR"], iac: "docker", ci: true }));
    const second = planArtifacts(answers({ envVars: ["A_VAR", "B_VAR"], iac: "docker", ci: true }));
    expect(second).toEqual(first);
  });

  it("generates a policy that permits every artifact it generates", () => {
    const a = answers({ tier: "platform", envVars: ["DATABASE_URL"], iac: "docker", ci: true, knowledge: true });
    const cwd = workspace();
    applyArtifacts(cwd, a);
    const policy = loadPolicy(cwd)!;
    const offenders = planArtifacts(a)
      .map(artifact => ({ path: artifact.path, violation: classifyCreation(cwd, policy, artifact.path, () => false) }))
      .filter(entry => entry.violation);
    expect(offenders).toEqual([]);
  });

  it("is idempotent and never clobbers existing content on a repeat run", () => {
    const cwd = workspace();
    const a = answers({ envVars: ["DATABASE_URL"] });
    const first = applyArtifacts(cwd, a);
    expect(first.written).toContain("README.md");
    expect(first.skipped).toEqual([]);
    writeFileSync(join(cwd, "README.md"), "# hand written\n");
    const second = applyArtifacts(cwd, a);
    expect(second.written).toEqual([]);
    expect(second.skipped).toEqual(["README.md"]);
    expect(second.unchanged).toContain("docs/index.md");
    expect(readFileSync(join(cwd, "README.md"), "utf8")).toBe("# hand written\n");
  });
});

describe("/init prompt injection", () => {
  it("keeps the target inside the workspace", () => {
    const cwd = workspace();
    expect(resolveTarget(cwd, "")).toBe(cwd);
    expect(resolveTarget(cwd, "apps/api")).toBe(join(cwd, "apps", "api"));
    expect(resolveTarget(cwd, "../outside")).toBeUndefined();
    expect(resolveTarget(cwd, "/etc")).toBeUndefined();
  });

  it("injects an interview brief as a user message instead of opening a modal wizard", async () => {
    const cwd = workspace();
    const { pi, commands, sent } = fakePi(cwd);
    registerProjectInit(pi, { cwd });
    await commands.get("init").handler("", { cwd, ui: { notify() {} } });
    expect(sent).toHaveLength(1);
    expect(sent[0].options).toMatchObject({ triggerTurn: true });
    expect(sent[0].content).toContain("ask_user_question");
    expect(sent[0].content).toContain("project_init");
    expect(sent[0].content).toContain("tier");
  });

  it("carries a free-form prompt into the brief so the agent does not re-ask it", async () => {
    const cwd = workspace();
    const { pi, commands, sent } = fakePi(cwd);
    registerProjectInit(pi, { cwd });
    await commands.get("init").handler("a rust cli for parsing logs", { cwd, ui: { notify() {} } });
    expect(sent[0].content).toContain("What I want: a rust cli for parsing logs");
  });

  it("treats a leading relative path as the target and the rest as intent", async () => {
    const cwd = workspace();
    const { pi, commands, sent } = fakePi(cwd);
    registerProjectInit(pi, { cwd });
    await commands.get("init").handler("apps/api a go service", { cwd, ui: { notify() {} } });
    expect(sent[0].content).toContain("./apps/api");
    expect(sent[0].content).toContain("What I want: a go service");
  });

  it("describes existing contents and an existing policy so the agent interviews around reality", () => {
    const populated = workspace();
    writeFileSync(join(populated, "main.go"), "package main");
    expect(buildInitPrompt(populated, ".", "")).toContain("already contains: main.go");

    const fresh = workspace();
    expect(buildInitPrompt(fresh, ".", "")).toContain("is empty");

    const initialised = workspace();
    savePolicy(initialised, defaultPolicy("product"));
    const prompt = buildInitPrompt(initialised, ".", "");
    expect(prompt).toContain("already initialised (tier product");
    expect(prompt).toContain("Missing policy-required paths");
  });

  it("refuses a target outside the workspace without sending a message", async () => {
    const cwd = workspace();
    const { pi, commands, sent } = fakePi(cwd);
    const notices: any[] = [];
    registerProjectInit(pi, { cwd });
    await commands.get("init").handler("../elsewhere", { cwd, ui: { notify: (m: string, t: string) => notices.push({ m, t }) } });
    expect(sent).toEqual([]);
    expect(notices.at(-1)?.t).toBe("error");
  });
});

describe("project_init tool", () => {
  const valid = { name: "sample-service", summary: "A sample service.", tier: "product", language: "typescript" };

  it("reports what already exists via inspect", async () => {
    const cwd = workspace();
    writeFileSync(join(cwd, "main.go"), "package main");
    const result = payload(await executeProjectInit({ action: "inspect" }, cwd));
    expect(result).toMatchObject({ success: true, exists: true, empty: false, initialised: false });
    expect(result.entries).toContain("main.go");
  });

  it("returns actionable errors instead of writing when answers are invalid", async () => {
    const cwd = workspace();
    const result = payload(await executeProjectInit({ action: "apply", name: "Bad Name", summary: "", tier: "huge" }, cwd));
    expect(result.success).toBe(false);
    expect(result.errors.join(" ")).toContain("kebab-case");
    expect(result.errors.join(" ")).toContain("tier must be one of");
    expect(existsSync(join(cwd, STRUCTURE_POLICY_RELPATH))).toBe(false);
  });

  it("rejects environment values masquerading as variable names", () => {
    const { errors } = validateAnswers({ ...valid, envVars: ["DATABASE_URL=postgres://secret"] });
    expect(errors.join(" ")).toContain("Not valid environment variable names");
  });

  it("previews without writing under action=plan", async () => {
    const cwd = workspace();
    const result = payload(await executeProjectInit({ action: "plan", ...valid }, cwd));
    expect(result.willCreate).toContain("README.md");
    expect(result.note).toContain("No files were written");
    expect(existsSync(join(cwd, "README.md"))).toBe(false);
  });

  it("writes under action=apply and activates the guard", async () => {
    const cwd = workspace();
    const result = payload(await executeProjectInit({ action: "apply", ...valid }, cwd));
    expect(result.success).toBe(true);
    expect(result.written).toContain("README.md");
    expect(existsSync(join(cwd, STRUCTURE_POLICY_RELPATH))).toBe(true);
    expect(evaluateToolCall({ toolName: "write", input: { path: "junk.md" } }, { cwd })?.block).toBe(true);
  });

  it("is idempotent across repeated apply calls", async () => {
    const cwd = workspace();
    await executeProjectInit({ action: "apply", ...valid }, cwd);
    const second = payload(await executeProjectInit({ action: "apply", ...valid }, cwd));
    expect(second.written).toEqual([]);
    expect(second.unchanged).toContain("README.md");
  });

  it("refuses a target outside the workspace", async () => {
    const cwd = workspace();
    const result = payload(await executeProjectInit({ action: "plan", target: "../escape", ...valid }, cwd));
    expect(result).toMatchObject({ success: false });
    expect(result.error).toContain("inside the workspace");
  });
});
