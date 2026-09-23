import { classifyCreation, loadPolicy, structureGuardDisabledByEnv, violationReason, type StructurePolicy, type StructureViolation } from "./project-structure.ts";
import { bashCreationTargets } from "./bash-targets.ts";

/** Tools whose arguments name a path that the tool will create. */
const PATH_ARGUMENTS = ["path", "file_path", "filePath", "filename", "target", "notebook_path"] as const;

export interface GuardDecision { block: true; reason: string; violation: StructureViolation; }

function candidatePaths(toolName: string, input: any): string[] {
  if (!input || typeof input !== "object") return [];
  const name = toolName.toLowerCase();
  if (name === "apply_patch") return patchTargets(typeof input.input === "string" ? input.input : "");
  // Shell mutations bypassed the guard entirely until now; see bash-targets.ts
  // for why extraction is deliberately conservative.
  if (name === "bash") return typeof input.command === "string" ? bashCreationTargets(input.command) : [];
  if (!/^(write|edit|notebookedit|multiedit)$/.test(name)) return [];
  return PATH_ARGUMENTS.map(key => (input as any)[key]).filter((value): value is string => typeof value === "string" && value.trim().length > 0);
}

/** `*** Add File: <path>` is the only V4A directive that creates a new path. */
function patchTargets(patch: string): string[] {
  const targets: string[] = [];
  for (const line of patch.split("\n")) {
    const match = /^\*\*\* Add File:\s*(.+?)\s*$/.exec(line);
    if (match) targets.push(match[1]);
  }
  return targets;
}

export interface GuardOptions { cwd: string; env?: NodeJS.ProcessEnv; onWarning?: (message: string) => void; loadPolicyFor?: (root: string) => StructurePolicy | undefined; }

/**
 * Decide whether a tool call would create a path the project structure policy
 * forbids. Returns undefined whenever the guard does not apply: no policy,
 * advisory enforcement, env override, or a non-creating tool. The caller is
 * responsible for turning a decision into Pi's `{ block, reason }` contract.
 */
export function evaluateToolCall(event: { toolName?: string; tool_name?: string; input?: any; arguments?: any }, options: GuardOptions): GuardDecision | undefined {
  if (structureGuardDisabledByEnv(options.env ?? process.env)) return undefined;
  const toolName = String(event.toolName ?? event.tool_name ?? "");
  if (!toolName) return undefined;
  const policy = (options.loadPolicyFor ?? (root => loadPolicy(root, options.onWarning)))(options.cwd);
  if (!policy || policy.enforcement !== "block") return undefined;
  for (const candidate of candidatePaths(toolName, event.input ?? event.arguments)) {
    const violation = classifyCreation(options.cwd, policy, candidate);
    if (violation) return { block: true, reason: violationReason(violation), violation };
  }
  return undefined;
}
