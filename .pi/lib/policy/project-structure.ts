import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { pathWithinRoot, resolvePathForCheck } from "../tools/path-guard.ts";

export type ProjectTier = "demo" | "product" | "platform";
export type NamingStyle = "kebab-case" | "snake_case" | "off";
export type Enforcement = "block" | "advisory";

export const PROJECT_TIERS: readonly ProjectTier[] = ["demo", "product", "platform"];
export const STRUCTURE_POLICY_RELPATH = ".project/structure.json";

export interface StructurePolicy {
  version: 1;
  tier: ProjectTier;
  enforcement: Enforcement;
  /** Exact file names permitted at the project root. Everything else must live in a directory. */
  rootFiles: string[];
  /** Exact directory names permitted at the project root. */
  rootDirs: string[];
  /** Segment patterns that are never allowed anywhere. `*` is the only wildcard. */
  forbidden: string[];
  naming: { style: NamingStyle; exempt: string[] };
}

/** Names whose capitalisation is contractual, so they are never naming violations. */
const DEFAULT_NAMING_EXEMPT = [
  "AGENTS.md", "CHANGELOG.md", "CLAUDE.md", "CODEOWNERS", "CONTRIBUTING.md", "Dockerfile",
  "LICENSE", "Makefile", "README.md", "SECURITY.md", "SKILL.md",
];

const DEFAULT_FORBIDDEN = [
  "*.bak", "*.orig", "*.rej", "*.swp", "*.tmp", "*~", ".DS_Store", "Thumbs.db",
  "copy-of-*", "new-file*", "temp", "tmp", "untitled*",
];

const BASE_ROOT_FILES = [".editorconfig", ".gitignore", "README.md"];
const BASE_ROOT_DIRS = [".git", ".project", "docs", "src", "tests"];

const TIER_ROOT_FILES: Record<ProjectTier, string[]> = {
  demo: [],
  product: ["AGENTS.md", "CHANGELOG.md", "LICENSE", ".env.example"],
  platform: ["AGENTS.md", "CHANGELOG.md", "LICENSE", ".env.example", "CONTRIBUTING.md", "SECURITY.md"],
};

const TIER_ROOT_DIRS: Record<ProjectTier, string[]> = {
  demo: [],
  product: ["scripts"],
  platform: ["scripts", "infra", "knowledge", ".github"],
};

const sorted = (values: Iterable<string>) => [...new Set(values)].sort();

export function defaultPolicy(tier: ProjectTier, options: { enforcement?: Enforcement; naming?: NamingStyle; extraRootFiles?: readonly string[]; extraRootDirs?: readonly string[] } = {}): StructurePolicy {
  return {
    version: 1,
    tier,
    enforcement: options.enforcement ?? "block",
    rootFiles: sorted([...BASE_ROOT_FILES, ...TIER_ROOT_FILES[tier], ...(options.extraRootFiles ?? [])]),
    rootDirs: sorted([...BASE_ROOT_DIRS, ...TIER_ROOT_DIRS[tier], ...(options.extraRootDirs ?? [])]),
    forbidden: sorted(DEFAULT_FORBIDDEN),
    naming: { style: options.naming ?? "kebab-case", exempt: sorted(DEFAULT_NAMING_EXEMPT) },
  };
}

/** Stable serialisation: fixed key order, sorted arrays, trailing newline. Repeat runs are byte-identical. */
export function serializePolicy(policy: StructurePolicy): string {
  const ordered = {
    version: 1,
    tier: policy.tier,
    enforcement: policy.enforcement,
    rootFiles: sorted(policy.rootFiles),
    rootDirs: sorted(policy.rootDirs),
    forbidden: sorted(policy.forbidden),
    naming: { style: policy.naming.style, exempt: sorted(policy.naming.exempt) },
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

const isTier = (value: unknown): value is ProjectTier => PROJECT_TIERS.includes(value as ProjectTier);
const stringList = (value: unknown): string[] => Array.isArray(value) ? sorted(value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)) : [];

/** Returns undefined when no policy is present; a malformed file is reported and treated as absent. */
export function loadPolicy(root: string, onWarning?: (message: string) => void): StructurePolicy | undefined {
  const path = join(root, STRUCTURE_POLICY_RELPATH);
  if (!existsSync(path)) return undefined;
  let raw: any;
  try { raw = JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { onWarning?.(`${STRUCTURE_POLICY_RELPATH} is not valid JSON; structure guard is inactive: ${error instanceof Error ? error.message : String(error)}`); return undefined; }
  if (!raw || typeof raw !== "object" || !isTier(raw.tier)) { onWarning?.(`${STRUCTURE_POLICY_RELPATH} is missing a valid "tier"; structure guard is inactive.`); return undefined; }
  const fallback = defaultPolicy(raw.tier);
  const naming = raw.naming && typeof raw.naming === "object" ? raw.naming : {};
  const style: NamingStyle = naming.style === "snake_case" || naming.style === "off" ? naming.style : "kebab-case";
  return {
    version: 1,
    tier: raw.tier,
    enforcement: raw.enforcement === "advisory" ? "advisory" : "block",
    rootFiles: stringList(raw.rootFiles).length ? stringList(raw.rootFiles) : fallback.rootFiles,
    rootDirs: stringList(raw.rootDirs).length ? stringList(raw.rootDirs) : fallback.rootDirs,
    forbidden: stringList(raw.forbidden),
    naming: { style, exempt: stringList(naming.exempt) },
  };
}

export function savePolicy(root: string, policy: StructurePolicy): void {
  writeFileAtomic(join(root, STRUCTURE_POLICY_RELPATH), serializePolicy(policy));
}

/** Write through a sibling temp file so an interrupted write never leaves a half-written artifact. */
export function writeFileAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  try { writeFileSync(temp, content, { encoding: "utf8", mode: 0o644 }); renameSync(temp, path); }
  catch (error) { try { rmSync(temp, { force: true }); } catch { /* preserve the original error */ } throw error; }
}

/** Full-segment match supporting `*` only; no path separators are consumed. */
function segmentMatches(pattern: string, segment: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*");
  return new RegExp(`^${escaped}$`).test(segment);
}

const NAMING_PATTERN: Record<Exclude<NamingStyle, "off">, RegExp> = {
  "kebab-case": /^[a-z0-9]+(?:[-.][a-z0-9]+)*$/,
  snake_case: /^[a-z0-9]+(?:[_.][a-z0-9]+)*$/,
};

function namingViolation(policy: StructurePolicy, segment: string): boolean {
  if (policy.naming.style === "off") return false;
  if (policy.naming.exempt.includes(segment)) return false;
  if (segment.startsWith(".")) return false; // dotfiles carry tool-defined names
  return !NAMING_PATTERN[policy.naming.style].test(segment);
}

export interface StructureViolation { rule: "forbidden" | "root-file" | "root-dir" | "naming"; path: string; segment: string; message: string; }

/**
 * Classify a path that is about to be **created**. Existing paths are never
 * violations: the guard governs new pollution, not edits to what is already
 * there, which keeps legitimate maintenance of legacy files unblocked.
 */
export function classifyCreation(root: string, policy: StructurePolicy, targetPath: string, exists: (path: string) => boolean = existsSync): StructureViolation | undefined {
  let absolute: string;
  try { absolute = resolvePathForCheck(resolve(root, targetPath)); } catch { return undefined; }
  const resolvedRoot = resolvePathForCheck(root);
  if (!pathWithinRoot(resolvedRoot, absolute) || absolute === resolvedRoot) return undefined; // outside the project: other guards own it
  const rel = relative(resolvedRoot, absolute);
  const segments = rel.split(sep).filter(Boolean);
  if (!segments.length) return undefined;
  if (exists(absolute)) return undefined;

  for (const segment of segments) {
    const pattern = policy.forbidden.find(entry => segmentMatches(entry, segment));
    if (pattern) return { rule: "forbidden", path: rel, segment, message: `"${segment}" matches the forbidden pattern "${pattern}".` };
  }

  const [head, ...restOfPath] = segments;
  const headIsDirectory = restOfPath.length > 0;
  if (headIsDirectory && !policy.rootDirs.includes(head)) {
    return { rule: "root-dir", path: rel, segment: head, message: `"${head}/" is not a permitted root directory. Allowed: ${policy.rootDirs.join(", ")}.` };
  }
  // A bare segment (`mkdir src`) names either a file or a directory; permit it
  // when either allowlist covers it, otherwise `mkdir src` would be blocked
  // even though `src/` is a permitted root directory.
  if (!headIsDirectory && !policy.rootFiles.includes(head) && !policy.rootDirs.includes(head)) {
    return { rule: "root-file", path: rel, segment: head, message: `"${head}" is not a permitted root file. Allowed: ${policy.rootFiles.join(", ")}.` };
  }

  // The root segment is allow-listed verbatim; naming applies to what is created beneath it.
  for (const segment of restOfPath) {
    if (namingViolation(policy, segment)) {
      return { rule: "naming", path: rel, segment, message: `"${segment}" is not ${policy.naming.style}.` };
    }
  }
  return undefined;
}

export function violationReason(violation: StructureViolation, policyPath = STRUCTURE_POLICY_RELPATH): string {
  return [
    `Blocked by project structure policy: ${violation.message}`,
    `Path: ${violation.path}`,
    `Fix the path, or record the exception in ${policyPath} (rule: ${violation.rule}) and retry.`,
  ].join("\n");
}

/** `PI_SWARM_NO_STRUCTURE_GUARD=1` mirrors the existing `PI_SWARM_NO_HOOKS` escape hatch. */
export const structureGuardDisabledByEnv = (env: NodeJS.ProcessEnv = process.env) => /^(1|true|yes)$/i.test((env.PI_SWARM_NO_STRUCTURE_GUARD ?? "").trim());

export const policyExists = (root: string) => existsSync(join(root, STRUCTURE_POLICY_RELPATH));
export const projectNameFrom = (root: string) => basename(resolve(root));
