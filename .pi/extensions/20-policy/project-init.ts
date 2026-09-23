import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { registerHook } from "../../lib/runtime/hook-state.ts";
import { evaluateToolCall } from "../../lib/policy/structure-guard.ts";
import { loadPolicy, policyExists, projectNameFrom, PROJECT_TIERS, STRUCTURE_POLICY_RELPATH, type ProjectTier } from "../../lib/policy/project-structure.ts";
import { applyArtifacts, parseEnvVars, planWithState, validateName, validateSummary, type ProjectAnswers } from "../../lib/policy/project-scaffold.ts";
import { pathWithinRoot, resolvePathForCheck } from "../../lib/tools/path-guard.ts";

/** Resolve a target directory that must stay inside the workspace root. */
export function resolveTarget(cwd: string, value: string): string | undefined {
  const trimmed = (value ?? "").trim();
  if (!trimmed || trimmed === ".") return resolve(cwd);
  if (isAbsolute(trimmed)) return undefined;
  const candidate = resolve(cwd, trimmed);
  try { return pathWithinRoot(resolvePathForCheck(cwd), resolvePathForCheck(candidate)) ? candidate : undefined; }
  catch { return undefined; }
}

/** What already exists, so the agent interviews around reality instead of guessing. */
export function inspectTarget(root: string): { exists: boolean; empty: boolean; initialised: boolean; tier?: ProjectTier; enforcement?: string; entries: string[]; missing: string[] } {
  const exists = existsSync(root);
  const entries = exists ? readdirSync(root).filter(entry => entry !== ".git").sort().slice(0, 50) : [];
  const policy = exists ? loadPolicy(root) : undefined;
  const missing = policy ? [...new Set(["README.md", "docs/index.md", ...policy.rootFiles])].filter(path => !existsSync(join(root, path))).sort() : [];
  return { exists, empty: entries.length === 0, initialised: Boolean(policy), tier: policy?.tier, enforcement: policy?.enforcement, entries, missing };
}

/**
 * The interview brief injected by `/init`. It is a user message, so the agent
 * treats it as an instruction and drives the conversation with
 * `ask_user_question` rather than a modal wizard owning the terminal.
 */
export function buildInitPrompt(target: string, relative: string, extra: string): string {
  const state = inspectTarget(target);
  const where = relative === "." ? "the current workspace" : `./${relative}`;
  const subject = relative === "." ? "It" : `./${relative}`;
  const situation = !state.exists ? `${subject} does not exist yet and will be created.`
    : state.initialised ? `${subject} is already initialised (tier ${state.tier}, enforcement ${state.enforcement}).${state.missing.length ? ` Missing policy-required paths: ${state.missing.join(", ")}.` : " Every policy-required path is present."}`
    : state.empty ? `${subject} is empty.`
    : `${subject} already contains: ${state.entries.join(", ")}.`;

  return [
    `Set up ${where} as a properly structured project. ${situation}`,
    extra.trim() ? `\nWhat I want: ${extra.trim()}` : "",
    `
Interview me with the ask_user_question tool before writing anything. Ask in small batches, not one giant questionnaire, and infer what you can from ${where} instead of asking about it. You need to establish:

- project name (kebab-case) and a one-line summary
- tier: demo (throwaway/spike), product (maintained), or platform (long-lived, governed) — this decides how much structure is justified
- primary language
- whether it reads configuration from the environment, and if so the variable NAMES only — never values
- infrastructure: none, docker, or terraform
- whether to generate a CI workflow skeleton and a knowledge/ directory

Where I have already answered something above, do not ask it again. Where a sensible default exists, propose it as the recommended option rather than asking an open question.

Then call project_init with action="plan" to show me exactly which files would be written, and only after I approve call action="apply". Do not create any project file with write, edit, or apply_patch — project_init owns that, and after it runs a structure guard blocks paths that violate ${STRUCTURE_POLICY_RELPATH}.`,
  ].filter(Boolean).join("\n");
}

const parameters = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["inspect", "plan", "apply"], description: "inspect reports what already exists; plan previews the exact file list without writing; apply writes the files. Always plan and get user approval before apply." },
    target: { type: "string", description: "Optional project directory relative to the workspace root. Defaults to the workspace root. Absolute paths and paths outside the workspace are rejected." },
    name: { type: "string", description: "Project name in kebab-case. Required for plan and apply." },
    summary: { type: "string", description: "One-line description of what the project does. Required for plan and apply." },
    tier: { type: "string", enum: ["demo", "product", "platform"], description: "demo = throwaway/spike, minimum structure. product = maintained, adds agent guide and changelog. platform = long-lived, adds contributing and security policy." },
    language: { type: "string", description: "Primary implementation language, lowercase." },
    envVars: { type: "array", items: { type: "string" }, description: "Environment variable NAMES only, UPPER_SNAKE_CASE. Never pass values or secrets." },
    iac: { type: "string", enum: ["none", "docker", "terraform"], default: "none" },
    ci: { type: "boolean", default: false, description: "Generate a CI workflow skeleton." },
    knowledge: { type: "boolean", default: false, description: "Generate a knowledge/ directory for durable domain notes." },
  },
  required: ["action"],
};

const reply = (value: unknown) => ({ content: [{ type: "text", text: JSON.stringify(value) }], details: value });

/** Validate the agent-supplied answers; returns the error list rather than throwing. */
export function validateAnswers(input: any): { answers?: ProjectAnswers; errors: string[] } {
  const errors: string[] = [];
  const nameError = validateName(String(input?.name ?? ""));
  if (nameError) errors.push(nameError);
  const summaryError = validateSummary(String(input?.summary ?? ""));
  if (summaryError) errors.push(summaryError);
  const tier = input?.tier;
  if (!PROJECT_TIERS.includes(tier)) errors.push(`tier must be one of ${PROJECT_TIERS.join(", ")}.`);
  const language = String(input?.language ?? "").trim().toLowerCase();
  if (!language) errors.push("language is required.");
  const rawEnv = Array.isArray(input?.envVars) ? input.envVars.join(",") : String(input?.envVars ?? "");
  const { names, invalid } = parseEnvVars(rawEnv);
  if (invalid.length) errors.push(`Not valid environment variable names: ${invalid.join(", ")}. Use UPPER_SNAKE_CASE names only, never values.`);
  const iac = input?.iac ?? "none";
  if (!["none", "docker", "terraform"].includes(iac)) errors.push("iac must be none, docker, or terraform.");
  if (errors.length) return { errors };
  return { errors: [], answers: { name: String(input.name).trim(), summary: String(input.summary).trim(), tier, language, envVars: names, iac, ci: input?.ci === true, knowledge: input?.knowledge === true } };
}

export async function executeProjectInit(input: any, cwd: string) {
  const target = resolveTarget(cwd, input?.target ?? "");
  if (!target) return reply({ success: false, error: "target must be a relative path inside the workspace." });

  if (input?.action === "inspect") return reply({ success: true, target: input?.target || ".", ...inspectTarget(target) });

  const { answers, errors } = validateAnswers(input);
  if (!answers) return reply({ success: false, errors, hint: "Ask the user for the missing or corrected values, then retry." });

  const planned = planWithState(target, answers);
  const plan = planned.map(artifact => ({ path: artifact.path, status: artifact.identical ? "unchanged" : artifact.exists ? "kept (already exists)" : "create" }));

  if (input.action === "plan") {
    return reply({ success: true, action: "plan", target: input?.target || ".", willCreate: plan.filter(entry => entry.status === "create").map(entry => entry.path), plan, note: "No files were written. Show this list to the user and get approval before calling action=\"apply\"." });
  }
  if (input.action !== "apply") return reply({ success: false, error: "action must be inspect, plan, or apply." });

  try {
    mkdirSync(target, { recursive: true });
    const result = applyArtifacts(target, answers, "create");
    return reply({ success: true, action: "apply", target: input?.target || ".", written: result.written, kept: result.skipped, unchanged: result.unchanged, guard: `Structure guard is active from ${STRUCTURE_POLICY_RELPATH}; creating a path outside that policy is now blocked.` });
  } catch (error) {
    return reply({ success: false, error: `Init failed partway through; already-written files were kept: ${error instanceof Error ? error.message : String(error)}` });
  }
}

export function registerProjectInit(pi: any, options: { cwd?: string } = {}) {
  const cwd = options.cwd ?? pi.getCwd?.() ?? process.cwd();

  registerHook(pi, "structure-guard", "tool_call", (event: any) => {
    const decision = evaluateToolCall(event, { cwd });
    return decision ? { block: true, reason: decision.reason, hookName: "project-structure-guard" } : undefined;
  });

  pi.registerTool?.({
    name: "project_init",
    label: "Project init",
    description: "Inspect, plan, or apply a structured project scaffold. Call action=\"inspect\" to see what exists, action=\"plan\" to preview the exact files, and action=\"apply\" only after the user approves the plan. Writing project scaffold files with write/edit/apply_patch instead of this tool is incorrect.",
    parameters,
    execute: async (_id: string, input: any) => executeProjectInit(input, cwd),
  });

  pi.registerCommand?.("init", {
    description: "Start an interactive project setup interview, then scaffold an enforced structure",
    handler: async (args: string, ctx: any) => {
      const root = ctx?.cwd ?? cwd;
      const trimmed = (args ?? "").trim();
      const [first = "", ...rest] = trimmed.split(/\s+/);
      // Only an unambiguous path selects the target. A bare word is intent, so
      // "/init a rust cli" describes the project rather than naming a directory.
      const looksLikePath = first === "." || first.startsWith("./") || first.startsWith("../") || first.includes("/");
      const relative = looksLikePath ? first : ".";
      const extra = looksLikePath ? rest.join(" ") : trimmed;
      const target = resolveTarget(root, relative);
      if (!target) return ctx?.ui?.notify?.(`"${first}" is not a relative path inside this workspace.`, "error");
      const prompt = buildInitPrompt(target, relative === "." ? "." : relative, extra);
      await (ctx?.sendUserMessage ?? pi.sendUserMessage)?.(prompt, { deliverAs: "followUp", triggerTurn: true });
    },
  });
}

export default function projectInitExtension(pi: any) { return registerProjectInit(pi); }
