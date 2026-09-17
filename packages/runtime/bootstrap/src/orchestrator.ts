import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BootstrapDraft, BootstrapMode, BootstrapResult, BootstrapSelection, BootstrapSelector, ParallelSelectors } from "./types.js";

export const MAX_BOOTSTRAP_SKILLS = 2;
/** Maximum UTF-16 code units inline; never split a surrogate pair. Not a tool-call budget. */
export const MAX_BOOTSTRAP_SKILL_DELIVERY_CHARS = 12000;

export interface BoundedSkillDelivery {
  name: string;
  content: Array<{ type: "text"; text: string }>;
  truncated: boolean;
  instructionsPath: string;
  spillPath?: string;
}

/** Convert a Skill handoff result into bounded, honest model-visible content. */
export function boundSkillDelivery(name: string, result: unknown, sourcePath?: string): BoundedSkillDelivery {
  const value = result as { isError?: unknown; content?: unknown; details?: { path?: unknown } } | null | undefined;
  if (value?.isError) throw new Error(`Skill ${name} failed to load`);
  const parts = Array.isArray(value?.content) ? value.content : [];
  const text = parts.filter((part): part is { type: "text"; text: string } =>
    !!part && typeof part === "object" && (part as any).type === "text" && typeof (part as any).text === "string",
  ).map(part => part.text).join("\n");
  if (!text) throw new Error(`Skill ${name} returned no instructions`);
  const instructionsPath = sourcePath || (typeof value?.details?.path === "string" && value.details.path
    ? value.details.path
    : `SkillManage(action="view", name=${JSON.stringify(name)}, offset=0, limit=12000)`);
  const truncated = text.length > MAX_BOOTSTRAP_SKILL_DELIVERY_CHARS;
  // Preserve the exact invocation output, including substitutions and base directory.
  // Unique private files avoid overwrites between concurrent bootstrap calls.
  let spillPath: string | undefined;
  if (truncated) {
    spillPath = join(mkdtempSync(join(tmpdir(), "pi-bootstrap-skill-")), "instructions.txt");
    writeFileSync(spillPath, text, { encoding: "utf8", mode: 0o600 });
  }
  const marker = `
[Inline preview only. Full invoked instructions spilled to ${spillPath}. Read that file in chunks with your file/shell tools as needed; follow-up tool calls are not capped by this preview. Do not invoke the skill again.]`;
  let end = Math.max(0, MAX_BOOTSTRAP_SKILL_DELIVERY_CHARS - marker.length);
  if (end > 0 && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
  const bounded = truncated
    ? text.slice(0, end) + marker
    : text;
  return { name, content: [{ type: "text", text: bounded }], truncated, instructionsPath, ...(spillPath ? { spillPath } : {}) };
}

function boundSelection(value: unknown): BootstrapSelection {
  const input = value as Partial<BootstrapSelection> | null | undefined;
  const seen = new Set<string>();
  return {
    memories: Array.isArray(input?.memories) ? input.memories.slice(0, 8).map((memory) => ({
      ...memory,
      text: String(memory?.text ?? "").slice(0, 1200),
    })) : [],
    skills: Array.isArray(input?.skills) ? input.skills.filter(skill => {
      if (!skill || typeof skill.name !== "string" || !skill.name.trim() || seen.has(skill.name)) return false;
      seen.add(skill.name); return true;
    }).slice(0, MAX_BOOTSTRAP_SKILLS).map((skill) => ({
      ...skill,
      body: String(skill?.body ?? "").slice(0, 4000),
    })) : [],
    evidence: Array.isArray(input?.evidence) ? input.evidence.slice(0, 20).map(String) : [],
  };
}

export async function runBootstrap(
  mode: BootstrapMode,
  task: string,
  selector: BootstrapSelector | ParallelSelectors,
  draft?: BootstrapDraft,
  signal: AbortSignal = new AbortController().signal,
  model = "session",
  loadSkills?: (selection: BootstrapSelection, signal: AbortSignal) => Promise<void>,
): Promise<BootstrapResult> {
  const resultBase: Pick<BootstrapResult, "mode" | "model" | "usage"> = {
    mode,
    model,
    usage: { selectorCalls: 0, draftCalls: 0, inputChars: task.length, outputChars: 0 },
  };
  if (mode === "off") return { ...resultBase, status: "disabled" };
  if (signal.aborted) return { ...resultBase, status: "cancelled" };

  try {
    let selection: BootstrapSelection;
    if (mode === "parallel") {
      const selectors = typeof selector === "function" ? { memory: selector, skills: selector } : selector;
      const [memory, skills] = await Promise.all([selectors.memory(task, signal), selectors.skills(task, signal)]);
      selection = { memories: [...memory.memories], skills: [...skills.skills], evidence: [...memory.evidence, ...skills.evidence] };
      resultBase.usage.selectorCalls = 2;
    } else {
      selection = await (selector as BootstrapSelector)(task, signal);
      resultBase.usage.selectorCalls = 1;
    }
    if (signal.aborted) return { ...resultBase, status: "cancelled" };
    const bounded = boundSelection(selection);
    if (loadSkills) await loadSkills(bounded, signal);
    if (signal.aborted) return { ...resultBase, status: "cancelled" };
    const result: BootstrapResult = { ...resultBase, status: "ready", selection: bounded };
    if (draft) {
      result.tasks = (await draft(task, bounded, signal)).slice(0, 50).map((item, index) => ({ ...item, id: String(item.id || `T${index + 1}`) }));
      result.usage.draftCalls = 1;
    }
    result.usage.outputChars = JSON.stringify(result).length;
    return result;
  } catch (error) {
    return { ...resultBase, status: "degraded", error: error instanceof Error ? error.message : String(error) };
  }
}
